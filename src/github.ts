import { ServiceError } from "./errors.ts";
import {
  analyzeBytes,
  decodeBase64,
  encodeBase64,
  encodeUtf8Strict,
  gitBlobSha,
  type TextAnalysis,
} from "./encoding.ts";
import type { ObservationContext } from "./observation.ts";
import type { FetchLike } from "./types.ts";

const API_ROOT = "https://api.github.com";
export interface RepositoryBinding {
  readonly owner: string;
  readonly repo: string;
}

export const MAX_FILE_BYTES = 1_310_720;
export const MAX_DIRECTORY_ENTRIES = 1_000;
export const MAX_TREE_ENTRIES = 5_000;
export const MAX_INDEX_QUERY_CHARS = 256;
export const DEFAULT_INDEX_RESULTS = 30;
export const MAX_INDEX_RESULTS = 100;
export const MAX_COMMIT_FILES = 1_000;
const COMMIT_FILES_PER_PAGE = 100;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GITHUB_CONCURRENCY = 5;
const MAX_WRITE_TOTAL_BYTES = 262_144;

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface ContentsEntry {
  type?: string;
  path?: string;
  sha?: string;
  size?: number;
  encoding?: string;
  content?: string;
  target?: string;
  submodule_git_url?: string;
}

interface BlobResponse {
  sha?: string;
  size?: number;
  encoding?: string;
  content?: string;
  truncated?: boolean;
}

interface RefResponse {
  ref?: string;
  object?: { sha?: string };
}

interface CommitResponse {
  sha?: string;
  tree?: { sha?: string };
}

interface TreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface TreeResponse {
  sha?: string;
  truncated?: boolean;
  tree?: TreeEntry[];
}

interface CreatedObject {
  sha?: string;
}

export interface GitHubFile {
  path: string;
  commitSha: string;
  blobSha: string;
  bytes: Uint8Array;
  analysis: TextAnalysis;
  isSymlink: false;
  isSubmodule: false;
}

type GitHubListingEntry =
  | { path: string; type: "directory" | "symlink" | "submodule" }
  | { path: string; type: "file"; blob_sha: string; byte_length: number };

export type GitHubDirectoryEntry = GitHubListingEntry & { name: string };
export type GitHubTreeEntry = GitHubListingEntry & { depth: number };

// Both listing tools expose the same modes; special entries are never dereferenced.
function listingEntry(entry: TreeEntry, path: string): GitHubListingEntry {
  if (entry.type === "tree" && entry.mode === "040000") return { path, type: "directory" };
  if (entry.type === "blob" && entry.mode === "120000") return { path, type: "symlink" };
  if (entry.type === "commit" && entry.mode === "160000") return { path, type: "submodule" };
  if (
    entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") ||
    !Number.isSafeInteger(entry.size) || entry.size! < 0
  ) {
    throw new ServiceError("GITHUB_TREE_RESPONSE_INVALID", "GitHub returned invalid entry metadata.", 502);
  }
  return { path, type: "file", blob_sha: entry.sha!.toLowerCase(), byte_length: entry.size! };
}

function sortListing<T extends { path: string }>(entries: T[]): T[] {
  const encoded = entries.map((entry) => ({ entry, bytes: encodeUtf8Strict(entry.path) }));
  encoded.sort((a, b) => {
    for (let index = 0; index < Math.min(a.bytes.length, b.bytes.length); index++) {
      if (a.bytes[index] !== b.bytes[index]) return a.bytes[index] - b.bytes[index];
    }
    return a.bytes.length - b.bytes.length;
  });
  return encoded.map(({ entry }) => entry);
}

export interface GitHubIndexSearch {
  index_scope: "default_branch";
  anchored: false;
  verification_required: true;
  total_count: number;
  incomplete_results: boolean;
  has_more: boolean;
  items: Array<{ path: string; indexed_blob_sha: string }>;
}

interface IndexSearchResponse {
  total_count?: unknown;
  incomplete_results?: unknown;
  items?: Array<{ path?: unknown; sha?: unknown; repository?: { full_name?: unknown } }>;
}

export function validateIndexQuery(value: unknown): string {
  const invalid = () => new ServiceError(
    "INDEX_QUERY_INVALID",
    `query must be nonblank, valid single-line Unicode of at most ${MAX_INDEX_QUERY_CHARS} characters, with balanced quotes and no repo/user/org scope qualifiers.`,
  );
  if (
    typeof value !== "string" || value.trim().length === 0 ||
    [...value].length > MAX_INDEX_QUERY_CHARS ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ||
    /\b(?:repo|user|org)\s*:/i.test(value)
  ) throw invalid();
  try { encodeUtf8Strict(value); } catch { throw invalid(); }
  // An unclosed quote or trailing escape must not consume the server's repo qualifier.
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  if (quoted || escaped) throw invalid();
  return value;
}

function indexSearchError(response: Response, payload: unknown): ServiceError | undefined {
  const body = payload && typeof payload === "object"
    ? payload as { message?: unknown; errors?: Array<{ message?: unknown }> } : {};
  const messages = [body.message, ...(Array.isArray(body.errors) ? body.errors.map((error) => error?.message) : [])]
    .filter((value): value is string => typeof value === "string").map((value) => value.slice(0, 1024)).join(" ");
  if (
    response.status === 429 || ([403, 422].includes(response.status) && (
      response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after") ||
      /rate limit|abuse|spammed/i.test(messages)
    ))
  ) {
    const retry = response.headers.get("retry-after");
    const reset = response.headers.get("x-ratelimit-reset");
    const timing = [
      retry && /^\d{1,12}$/.test(retry) ? `retry_after_seconds=${retry}` : "",
      reset && /^\d{1,12}$/.test(reset) ? `reset_at_unix_seconds=${reset}` : "",
    ].filter(Boolean).join("; ");
    return new ServiceError("INDEX_SEARCH_RATE_LIMITED",
      `GitHub code search is rate limited. Wait before retrying; no automatic retry was made.${timing ? ` ${timing}.` : ""}`, 503);
  }
  if (response.status === 403 || response.status === 404 || (response.status === 422 &&
    /cannot be searched|not have permission|permission.*(?:denied|required)|(?:not|isn't) accessible|not supported|unsupported.*(?:token|authentication)/i.test(messages))) {
    return new ServiceError("INDEX_SEARCH_UNSUPPORTED",
      "The configured credential cannot use code index search for this repository binding. Verify this binding's search access before retrying.", 403);
  }
  if (response.status === 400 || response.status === 422) {
    return new ServiceError("INDEX_QUERY_INVALID", "GitHub rejected the code search query syntax or qualifiers.");
  }
  return undefined;
}

export interface GitHubCommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  previous_path?: string;
}

export interface GitHubCommitMetadata {
  commit_sha: string;
  parent_shas: string[];
  author_date: string;
  committer_date: string;
  files: GitHubCommitFile[];
}

interface CommitMetadataResponse {
  sha?: unknown;
  parents?: Array<{ sha?: unknown }>;
  commit?: { author?: { date?: unknown }; committer?: { date?: unknown }; tree?: { sha?: unknown } };
  stats?: { additions?: unknown; deletions?: unknown };
  files?: Array<{ filename?: unknown; status?: unknown; additions?: unknown; deletions?: unknown; previous_filename?: unknown }>;
}

export interface WriteInput {
  path: string;
  content: string;
}

export interface WriteVerification {
  path: string;
  blob_sha: string | null;
  byte_length: number | null;
  verified: boolean;
  error?: string;
}

export interface WriteResult {
  service_version: string;
  committed: true;
  before_head: string;
  after_head: string;
  commit_sha: string;
  files: WriteVerification[];
  deletions?: Array<{ path: string; verified: boolean; error?: string }>;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function upstreamMessageForClassification(value: unknown): string {
  if (typeof value !== "string") return "GitHub returned an error.";
  return value.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function thrownErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrown";
  const safeNames = new Set([
    "AbortError",
    "Error",
    "NetworkError",
    "RangeError",
    "SyntaxError",
    "TimeoutError",
    "TypeError",
  ]);
  return safeNames.has(error.name) ? error.name : "Error";
}

function fetchInvocationFailure(error: unknown): ServiceError {
  const name = thrownErrorName(error);
  return new ServiceError(
    "GITHUB_FETCH_INVOCATION_ERROR",
    `GitHub fetch threw synchronously during invocation (${name}).`,
    502,
  );
}

function fetchRejection(error: unknown): ServiceError {
  const name = thrownErrorName(error);
  if (name === "AbortError") {
    return new ServiceError(
      "GITHUB_FETCH_ABORTED",
      "GitHub fetch was aborted with AbortError.",
      502,
    );
  }
  if (name === "TimeoutError") {
    return new ServiceError(
      "GITHUB_FETCH_TIMEOUT",
      "GitHub fetch timed out with TimeoutError.",
      504,
    );
  }
  return new ServiceError(
    "GITHUB_NETWORK_ERROR",
    `GitHub upstream request failed with ${name}.`,
    502,
  );
}

export function validateCommitSha(value: unknown, field = "commit_sha"): string {
  if (typeof value === "string" && /^[0-9a-fA-F]{1,39}$/.test(value)) {
    throw new ServiceError(
      "SHORT_COMMIT_SHA",
      `${field} must not use an abbreviated commit SHA; provide all 40 hexadecimal characters.`,
    );
  }
  if (
    typeof value === "string" &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !/^[0-9a-fA-F]{40}$/.test(value)
  ) {
    throw new ServiceError(
      "REF_NAME_NOT_ALLOWED",
      `${field} does not accept a branch or tag name; provide an immutable 40-hex commit SHA.`,
    );
  }
  if (typeof value !== "string" || !/^[0-9a-fA-F]{40}$/.test(value)) {
    throw new ServiceError(
      "INVALID_COMMIT_SHA",
      `${field} must be a complete 40-character hexadecimal commit SHA.`,
    );
  }
  return value.toLowerCase();
}

// A bare name has no slash; hierarchical names require an explicit namespace.
// Surrogate pairs are allowed, but lone surrogates cannot be URL-encoded.
const REF_SEGMENT_PATTERN =
  String.raw`(?!\.)(?![^/]*\.lock(?:/|$))(?:[^/\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+`;
export const RESOLVE_REF_PATTERN =
  String.raw`^(?!@$)(?!.*(?:\.\.|@\{))(?!.*\.$)(?![\s\S]*[\u0000-\u0020\u007f-\u009f\u2028\u2029~^:?*\[\\])(?:${REF_SEGMENT_PATTERN}|refs/(?:heads|tags)/${REF_SEGMENT_PATTERN}(?:/${REF_SEGMENT_PATTERN})*)$`;
const RESOLVE_REF_REGEXP = new RegExp(RESOLVE_REF_PATTERN);

export function validateRef(value: unknown = "main"): string {
  if (typeof value !== "string" || !RESOLVE_REF_REGEXP.test(value)) {
    throw new ServiceError(
      "INVALID_REF",
      "ref must be a bare single-segment name or a valid refs/heads/ or refs/tags/ name; repository paths and revision expressions are not allowed.",
    );
  }
  return value;
}

export function validatePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new ServiceError("INVALID_PATH", "path must be a non-empty string.");
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ServiceError(
      "INVALID_PATH",
      "path must be a control-free, single-line relative repository file path without empty, dot, or parent segments.",
    );
  }
  return value;
}

export function validateBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    throw new ServiceError("INVALID_BRANCH", "branch is not a valid branch name.");
  }
  return value;
}

export class GitHubClient {
  private readonly token: string;
  private readonly fetcher: FetchLike;
  private readonly serviceVersion: string;
  private readonly observation: ObservationContext;
  private readonly binding: RepositoryBinding;

  constructor(
    token: string,
    fetcher: FetchLike,
    serviceVersion: string,
    observation: ObservationContext,
    binding: RepositoryBinding,
  ) {
    this.token = token;
    this.fetcher = fetcher;
    this.serviceVersion = serviceVersion;
    this.observation = observation;
    this.binding = { ...binding };
    if (!token) {
      throw new ServiceError(
        "GITHUB_SECRET_MISSING",
        "The GitHub credential is not configured.",
        503,
      );
    }
  }

  private async requestJson<T>(
    apiPath: string,
    init: RequestInit = {},
    notFoundCode = "PATH_NOT_FOUND",
    conflictCode = "GITHUB_CONFLICT",
    observeHeaders?: (headers: Headers, status: number) => void,
    classifyError?: (response: Response, payload: unknown) => ServiceError | undefined,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) {
      headers.set("accept", "application/vnd.github+json");
    }
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("x-github-api-version", "2022-11-28");
    headers.set("user-agent", "github-text-mcp-worker/0.1");
    if (init.body !== undefined) headers.set("content-type", "application/json");

    let pendingResponse: Promise<Response>;
    this.observation.markGitHubFetchAttempted();
    try {
      // Keep credentials and operations at the explicitly bound GitHub endpoint.
      // A redirect can change the repository, host, or method; never follow it.
      pendingResponse = this.fetcher(`${API_ROOT}${apiPath}`, { ...init, headers, redirect: "manual" });
    } catch (error) {
      this.observation.markGitHubFetchOutcome("upstream_error");
      throw fetchInvocationFailure(error);
    }

    let response: Response;
    try {
      response = await pendingResponse;
    } catch (error) {
      this.observation.markGitHubFetchOutcome("upstream_error");
      throw fetchRejection(error);
    }
    this.observation.markGitHubFetchOutcome(
      response.status === 404
        ? "upstream_not_found"
        : response.ok
          ? "succeeded"
          : "upstream_error",
    );

    if (response.status >= 300 && response.status < 400) {
      throw new ServiceError(
        "GITHUB_REDIRECT_REFUSED",
        "GitHub returned a redirect; no redirected request was made. Verify the configured repository binding.",
        502,
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      this.observation.markGitHubFetchOutcome("upstream_error");
      throw new ServiceError(
        "GITHUB_RESPONSE_READ_ERROR",
        `The GitHub response body could not be read (${thrownErrorName(error)}).`,
        502,
      );
    }
    let payload: unknown = null;
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw);
      } catch {
        if (response.ok) {
          this.observation.markGitHubFetchOutcome("upstream_error");
          throw new ServiceError(
            "GITHUB_INVALID_JSON",
            "GitHub returned a non-JSON success response.",
            502,
          );
        }
      }
    }

    if (!response.ok) {
      const classified = classifyError?.(response, payload);
      if (classified) throw classified;
      const upstreamMessage = upstreamMessageForClassification(
        payload && typeof payload === "object" && "message" in payload
          ? (payload as { message?: unknown }).message
          : undefined,
      );
      if (response.status === 401) {
        throw new ServiceError(
          "GITHUB_AUTH_FAILED",
          "GitHub rejected the configured credential.",
          502,
        );
      }
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after") ||
            /(?:secondary )?rate limit/i.test(upstreamMessage)));
      if (rateLimited) {
        throw new ServiceError(
          "GITHUB_QUOTA_EXCEEDED",
          "GitHub API quota is exhausted.",
          503,
        );
      }
      if (response.status === 403) {
        throw new ServiceError(
          "GITHUB_FORBIDDEN",
          "GitHub denied this repository operation.",
          502,
        );
      }
      if (response.status === 404) {
        throw new ServiceError(
          notFoundCode,
          "GitHub did not find the requested resource.",
          404,
        );
      }
      if (response.status === 409 || response.status === 422) {
        throw new ServiceError(
          conflictCode,
          `GitHub rejected the operation with HTTP ${response.status} conflict.`,
          409,
        );
      }
      throw new ServiceError(
        "GITHUB_UPSTREAM_ERROR",
        `GitHub returned HTTP ${response.status}.`,
        502,
      );
    }

    observeHeaders?.(response.headers, response.status);
    return payload as T;
  }

  async searchRepoIndex(queryValue: unknown, maxResults = DEFAULT_INDEX_RESULTS): Promise<GitHubIndexSearch> {
    const query = validateIndexQuery(queryValue);
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_INDEX_RESULTS) {
      throw new ServiceError("INVALID_MAX_RESULTS", `max_results must be an integer between 1 and ${MAX_INDEX_RESULTS}.`);
    }
    const repository = `${this.binding.owner}/${this.binding.repo}`;
    const parameters = new URLSearchParams({ q: `${query} repo:${repository}`, per_page: String(maxResults), page: "1" });
    const result = await this.requestJson<IndexSearchResponse | null>(
      `/search/code?${parameters}`, { method: "GET" }, "INDEX_SEARCH_UNSUPPORTED", "INDEX_QUERY_INVALID",
      undefined, indexSearchError,
    );
    const invalid = () => new ServiceError("INDEX_SEARCH_RESPONSE_INVALID", "GitHub returned invalid or cross-repository code index metadata.", 502);
    if (
      !result || !Number.isSafeInteger(result.total_count) || (result.total_count as number) < 0 ||
      typeof result.incomplete_results !== "boolean" || !Array.isArray(result.items) ||
      result.items.length > maxResults || result.items.length > (result.total_count as number)
    ) throw invalid();
    const paths = new Set<string>();
    const items = result.items.map((item) => {
      if (
        typeof item?.repository?.full_name !== "string" || item.repository.full_name.toLowerCase() !== repository.toLowerCase() ||
        typeof item.sha !== "string" || !/^[0-9a-fA-F]{40}$/.test(item.sha)
      ) throw invalid();
      let path: string;
      try { path = validatePath(item.path); encodeUtf8Strict(path); } catch { throw invalid(); }
      if (paths.has(path)) throw invalid();
      paths.add(path);
      return { path, indexed_blob_sha: item.sha.toLowerCase() };
    });
    return {
      index_scope: "default_branch", anchored: false, verification_required: true,
      total_count: result.total_count as number, incomplete_results: result.incomplete_results,
      has_more: (result.total_count as number) > items.length, items,
    };
  }

  async getCommitMetadata(commitValue: unknown): Promise<GitHubCommitMetadata> {
    const commitSha = validateCommitSha(commitValue);
    const apiPath = `/repos/${this.binding.owner}/${this.binding.repo}/commits/${commitSha}`;
    const invalid = () => new ServiceError("GITHUB_COMMIT_RESPONSE_INVALID", "GitHub returned invalid commit metadata.", 502);
    const incomplete = () => new ServiceError("COMMIT_FILES_INCOMPLETE", "GitHub did not provide a complete, consistent commit file listing.", 502);
    const unavailable = () => new ServiceError("COMMIT_FILES_UNAVAILABLE", "GitHub did not provide file data that can establish this commit's changes.", 502);
    const limit = () => new ServiceError("COMMIT_OUTPUT_LIMIT", `Commit metadata may contain at most ${MAX_COMMIT_FILES} files.`, 413);
    const sha = (value: unknown): string => {
      if (typeof value !== "string" || value.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(value)) throw invalid();
      return value.toLowerCase();
    };
    const count = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
      return value;
    };
    const date = (value: unknown): string => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid();
      return value;
    };
    const path = (value: unknown): string => {
      try {
        const result = validatePath(value);
        encodeUtf8Strict(result);
        return result;
      } catch { throw invalid(); }
    };
    let identity: { parent_shas: string[]; author_date: string; committer_date: string; tree_sha: string; additions: number; deletions: number } | undefined;
    let lastPage: number | undefined;
    const files: GitHubCommitFile[] = [];
    const paths = new Set<string>();
    for (let page = 1; ; page++) {
      let link: string | null = null;
      const response = await this.requestJson<CommitMetadataResponse | null>(
        `${apiPath}?per_page=${COMMIT_FILES_PER_PAGE}&page=${page}`,
        { method: "GET" }, "COMMIT_NOT_FOUND", "GITHUB_CONFLICT",
        (headers) => { link = headers.get("link"); },
      );
      if (!response || sha(response.sha) !== commitSha || !Array.isArray(response.parents)) throw invalid();
      const current = {
        parent_shas: response.parents.map((parent) => sha(parent?.sha)),
        author_date: date(response.commit?.author?.date),
        committer_date: date(response.commit?.committer?.date),
        tree_sha: sha(response.commit?.tree?.sha),
        additions: count(response.stats?.additions),
        deletions: count(response.stats?.deletions),
      };
      if (identity && JSON.stringify(identity) !== JSON.stringify(current)) throw incomplete();
      identity = current;
      if (!Array.isArray(response.files)) throw unavailable();
      const relations = new Map<string, number>();
      if (link !== null) {
        for (const part of String(link).split(",")) {
          const match = /^\s*<([^>]+)>;\s*rel="(next|last|prev|first)"\s*$/.exec(part);
          if (!match || relations.has(match[2])) throw incomplete();
          let url: URL;
          try { url = new URL(match[1]); } catch { throw incomplete(); }
          // GitHub may canonicalize Link URLs to /repositories/{numeric-id}.
          // Inspect pagination only; every request is rebuilt from this.binding.
          const numericPath = new RegExp(`^/repositories/[0-9]+/commits/${commitSha}$`);
          if (url.origin !== API_ROOT || url.username || url.password || url.hash ||
              (url.pathname !== apiPath && !numericPath.test(url.pathname)) ||
              url.searchParams.get("per_page") !== String(COMMIT_FILES_PER_PAGE) ||
              [...url.searchParams.keys()].sort().join(",") !== "page,per_page") throw incomplete();
          const target = Number(url.searchParams.get("page"));
          if (!Number.isSafeInteger(target) || target < 1) throw incomplete();
          relations.set(match[2], target);
        }
      }
      const next = relations.get("next");
      const last = relations.get("last");
      if (last !== undefined) {
        if (last < page || (lastPage !== undefined && lastPage !== last)) throw incomplete();
        lastPage = last;
      }
      if ((next !== undefined && next !== page + 1) ||
          (relations.has("prev") && relations.get("prev") !== page - 1) ||
          (relations.has("first") && relations.get("first") !== 1) ||
          (lastPage !== undefined && ((page < lastPage) !== (next !== undefined)))) throw incomplete();
      if (response.files.length > COMMIT_FILES_PER_PAGE ||
          (next !== undefined && response.files.length !== COMMIT_FILES_PER_PAGE) ||
          (page > 1 && response.files.length === 0)) throw incomplete();
      if (files.length + response.files.length > MAX_COMMIT_FILES ||
          (lastPage !== undefined && lastPage > MAX_COMMIT_FILES / COMMIT_FILES_PER_PAGE)) throw limit();
      for (const file of response.files) {
        const entryPath = path(file?.filename);
        if (paths.has(entryPath)) throw incomplete();
        if (typeof file.status !== "string" || !["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].includes(file.status)) throw invalid();
        const entry: GitHubCommitFile = {
          path: entryPath, status: file.status, additions: count(file.additions), deletions: count(file.deletions),
        };
        if (file.status === "renamed") entry.previous_path = path(file.previous_filename);
        paths.add(entryPath);
        files.push(entry);
      }
      if (next === undefined) break;
      if (files.length >= MAX_COMMIT_FILES) throw limit();
    }
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions) ||
        additions !== identity.additions || deletions !== identity.deletions) throw incomplete();
    if (files.length === 0) {
      let baseTree = EMPTY_TREE_SHA;
      if (identity.parent_shas.length > 0) {
        const firstParent = identity.parent_shas[0];
        const parent = await this.requestJson<CommitResponse | null>(
          `/repos/${this.binding.owner}/${this.binding.repo}/git/commits/${firstParent}`,
          { method: "GET" }, "COMMIT_NOT_FOUND",
        );
        if (!parent || sha(parent.sha) !== firstParent) throw invalid();
        baseTree = sha(parent.tree?.sha);
      }
      if (identity.tree_sha !== baseTree) throw unavailable();
    }
    const encoded = files.map((file) => ({ file, bytes: encodeUtf8Strict(file.path) }));
    encoded.sort((a, b) => {
      for (let index = 0; index < Math.min(a.bytes.length, b.bytes.length); index++) {
        if (a.bytes[index] !== b.bytes[index]) return a.bytes[index] - b.bytes[index];
      }
      return a.bytes.length - b.bytes.length;
    });
    return {
      commit_sha: commitSha, parent_shas: identity.parent_shas,
      author_date: identity.author_date, committer_date: identity.committer_date,
      files: encoded.map(({ file }) => file),
    };
  }

  async resolveRef(refValue: unknown = "main"): Promise<string> {
    const ref = validateRef(refValue);
    // The commits endpoint accepts heads/NAME and tags/NAME to disambiguate.
    const apiRef = ref.startsWith("refs/") ? ref.slice("refs/".length) : ref;
    const commit = await this.requestJson<CommitResponse | null>(
      `/repos/${this.binding.owner}/${this.binding.repo}/commits/${encodeURIComponent(apiRef)}`,
      { method: "GET" },
      "REF_NOT_FOUND",
    );
    if (
      typeof commit?.sha !== "string" ||
      commit.sha.length !== 40 ||
      !/^[0-9a-fA-F]{40}$/.test(commit.sha)
    ) {
      throw new ServiceError(
        "GITHUB_COMMIT_RESPONSE_INVALID",
        "GitHub returned a resolved ref without a full commit SHA.",
        502,
      );
    }
    return commit.sha.toLowerCase();
  }

  private async getDirectoryTree(
    treeSha: string,
    recursive = false,
    incompleteCode = "DIRECTORY_TREE_INCOMPLETE",
  ): Promise<TreeEntry[]> {
    const tree = await this.requestJson<TreeResponse | null>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/trees/${treeSha}${recursive ? "?recursive=1" : ""}`,
      { method: "GET" },
      "TREE_NOT_FOUND",
    );
    if (tree?.truncated === true) {
      throw new ServiceError(incompleteCode, "GitHub returned an incomplete tree; no listing is returned. Select a smaller path.", 502);
    }
    if (
      tree?.truncated !== false ||
      typeof tree.sha !== "string" || tree.sha.toLowerCase() !== treeSha ||
      !Array.isArray(tree.tree)
    ) {
      throw new ServiceError("GITHUB_TREE_RESPONSE_INVALID", "GitHub returned an invalid directory tree.", 502);
    }
    const names = new Set<string>();
    for (const entry of tree.tree) {
      try {
        if (
          typeof entry?.path !== "string" || (!recursive && entry.path.includes("/")) ||
          typeof entry.sha !== "string" || entry.sha.length !== 40 ||
          !/^[0-9a-fA-F]{40}$/.test(entry.sha) || names.has(entry.path)
        ) throw new Error("Invalid tree entry");
        validatePath(entry.path);
        encodeUtf8Strict(entry.path);
      } catch {
        throw new ServiceError("GITHUB_TREE_RESPONSE_INVALID", "GitHub returned an invalid directory entry.", 502);
      }
      names.add(entry.path!);
    }
    return tree.tree;
  }

  private async directoryTreeSha(
    path: string,
    commitSha: string,
    incompleteCode = "DIRECTORY_TREE_INCOMPLETE",
  ): Promise<string> {
    const commit = await this.requestJson<CommitResponse | null>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/commits/${commitSha}`,
      { method: "GET" },
      "COMMIT_NOT_FOUND",
    );
    const treeSha = commit?.tree?.sha;
    if (
      typeof commit?.sha !== "string" || commit.sha.toLowerCase() !== commitSha ||
      typeof treeSha !== "string" || treeSha.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(treeSha)
    ) {
      throw new ServiceError("GITHUB_COMMIT_RESPONSE_INVALID", "GitHub returned an invalid commit tree identity.", 502);
    }
    let currentSha = treeSha.toLowerCase();
    for (const segment of path === "" ? [] : path.split("/")) {
      const tree = await this.getDirectoryTree(currentSha, false, incompleteCode);
      const entry = tree.find((candidate) => candidate.path === segment);
      if (!entry) throw new ServiceError("PATH_NOT_FOUND", "GitHub did not find the requested resource.", 404);
      if (entry.mode === "120000") {
        throw new ServiceError("SYMLINK_NOT_SUPPORTED", "Directory traversal through symlinks is not supported.");
      }
      if (entry.type === "commit" || entry.mode === "160000") {
        throw new ServiceError("SUBMODULE_NOT_SUPPORTED", "Directory traversal through submodules is not supported.");
      }
      if (entry.type !== "tree" || entry.mode !== "040000") {
        throw new ServiceError("NOT_A_DIRECTORY", "The requested path is not a directory.");
      }
      currentSha = entry.sha!.toLowerCase();
    }
    return currentSha;
  }

  async listDirectory(pathValue: unknown, commitValue: unknown): Promise<GitHubDirectoryEntry[]> {
    const path = pathValue === undefined || pathValue === "" ? "" : validatePath(pathValue);
    const commitSha = validateCommitSha(commitValue);
    const tree = await this.getDirectoryTree(await this.directoryTreeSha(path, commitSha));
    if (tree.length > MAX_DIRECTORY_ENTRIES) {
      throw new ServiceError(
        "DIRECTORY_OUTPUT_LIMIT", `A directory listing may contain at most ${MAX_DIRECTORY_ENTRIES} entries.`, 413,
      );
    }
    return sortListing(tree.map((entry): GitHubDirectoryEntry => ({
      name: entry.path!,
      ...listingEntry(entry, path === "" ? entry.path! : `${path}/${entry.path}`),
    })));
  }

  async listTree(pathValue: unknown, commitValue: unknown, maxDepth?: number): Promise<GitHubTreeEntry[]> {
    const path = pathValue === undefined || pathValue === "" ? "" : validatePath(pathValue);
    const commitSha = validateCommitSha(commitValue);
    if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 1)) {
      throw new ServiceError("INVALID_MAX_DEPTH", "max_depth must be a positive integer.");
    }
    const treeSha = await this.directoryTreeSha(path, commitSha, "TREE_INCOMPLETE");
    const tree = await this.getDirectoryTree(treeSha, true, "TREE_INCOMPLETE");
    const byPath = new Map(tree.map((entry) => [entry.path!, entry]));
    const entries: GitHubTreeEntry[] = [];
    for (const entry of tree) {
      const relativePath = entry.path!;
      const slash = relativePath.lastIndexOf("/");
      if (slash !== -1) {
        const parent = byPath.get(relativePath.slice(0, slash));
        if (parent?.type !== "tree" || parent.mode !== "040000") {
          throw new ServiceError("GITHUB_TREE_RESPONSE_INVALID", "GitHub returned a tree entry without a directory parent.", 502);
        }
      }
      const projected = listingEntry(entry, path === "" ? relativePath : `${path}/${relativePath}`);
      const depth = relativePath.split("/").length;
      if (maxDepth !== undefined && depth > maxDepth) continue;
      if (entries.length === MAX_TREE_ENTRIES) {
        throw new ServiceError(
          "TREE_OUTPUT_LIMIT", `A tree listing may contain at most ${MAX_TREE_ENTRIES} entries; reduce path scope or max_depth.`, 413,
        );
      }
      entries.push({ ...projected, depth });
    }
    return sortListing(entries);
  }

  private async getBlobBytes(expectedSha: string): Promise<Uint8Array> {
    const blob = await this.requestJson<BlobResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/blobs/${expectedSha}`,
      {},
      "BLOB_NOT_FOUND",
    );
    if (
      blob.sha?.toLowerCase() !== expectedSha.toLowerCase() ||
      blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      blob.truncated === true
    ) {
      throw new ServiceError(
        "GITHUB_BLOB_RESPONSE_INVALID",
        "GitHub returned an incomplete or inconsistent blob response.",
        502,
      );
    }
    if (typeof blob.size === "number" && blob.size > MAX_FILE_BYTES) {
      throw new ServiceError(
        "FILE_SIZE_LIMIT",
        `Files larger than ${MAX_FILE_BYTES} bytes are rejected to stay within Worker CPU and memory limits.`,
        413,
      );
    }
    const bytes = decodeBase64(blob.content);
    if (typeof blob.size === "number" && blob.size !== bytes.byteLength) {
      throw new ServiceError(
        "GITHUB_SIZE_MISMATCH",
        "GitHub blob size does not match the delivered bytes.",
        502,
      );
    }
    const computed = await gitBlobSha(bytes);
    if (computed !== expectedSha.toLowerCase()) {
      throw new ServiceError(
        "BLOB_SHA_MISMATCH",
        "The delivered bytes do not match GitHub's blob SHA.",
        502,
      );
    }
    return bytes;
  }

  private async assertRegularBlobAtPath(
    path: string,
    commitSha: string,
  ): Promise<TreeEntry & { sha: string }> {
    const commit = await this.requestJson<CommitResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/commits/${commitSha}`,
      {},
      "COMMIT_NOT_FOUND",
    );
    const treeSha = commit.tree?.sha?.toLowerCase();
    if (!treeSha || !/^[0-9a-f]{40}$/.test(treeSha)) {
      throw new ServiceError(
        "GITHUB_COMMIT_RESPONSE_INVALID",
        "GitHub returned a commit without a full tree SHA.",
        502,
      );
    }
    const tree = await this.requestJson<TreeResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/trees/${treeSha}?recursive=1`,
      {},
      "TREE_NOT_FOUND",
    );
    if (tree.truncated || !Array.isArray(tree.tree)) {
      throw new ServiceError(
        "COMMIT_TREE_INCOMPLETE",
        "GitHub did not return a complete commit tree, so file type cannot be verified.",
        502,
      );
    }
    const entry = tree.tree.find((candidate) => candidate.path === path);
    if (!entry) {
      throw new ServiceError(
        "PATH_NOT_FOUND",
        "GitHub did not find the requested resource.",
        404,
      );
    }
    if (entry.type === "tree") {
      throw new ServiceError(
        "DIRECTORY_PATH",
        "The requested path is a directory, not a file.",
      );
    }
    if (entry.mode === "120000") {
      throw new ServiceError(
        "SYMLINK_NOT_SUPPORTED",
        "The requested path is a symlink, not an ordinary file.",
      );
    }
    if (entry.type === "commit" || entry.mode === "160000") {
      throw new ServiceError(
        "SUBMODULE_NOT_SUPPORTED",
        "The requested path is a submodule, not an ordinary file.",
      );
    }
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      typeof entry.sha !== "string"
    ) {
      throw new ServiceError(
        "NON_REGULAR_FILE",
        "The requested path is not an ordinary file.",
      );
    }
    return { ...entry, sha: entry.sha.toLowerCase() };
  }

  async getFile(pathValue: unknown, commitValue: unknown): Promise<GitHubFile> {
    const path = validatePath(pathValue);
    const commitSha = validateCommitSha(commitValue);
    const treeEntry = await this.assertRegularBlobAtPath(path, commitSha);
    const entry = await this.requestJson<ContentsEntry | ContentsEntry[]>(
      `/repos/${this.binding.owner}/${this.binding.repo}/contents/${encodePath(path)}?ref=${commitSha}`,
      { headers: { accept: "application/vnd.github.object+json" } },
      "PATH_NOT_FOUND",
    );
    if (Array.isArray(entry)) {
      throw new ServiceError(
        "DIRECTORY_PATH",
        "The requested path is a directory, not a file.",
      );
    }
    if (entry.type === "symlink" || typeof entry.target === "string") {
      throw new ServiceError(
        "SYMLINK_NOT_SUPPORTED",
        "The requested path is a symlink, not an ordinary file.",
      );
    }
    if (entry.type === "submodule" || typeof entry.submodule_git_url === "string") {
      throw new ServiceError(
        "SUBMODULE_NOT_SUPPORTED",
        "The requested path is a submodule, not an ordinary file.",
      );
    }
    if (entry.type !== "file" || typeof entry.sha !== "string") {
      throw new ServiceError(
        "NON_REGULAR_FILE",
        "The requested path is not an ordinary file.",
      );
    }
    if (typeof entry.size === "number" && entry.size > MAX_FILE_BYTES) {
      throw new ServiceError(
        "FILE_SIZE_LIMIT",
        `Files larger than ${MAX_FILE_BYTES} bytes are rejected to stay within Worker CPU and memory limits.`,
        413,
      );
    }

    const blobSha = entry.sha.toLowerCase();
    if (blobSha !== treeEntry.sha) {
      throw new ServiceError(
        "TREE_CONTENT_SHA_MISMATCH",
        "GitHub Contents and the immutable commit tree disagree on the blob SHA.",
        502,
      );
    }
    let bytes: Uint8Array;
    if (entry.encoding === "base64" && typeof entry.content === "string") {
      bytes = decodeBase64(entry.content);
      if (typeof entry.size === "number" && entry.size !== bytes.byteLength) {
        throw new ServiceError(
          "GITHUB_SIZE_MISMATCH",
          "GitHub content size does not match the delivered bytes.",
          502,
        );
      }
      const computed = await gitBlobSha(bytes);
      if (computed !== blobSha) {
        throw new ServiceError(
          "BLOB_SHA_MISMATCH",
          "The delivered bytes do not match GitHub's blob SHA.",
          502,
        );
      }
    } else {
      bytes = await this.getBlobBytes(blobSha);
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new ServiceError(
        "FILE_SIZE_LIMIT",
        `Files larger than ${MAX_FILE_BYTES} bytes are rejected to stay within Worker CPU and memory limits.`,
        413,
      );
    }

    return {
      path,
      commitSha,
      blobSha,
      bytes,
      analysis: analyzeBytes(bytes),
      isSymlink: false,
      isSubmodule: false,
    };
  }

  async createBranch(branchInput: unknown, fromCommitShaInput: unknown): Promise<{ branch: string; commit_sha: string }> {
    const branch = validateBranch(branchInput);
    const commitSha = validateCommitSha(fromCommitShaInput, "from_commit_sha");
    const refPath = `/repos/${this.binding.owner}/${this.binding.repo}/git/ref/heads/${encodeURIComponent(branch)}`;
    const branchExists = async (): Promise<boolean> => {
      try {
        await this.requestJson<RefResponse>(refPath, {}, "BRANCH_NOT_FOUND");
        return true;
      } catch (error) {
        if (error instanceof ServiceError && error.code === "BRANCH_NOT_FOUND") return false;
        throw error;
      }
    };
    const source = await this.requestJson<CommitResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/commits/${commitSha}`,
      {},
      "COMMIT_NOT_FOUND",
    );
    if (typeof source?.sha !== "string" || source.sha.toLowerCase() !== commitSha) {
      throw new ServiceError("GITHUB_COMMIT_RESPONSE_INVALID", "GitHub did not return the requested source commit.", 502);
    }
    let created: RefResponse;
    try {
      created = await this.requestJson<RefResponse>(
        `/repos/${this.binding.owner}/${this.binding.repo}/git/refs`,
        { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }) },
        "COMMIT_NOT_FOUND",
      );
    } catch (error) {
      // POST is create-only. Classify an existing ref after a conflict; never update or retry it.
      if (error instanceof ServiceError && error.code === "GITHUB_CONFLICT" && await branchExists()) {
        throw new ServiceError("BRANCH_ALREADY_EXISTS", "The branch already exists; it was not overwritten.", 409);
      }
      throw error;
    }
    if (created?.ref !== `refs/heads/${branch}` || typeof created.object?.sha !== "string" || created.object.sha.toLowerCase() !== commitSha) {
      throw new ServiceError("GITHUB_REF_RESPONSE_INVALID", "GitHub did not confirm the requested branch commit; creation was not retried.", 502);
    }
    return { branch, commit_sha: commitSha };
  }

  async deleteBranch(branchInput: unknown, expectedHeadShaInput: unknown): Promise<{ branch: string; deleted_commit_sha: string }> {
    const branch = validateBranch(branchInput);
    validateCommitSha(expectedHeadShaInput, "expected_head_sha");
    // This precondition is literal equality, unlike normalized immutable read inputs.
    const expectedHeadSha = expectedHeadShaInput as string;
    const repositoryPath = `/repos/${this.binding.owner}/${this.binding.repo}`;
    const repository = await this.requestJson<{ default_branch?: unknown }>(repositoryPath, {}, "REPOSITORY_NOT_FOUND");
    const defaultBranch = repository?.default_branch;
    if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
      throw new ServiceError("GITHUB_REPOSITORY_RESPONSE_INVALID", "GitHub did not identify the repository default branch.", 502);
    }
    if (branch === defaultBranch) {
      throw new ServiceError("DEFAULT_BRANCH_DELETE_FORBIDDEN", "The repository default branch cannot be deleted.", 409);
    }
    const readHead = async (name: string): Promise<string> => {
      const ref = await this.requestJson<RefResponse>(
        `${repositoryPath}/git/ref/heads/${encodeURIComponent(name)}`, {}, "BRANCH_NOT_FOUND",
      );
      if (ref?.ref !== `refs/heads/${name}` || typeof ref.object?.sha !== "string" || !/^[0-9a-fA-F]{40}$/.test(ref.object.sha)) {
        throw new ServiceError("GITHUB_REF_RESPONSE_INVALID", "GitHub did not return the requested branch head.", 502);
      }
      return ref.object.sha;
    };
    const requireExpectedHead = async (): Promise<string> => {
      const head = await readHead(branch);
      if (head !== expectedHeadSha) {
        throw new ServiceError("BRANCH_HEAD_MISMATCH", "The branch head does not match expected_head_sha; deletion was refused.", 409);
      }
      return head;
    };
    const head = await requireExpectedHead();
    const defaultHead = await readHead(defaultBranch);
    // BASE is the default tip, HEAD is the deletion candidate: behind means merged.
    const comparison = await this.requestJson<{
      status?: string;
      base_commit?: { sha?: string };
      merge_base_commit?: { sha?: string };
    }>(`${repositoryPath}/compare/${defaultHead}...${head}`, {}, "COMMIT_NOT_FOUND");
    if (comparison?.base_commit?.sha !== defaultHead || !["identical", "behind", "ahead", "diverged"].includes(comparison?.status ?? "")) {
      throw new ServiceError("GITHUB_COMPARE_RESPONSE_INVALID", "GitHub did not return a valid comparison for the requested commits.", 502);
    }
    if (comparison.status === "ahead" || comparison.status === "diverged") {
      throw new ServiceError("BRANCH_NOT_MERGED", "The branch head is not an ancestor of the default branch; deletion was refused.", 409);
    }
    if (comparison.merge_base_commit?.sha !== head || (comparison.status === "identical" && defaultHead !== head)) {
      throw new ServiceError("GITHUB_COMPARE_RESPONSE_INVALID", "GitHub did not confirm the branch head as a merged ancestor.", 502);
    }
    // Catch changes during the comparison. GitHub DELETE refs has no atomic SHA precondition,
    // so a concurrent update after this final read remains possible. Never retry the DELETE.
    await requireExpectedHead();
    await this.requestJson<null>(
      `${repositoryPath}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: "DELETE" }, "BRANCH_NOT_FOUND", "GITHUB_CONFLICT",
      (_headers, status) => {
        if (status !== 204) {
          throw new ServiceError("GITHUB_DELETE_RESPONSE_INVALID", "GitHub did not confirm branch deletion; deletion was not retried.", 502);
        }
      },
    );
    return { branch, deleted_commit_sha: head };
  }

  async writeFiles(options: {
    files: WriteInput[];
    deletions?: string[];
    message: string;
    branch: unknown;
    expectedParentSha?: unknown;
  }): Promise<WriteResult> {
    const branch = validateBranch(options.branch);
    if (
      typeof options.message !== "string" ||
      options.message.trim().length === 0 ||
      options.message.length > 500
    ) {
      throw new ServiceError(
        "INVALID_COMMIT_MESSAGE",
        "message must be a non-empty string of at most 500 characters.",
      );
    }
    const deletions = (options.deletions ?? []).map((path) => validatePath(path));
    const entryCount = options.files.length + deletions.length;
    if (entryCount === 0 || entryCount > 20) {
      throw new ServiceError(
        "INVALID_FILE_COUNT",
        "files and deletions must contain between 1 and 20 entries in total.",
      );
    }

    const paths = options.files.map((file) => validatePath(file.path));
    if (new Set(paths).size !== paths.length) {
      throw new ServiceError("DUPLICATE_PATH", "files contains duplicate paths.");
    }
    if (new Set(deletions).size !== deletions.length) {
      throw new ServiceError("DUPLICATE_PATH", "deletions contains duplicate paths.");
    }
    if (deletions.some((path) => paths.includes(path))) {
      throw new ServiceError("WRITE_DELETE_CONFLICT", "A path cannot occur in both files and deletions.");
    }
    const pathSet = new Set([...paths, ...deletions]);
    for (const path of pathSet) {
      for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
        const ancestor = path.slice(0, slash);
        if (pathSet.has(ancestor)) {
          throw new ServiceError(
            "NESTED_PATH_COLLISION",
            `files and deletions may not contain both ${JSON.stringify(ancestor)} and a descendant path.`,
          );
        }
      }
    }
    for (const file of options.files) {
      if (typeof file.content !== "string") {
        throw new ServiceError("INVALID_CONTENT", "Every file content must be a string.");
      }
    }
    const encodedInputs = options.files.map((file) => encodeUtf8Strict(file.content));
    const totalWriteBytes = encodedInputs.reduce(
      (total, bytes) => total + bytes.byteLength,
      0,
    );
    if (totalWriteBytes > MAX_WRITE_TOTAL_BYTES) {
      throw new ServiceError(
        "WRITE_SIZE_LIMIT",
        `The combined UTF-8 write payload may not exceed ${MAX_WRITE_TOTAL_BYTES} bytes.`,
        413,
      );
    }

    const refName = encodeURIComponent(branch);
    const ref = await this.requestJson<RefResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/ref/heads/${refName}`,
      {},
      "BRANCH_NOT_FOUND",
    );
    const beforeHead = ref.object?.sha?.toLowerCase();
    if (!beforeHead || !/^[0-9a-f]{40}$/.test(beforeHead)) {
      throw new ServiceError(
        "GITHUB_REF_RESPONSE_INVALID",
        "GitHub returned a branch ref without a full commit SHA.",
        502,
      );
    }

    if (options.expectedParentSha !== undefined) {
      const expected = validateCommitSha(
        options.expectedParentSha,
        "expected_parent_sha",
      );
      if (expected !== beforeHead) {
        throw new ServiceError(
          "EXPECTED_PARENT_MISMATCH",
          `Current branch head ${beforeHead} does not match expected_parent_sha ${expected}; no write was attempted.`,
          409,
        );
      }
    }

    const baseCommit = await this.requestJson<CommitResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/commits/${beforeHead}`,
      {},
      "COMMIT_NOT_FOUND",
    );
    const baseTreeSha = baseCommit.tree?.sha?.toLowerCase();
    if (!baseTreeSha || !/^[0-9a-f]{40}$/.test(baseTreeSha)) {
      throw new ServiceError(
        "GITHUB_COMMIT_RESPONSE_INVALID",
        "GitHub returned a commit without a full tree SHA.",
        502,
      );
    }

    const baseTree = await this.requestJson<TreeResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/trees/${baseTreeSha}?recursive=1`,
      {},
      "TREE_NOT_FOUND",
    );
    if (baseTree.truncated || !Array.isArray(baseTree.tree)) {
      throw new ServiceError(
        "BASE_TREE_INCOMPLETE",
        "GitHub did not return a complete base tree; the write was not attempted.",
        502,
      );
    }
    const baseEntries = new Map(
      baseTree.tree
        .filter((entry): entry is TreeEntry & { path: string } => typeof entry.path === "string")
        .map((entry) => [entry.path, entry]),
    );

    const deletionEntries = deletions.map((path) => {
      const entry = baseEntries.get(path);
      if (!entry) {
        throw new ServiceError("DELETE_PATH_NOT_FOUND", `Deletion target ${path} is absent from the base tree.`, 404);
      }
      const validMode = entry.type === "blob"
        ? ["100644", "100755", "120000"].includes(entry.mode ?? "")
        : entry.type === "tree" ? entry.mode === "040000"
        : entry.type === "commit" && entry.mode === "160000";
      if (!validMode || typeof entry.sha !== "string" || !/^[0-9a-fA-F]{40}$/.test(entry.sha)) {
        throw new ServiceError("BASE_TREE_INCOMPLETE", "The base tree lacks valid metadata for a deletion target; no write was attempted.", 502);
      }
      return { path, mode: entry.mode, type: entry.type, sha: null };
    });

    const prepared = await mapWithConcurrency(
      options.files,
      GITHUB_CONCURRENCY,
      async (file, index) => {
        const path = paths[index];
        const existing = baseEntries.get(path);
        if (existing?.type === "tree") {
          throw new ServiceError(
            "DIRECTORY_WRITE_TARGET",
            `Write target ${path} is an existing directory.`,
          );
        }
        if (existing?.type === "commit" || existing?.mode === "160000") {
          throw new ServiceError(
            "SUBMODULE_WRITE_TARGET",
            `Write target ${path} is an existing submodule.`,
          );
        }
        if (existing?.mode === "120000") {
          throw new ServiceError(
            "SYMLINK_WRITE_TARGET",
            `Write target ${path} is an existing symlink.`,
          );
        }
        for (let part = path.lastIndexOf("/"); part > 0; part = path.lastIndexOf("/", part - 1)) {
          const parent = baseEntries.get(path.slice(0, part));
          if (parent && parent.type !== "tree") {
            throw new ServiceError(
              "NON_DIRECTORY_PARENT",
              `A parent of ${path} is not a directory.`,
            );
          }
        }

        const bytes = encodedInputs[index];
        const expectedBlobSha = await gitBlobSha(bytes);
        const created = await this.requestJson<CreatedObject>(
          `/repos/${this.binding.owner}/${this.binding.repo}/git/blobs`,
          {
            method: "POST",
            body: JSON.stringify({ content: encodeBase64(bytes), encoding: "base64" }),
          },
        );
        const createdSha = created.sha?.toLowerCase();
        if (createdSha !== expectedBlobSha) {
          throw new ServiceError(
            "CREATED_BLOB_SHA_MISMATCH",
            `GitHub created an unexpected blob for ${path}; no ref update was attempted.`,
            502,
          );
        }
        return {
          path,
          bytes,
          blobSha: expectedBlobSha,
          mode: existing?.mode === "100755" ? "100755" : "100644",
        };
      },
    );

    const createdTree = await this.requestJson<CreatedObject>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: [...prepared.map((file) => ({
            path: file.path,
            mode: file.mode,
            type: "blob",
            sha: file.blobSha,
          })), ...deletionEntries],
        }),
      },
    );
    const createdTreeSha = createdTree.sha?.toLowerCase();
    if (!createdTreeSha || !/^[0-9a-f]{40}$/.test(createdTreeSha)) {
      throw new ServiceError(
        "CREATED_TREE_RESPONSE_INVALID",
        "GitHub did not return a full SHA for the created tree.",
        502,
      );
    }

    const createdCommit = await this.requestJson<CommitResponse>(
      `/repos/${this.binding.owner}/${this.binding.repo}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: options.message,
          tree: createdTreeSha,
          parents: [beforeHead],
        }),
      },
    );
    const afterHead = createdCommit.sha?.toLowerCase();
    if (!afterHead || !/^[0-9a-f]{40}$/.test(afterHead)) {
      throw new ServiceError(
        "CREATED_COMMIT_RESPONSE_INVALID",
        "GitHub did not return a full SHA for the created commit.",
        502,
      );
    }

    let reconcileRef = false;
    try {
      const updated = await this.requestJson<RefResponse>(
        `/repos/${this.binding.owner}/${this.binding.repo}/git/refs/heads/${refName}`,
        {
          method: "PATCH",
          body: JSON.stringify({ sha: afterHead, force: false }),
        },
        "BRANCH_NOT_FOUND",
        "REF_UPDATE_CONFLICT",
      );
      const reportedHead = (updated as RefResponse | null)?.object?.sha?.toLowerCase();
      reconcileRef = reportedHead !== afterHead;
    } catch (error) {
      const uncertain =
        !(error instanceof ServiceError) ||
        error.code === "GITHUB_FETCH_INVOCATION_ERROR" ||
        error.code === "GITHUB_FETCH_ABORTED" ||
        error.code === "GITHUB_FETCH_TIMEOUT" ||
        error.code === "GITHUB_NETWORK_ERROR" ||
        error.code === "GITHUB_UPSTREAM_ERROR" ||
        error.code === "GITHUB_RESPONSE_READ_ERROR" ||
        error.code === "GITHUB_INVALID_JSON";
      if (!uncertain) throw error;
      reconcileRef = true;
    }

    if (reconcileRef) {
      let observedHead: string;
      try {
        const observed = await this.requestJson<RefResponse>(
          `/repos/${this.binding.owner}/${this.binding.repo}/git/ref/heads/${refName}`,
          {},
          "BRANCH_NOT_FOUND",
        );
        observedHead = observed.object?.sha?.toLowerCase() ?? "";
      } catch {
        throw new ServiceError(
          "REF_UPDATE_OUTCOME_UNKNOWN",
          `The ref update outcome could not be reconciled. Candidate commit: ${afterHead}.`,
          503,
        );
      }
      if (observedHead === afterHead) {
        // The mutation committed despite an ambiguous response; continue.
      } else if (observedHead === beforeHead) {
        throw new ServiceError(
          "REF_UPDATE_NOT_APPLIED",
          `Reconciliation confirms the branch is still at ${beforeHead}.`,
          503,
        );
      } else {
        throw new ServiceError(
          "REF_UPDATE_OUTCOME_UNKNOWN",
          `The branch moved to an unexpected head; candidate commit: ${afterHead}.`,
          503,
        );
      }
    }

    const verifications: WriteVerification[] = [];
    let readbackError: string | undefined;
    let writtenTree: TreeResponse | null = null;
    try {
      const committed = await this.requestJson<CommitResponse>(
        `/repos/${this.binding.owner}/${this.binding.repo}/git/commits/${afterHead}`,
        {},
        "COMMIT_NOT_FOUND",
      );
      if (
        (typeof committed.sha === "string" && committed.sha.toLowerCase() !== afterHead) ||
        committed.tree?.sha?.toLowerCase() !== createdTreeSha
      ) {
        throw new ServiceError(
          "POSTCOMMIT_TREE_MISMATCH",
          "The committed object does not point to the tree created by this call.",
          502,
        );
      }
      writtenTree = await this.requestJson<TreeResponse>(
        `/repos/${this.binding.owner}/${this.binding.repo}/git/trees/${createdTreeSha}?recursive=1`,
        {},
        "TREE_NOT_FOUND",
      );
      if (writtenTree.truncated || !Array.isArray(writtenTree.tree)) {
        throw new ServiceError(
          "READBACK_TREE_INCOMPLETE",
          "GitHub did not return a complete post-commit tree.",
          502,
        );
      }
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : "READBACK_FAILED";
      readbackError = code;
      // Atomic write/delete receipts must not inspect a rejected readback tree.
      if (deletions.length > 0) writtenTree = null;
      for (const file of prepared) {
        verifications.push({
          path: file.path,
          blob_sha: null,
          byte_length: null,
          verified: false,
          error: code,
        });
      }
    }

    if (writtenTree) {
      const writtenEntries = new Map(
        (writtenTree.tree ?? [])
          .filter((entry): entry is TreeEntry & { path: string } => typeof entry.path === "string")
          .map((entry) => [entry.path, entry]),
      );
      const results = await mapWithConcurrency(
        prepared,
        GITHUB_CONCURRENCY,
        async (file): Promise<WriteVerification> => {
          const actualEntry = writtenEntries.get(file.path);
          const actualSha = actualEntry?.sha?.toLowerCase() ?? null;
          if (
            actualSha !== file.blobSha ||
            actualEntry?.type !== "blob" ||
            (actualEntry.mode !== "100644" && actualEntry.mode !== "100755")
          ) {
            return {
              path: file.path,
              blob_sha: actualSha,
              byte_length: null,
              verified: false,
              error: "READBACK_TREE_MISMATCH",
            };
          }
          try {
            const readback = await this.getBlobBytes(actualSha);
            return {
              path: file.path,
              blob_sha: actualSha,
              byte_length: readback.byteLength,
              verified:
                readback.byteLength === file.bytes.byteLength &&
                actualSha === file.blobSha,
            };
          } catch (error) {
            return {
              path: file.path,
              blob_sha: actualSha,
              byte_length: null,
              verified: false,
              error: error instanceof ServiceError ? error.code : "READBACK_FAILED",
            };
          }
        },
      );
      verifications.push(...results);
    }

    return {
      service_version: this.serviceVersion,
      committed: true,
      before_head: beforeHead,
      after_head: afterHead,
      commit_sha: afterHead,
      files: verifications,
      ...(deletions.length > 0 ? {
        deletions: deletions.map((path) => {
          const remains = writtenTree?.tree?.some((entry) => entry.path === path || entry.path?.startsWith(`${path}/`));
          const error = readbackError ?? (remains ? "READBACK_DELETE_MISMATCH" : undefined);
          return { path, verified: error === undefined, ...(error ? { error } : {}) };
        }),
      } : {}),
    };
  }
}
