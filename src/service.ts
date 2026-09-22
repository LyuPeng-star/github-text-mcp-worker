import { ServiceError } from "./errors.ts";
import {
  digestHex,
  lineByteRange,
  lineCountForChunk,
  randomNonce,
  requireUtf8,
  safeUtf8End,
} from "./encoding.ts";
import {
  GitHubClient,
  DEFAULT_INDEX_RESULTS,
  MAX_INDEX_QUERY_CHARS,
  MAX_INDEX_RESULTS,
  MAX_COMMIT_FILES,
  MAX_DIRECTORY_ENTRIES,
  MAX_TREE_ENTRIES,
  RESOLVE_REF_PATTERN,
  validateBranch,
  validateCommitSha,
  validateIndexQuery,
  validatePath,
  validateRef,
  type WriteInput,
} from "./github.ts";
import {
  type ObservationContext,
  observationTextLines,
} from "./observation.ts";
import type { ToolResult } from "./types.ts";

export const DEFAULT_MAX_BYTES = 65_536;
export const SHA256_MAX_BYTES = 262_144;
const MAX_MAX_BYTES = 1_048_576;
const MAX_SEARCH_BYTES = 262_144;
const MAX_SEARCH_OUTPUT_BYTES = 131_072;
export const MAX_DIRECTORY_OUTPUT_BYTES = 131_072;
export const MAX_TREE_OUTPUT_BYTES = 131_072;
export const MAX_INDEX_OUTPUT_BYTES = 131_072;
export const MAX_COMMIT_OUTPUT_BYTES = 131_072;

const TOOL_NAMES = new Set([
  "stat_file",
  "get_file_text",
  "search_in_file",
  "search_repo_index",
  "put_file_text",
  "put_files_text",
  "verify_write",
  "resolve_ref",
  "list_directory",
  "list_tree",
  "get_commit_metadata",
  "create_branch",
  "delete_branch",
]);

type RecordValue = Record<string, unknown>;

function objectArgs(value: unknown): RecordValue {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  return value as RecordValue;
}

function rejectUnknownProperties(
  args: RecordValue,
  allowed: readonly string[],
  context = "arguments",
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(args).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) {
    throw new ServiceError(
      "UNEXPECTED_ARGUMENT",
      `${context} contains unsupported property ${JSON.stringify(unexpected)}.`,
    );
  }
}

export function isKnownToolName(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAMES.has(value);
}

function integerArg(
  args: RecordValue,
  name: string,
  defaultValue?: number,
): number | undefined {
  const value = args[name];
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ServiceError("INVALID_INTEGER", `${name} must be an integer.`);
  }
  return value;
}

function booleanArg(
  args: RecordValue,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = args[name];
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new ServiceError("INVALID_BOOLEAN", `${name} must be a boolean.`);
  }
  return value;
}

function stringArg(
  args: RecordValue,
  name: string,
  options: { required?: boolean; defaultValue?: string } = {},
): string {
  const value = args[name];
  if (value === undefined && options.defaultValue !== undefined) {
    return options.defaultValue;
  }
  if (typeof value !== "string" || (options.required && value.length === 0)) {
    throw new ServiceError("INVALID_STRING", `${name} must be a string.`);
  }
  return value;
}

function textResult(text: string): ToolResult {
  if (text.length === 0) {
    throw new ServiceError(
      "EMPTY_SUCCESS_FORBIDDEN",
      "A successful tool response may not omit its text payload.",
      500,
    );
  }
  return { content: [{ type: "text", text }] };
}

function jsonTextResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function observedJsonTextResult<T extends object>(
  value: T,
  observation: ObservationContext,
): ToolResult {
  return jsonTextResult({ ...value, ...observation.snapshot() });
}

function delimiterFor(body: string): {
  begin: string;
  end: string;
  nonceLine?: string;
} {
  if (!body.includes("---END FILE---")) {
    return { begin: "---BEGIN FILE---", end: "---END FILE---" };
  }
  for (;;) {
    const nonce = randomNonce();
    const begin = `---BEGIN FILE ${nonce}---`;
    const end = `---END FILE ${nonce}---`;
    if (!body.includes(begin) && !body.includes(end)) {
      return { begin, end, nonceLine: `delimiter_nonce: ${nonce}` };
    }
  }
}

function toolDefinitions(): unknown[] {
  const immutableFileProperties = {
    path: {
      type: "string",
      pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$",
      description: "Exact single-line repository-relative path; Unicode normalization is preserved.",
    },
    commit_sha: {
      type: "string",
      pattern: "^[0-9a-fA-F]{40}$",
      description: "Complete immutable 40-hex commit SHA; branches, tags, and short SHAs are rejected.",
    },
  };

  return [
    {
      name: "create_branch",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        "Create a new branch in the bound repository at an immutable full commit SHA through the Git Refs API. An existing branch fails with BRANCH_ALREADY_EXISTS and is never overwritten. Returns branch and commit_sha. No ref expressions or force update.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["branch", "from_commit_sha"],
        properties: {
          branch: { type: "string", minLength: 1, maxLength: 200 },
          from_commit_sha: immutableFileProperties.commit_sha,
        },
      },
    },
    {
      name: "delete_branch",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        "Delete a merged non-default branch in the bound repository. Refuses the repository default branch (DEFAULT_BRANCH_DELETE_FORBIDDEN), a head that does not exactly equal expected_head_sha (BRANCH_HEAD_MISMATCH), or a head not ancestral to the default branch (BRANCH_NOT_MERGED). Compares default tip as base and branch head as head; only identical or behind is accepted. Rechecks the branch head immediately before DELETE. GitHub offers no atomic expected-SHA condition for deletion, so a concurrent update after the final read remains possible. Returns branch and deleted_commit_sha with diagnostics. Upstream 422 and 403 retain their conflict, forbidden, or quota error classification; deletion is never retried. No force or ancestry bypass.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["branch", "expected_head_sha"],
        properties: {
          branch: { type: "string", minLength: 1, maxLength: 200 },
          expected_head_sha: {
            type: "string",
            pattern: "^[0-9a-fA-F]{40}$",
            description: "Complete 40-hex branch head SHA; must match the observed head character for character, including letter case.",
          },
        },
      },
    },
    {
      name: "get_commit_metadata",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        `Get immutable commit metadata from the bound repository: commit_sha, parent_shas, author_date, committer_date, and files with path, status, additions and deletions (line counts); renamed files also have previous_path. No commit message or changes field. Files describe the diff against the first parent, including merge commits; root commits use the empty tree. Paths are sorted by UTF-8 bytes without Unicode normalization. Pagination must be complete or COMMIT_FILES_INCOMPLETE is returned. Missing file data, or an empty listing whose tree differs from the first parent/empty tree, returns COMMIT_FILES_UNAVAILABLE; a verified zero-change commit succeeds with files: []. More than ${MAX_COMMIT_FILES} files or ${MAX_COMMIT_OUTPUT_BYTES} UTF-8 bytes of serialized result text including diagnostics returns COMMIT_OUTPUT_LIMIT, never partial data.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commit_sha"],
        properties: { commit_sha: immutableFileProperties.commit_sha },
      },
    },
    {
      name: "search_repo_index",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        `Search the bound repository's GitHub code index with one upstream request. query is passed unchanged, with a server-added repo qualifier; repo/user/org scope qualifiers are forbidden. Returns only path and indexed_blob_sha, never matching text. index_scope is default_branch, anchored is false, and verification_required is true: the index is eventually consistent, cannot be pinned to a commit SHA, and results are at most thin evidence. To verify each hit at your chosen commit, use list_tree or stat_file for the same path and compare its blob SHA with indexed_blob_sha. If equal, that file's bytes match the indexed version and the hit is trustworthy at your commit. If different, the index is stale for that anchor: run search_in_file with the relevant literal term at your commit to search again. SHA equality verifies file bytes, not repository search completeness. max_results selects one page (default ${DEFAULT_INDEX_RESULTS}, maximum ${MAX_INDEX_RESULTS}); total_count, has_more, and incomplete_results expose omissions, and empty results never prove absence at an anchor. More than ${MAX_INDEX_OUTPUT_BYTES} UTF-8 bytes of serialized result text including diagnostics returns INDEX_SEARCH_OUTPUT_LIMIT without partial output. INDEX_SEARCH_RATE_LIMITED is distinct from INDEX_QUERY_INVALID and INDEX_SEARCH_UNSUPPORTED for unavailable binding access; no automatic retries or blob fetches are made.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: MAX_INDEX_QUERY_CHARS, description: "GitHub legacy code-search terms and qualifiers, preserved without Unicode normalization; omit repository/user/organization scope qualifiers." },
          max_results: { type: "integer", minimum: 1, maximum: MAX_INDEX_RESULTS, default: DEFAULT_INDEX_RESULTS },
        },
      },
    },
    {
      name: "list_tree",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        `Recursively list the bound repository at an immutable full commit SHA. path defaults to the repository root; only descendants of that directory are returned, with full repository-relative path, type, and depth (immediate children have depth 1 relative to path). max_depth is an optional positive integer; omitted means unlimited depth. Entries are sorted by full path UTF-8 bytes without Unicode normalization. Entry types are file, directory, symlink, and submodule; only files have blob_sha and byte_length. Symlinks and submodules are never traversed. GitHub truncated trees fail with TREE_INCOMPLETE, even with max_depth. More than ${MAX_TREE_ENTRIES} selected entries or ${MAX_TREE_OUTPUT_BYTES} UTF-8 bytes of serialized result text including diagnostics fails with TREE_OUTPUT_LIMIT. Neither error returns a partial list. Choose a smaller path to narrow the upstream subtree; use path or max_depth to stay within local output budgets.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commit_sha"],
        properties: {
          commit_sha: immutableFileProperties.commit_sha,
          path: {
            type: "string",
            default: "",
            pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]*$",
            description: "Exact repository-relative directory path, or empty string for the root; Unicode normalization is preserved.",
          },
          max_depth: { type: "integer", minimum: 1, description: "Maximum depth relative to path; omit to include all descendants. Reduce this to limit output." },
        },
      },
    },
    {
      name: "list_directory",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        `List one directory at an immutable full commit SHA in the bound repository. path defaults to the repository root (empty string). Entries are sorted by UTF-8 path bytes without Unicode normalization. File entries contain blob_sha and byte_length. No recursive listing. Entry types are file, directory, symlink, and submodule. Symlinks and submodules are returned without blob_sha or byte_length and are never traversed. More than ${MAX_DIRECTORY_ENTRIES} entries or ${MAX_DIRECTORY_OUTPUT_BYTES} UTF-8 bytes of serialized result text, including diagnostics, fails with DIRECTORY_OUTPUT_LIMIT instead of truncating.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commit_sha"],
        properties: {
          commit_sha: immutableFileProperties.commit_sha,
          path: {
            type: "string",
            default: "",
            pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]*$",
            description: "Exact repository-relative directory path, or empty string for the root; Unicode normalization is preserved.",
          },
        },
      },
    },
    {
      name: "resolve_ref",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Resolve a branch or tag in the bound repository to a complete immutable commit SHA. Defaults to main. Accepts a bare single-segment name or refs/heads/NAME and refs/tags/NAME with valid slash-separated segments. Other namespaces, repository paths, and revision expressions are rejected.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ref: {
            type: "string",
            minLength: 1,
            default: "main",
            pattern: RESOLVE_REF_PATTERN,
          },
        },
      },
    },
    {
      name: "stat_file",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Return integrity and text-shape metadata for one ordinary file at an immutable 40-hex commit SHA.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "commit_sha"],
        properties: immutableFileProperties,
      },
    },
    {
      name: "get_file_text",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Return strict UTF-8 file bytes inside one text content block. Line ranges are 1-based closed intervals and include each selected line's original LF or CRLF terminator when present. Byte offsets are zero-based; byte_limit is a maximum byte count and bytes:a-b denotes the actual delivered half-open interval [a,b). byte_offset equal to byte_length is a valid empty EOF read with or without an explicit positive byte_limit; only larger offsets are BYTE_RANGE_OUT_OF_BOUNDS. An explicit byte_limit must be at least 1. first_line_fingerprint and last_line_fingerprint always describe the entire file, not only the delivered chunk, including when an empty EOF chunk is returned. truncated means max_bytes reduced the requested selection; independently, has_more means later file bytes remain after the delivered chunk and next_byte_offset is their absolute continuation position. selection_end_byte_offset is the requested selection's effective UTF-8-safe exclusive byte boundary, including for line selections. chunk_lines counts returned line fragments, including partial first or last lines. Line and byte selectors are mutually exclusive. Chunks never split a UTF-8 character. A byte_offset inside a multi-byte character is rejected with BYTE_OFFSET_SPLITS_UTF8 and the nearest preceding safe_offset.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "commit_sha"],
        properties: {
          ...immutableFileProperties,
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          byte_offset: { type: "integer", minimum: 0 },
          byte_limit: { type: "integer", minimum: 1 },
          max_bytes: {
            type: "integer",
            minimum: 1,
            maximum: MAX_MAX_BYTES,
            default: DEFAULT_MAX_BYTES,
            description:
              "Per-call output budget in bytes; defaults to 65536. Values above about 64 KiB may exceed the observed Workers Free CPU margin, so prefer continuation.",
          },
          include_sha256: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "search_in_file",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Case-sensitive literal substring search in a strict UTF-8 file up to 262144 bytes. pattern is literal text, not a regular expression. Results count matching lines, with 1-based line numbers. truncated means the result list was reduced by max_matches or the 131072-byte serialized output budget; truncation_reason identifies which budget applied.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "commit_sha", "pattern"],
        properties: {
          ...immutableFileProperties,
          pattern: { type: "string", minLength: 1, maxLength: 512 },
          max_matches: { type: "integer", minimum: 1, maximum: 500, default: 50 },
          context_lines: { type: "integer", minimum: 0, maximum: 20, default: 0 },
        },
      },
    },
    {
      name: "put_file_text",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        "Atomically commit one complete UTF-8 file through the Git Data API. The branch ref update always uses force=false. Combined UTF-8 write content is limited to 262144 bytes per call.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "message"],
        properties: {
          path: { type: "string", pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$" },
          content: { type: "string" },
          message: { type: "string", minLength: 1, maxLength: 500 },
          branch: { type: "string", default: "main" },
          expected_parent_sha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
        },
      },
    },
    {
      name: "put_files_text",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        "Atomically write complete UTF-8 files and delete existing paths in one Git commit through the Git Data API. files remains required and may be empty for deletion-only calls. files and deletions together must contain 1-20 paths; deletions count toward this limit but not the 262144-byte combined UTF-8 content budget. Missing deletion targets, duplicate paths, write/delete overlap, and ancestor/descendant collisions are rejected. Deleting a directory removes its subtree. Empty content writes an empty file; omitted paths are preserved. The branch ref update always uses force=false. Requested deletions return separate path/verified receipts from the committed tree.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["files", "message"],
        properties: {
          files: {
            type: "array",
            minItems: 0,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "content"],
              properties: {
                path: { type: "string", pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$" },
                content: { type: "string" },
              },
            },
          },
          deletions: {
            type: "array",
            maxItems: 20,
            uniqueItems: true,
            items: { ...immutableFileProperties.path, minLength: 1, maxLength: 1024 },
            description: "Existing repository-relative paths to remove in the same commit as files; no content bytes are charged.",
          },
          message: { type: "string", minLength: 1, maxLength: 500 },
          branch: { type: "string", default: "main" },
          expected_parent_sha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
        },
      },
    },
    {
      name: "verify_write",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Independently compare an expected Git blob SHA with an ordinary file at an immutable full commit SHA.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "commit_sha", "expected_blob_sha"],
        properties: {
          ...immutableFileProperties,
          expected_blob_sha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
        },
      },
    },
  ];
}

export function listTools(): ToolResult {
  return textResult(JSON.stringify(toolDefinitions()));
}

export function toolsListPayload(): { tools: unknown[] } {
  return { tools: toolDefinitions() };
}

export async function callTool(
  client: GitHubClient,
  serviceVersion: string,
  name: unknown,
  rawArguments: unknown,
  observation: ObservationContext,
): Promise<ToolResult> {
  if (typeof name !== "string") {
    throw new ServiceError("INVALID_TOOL_NAME", "Tool name must be a string.");
  }
  const args = objectArgs(rawArguments);

  if (name === "create_branch") {
    rejectUnknownProperties(args, ["branch", "from_commit_sha"]);
    const branch = validateBranch(args.branch);
    const commitSha = validateCommitSha(args.from_commit_sha, "from_commit_sha");
    observation.markSchemaValidated();
    const result = await client.createBranch(branch, commitSha);
    return observedJsonTextResult(result, observation);
  }

  if (name === "delete_branch") {
    rejectUnknownProperties(args, ["branch", "expected_head_sha"]);
    const branch = validateBranch(args.branch);
    validateCommitSha(args.expected_head_sha, "expected_head_sha");
    observation.markSchemaValidated();
    const result = await client.deleteBranch(branch, args.expected_head_sha);
    return observedJsonTextResult(result, observation);
  }

  if (name === "get_commit_metadata") {
    rejectUnknownProperties(args, ["commit_sha"]);
    const commitSha = validateCommitSha(args.commit_sha);
    observation.markSchemaValidated();
    const metadata = await client.getCommitMetadata(commitSha);
    const result = observedJsonTextResult(metadata, observation);
    if (new TextEncoder().encode(result.content[0].text).byteLength > MAX_COMMIT_OUTPUT_BYTES) {
      throw new ServiceError(
        "COMMIT_OUTPUT_LIMIT", `Commit metadata result text may not exceed ${MAX_COMMIT_OUTPUT_BYTES} UTF-8 bytes.`, 413,
      );
    }
    return result;
  }

  if (name === "search_repo_index") {
    rejectUnknownProperties(args, ["query", "max_results"]);
    const query = validateIndexQuery(args.query);
    const maxResults = integerArg(args, "max_results", DEFAULT_INDEX_RESULTS)!;
    if (maxResults < 1 || maxResults > MAX_INDEX_RESULTS) {
      throw new ServiceError("INVALID_MAX_RESULTS", `max_results must be between 1 and ${MAX_INDEX_RESULTS}.`);
    }
    observation.markSchemaValidated();
    const matches = await client.searchRepoIndex(query, maxResults);
    const result = observedJsonTextResult({ service_version: serviceVersion, ...matches }, observation);
    if (new TextEncoder().encode(result.content[0].text).byteLength > MAX_INDEX_OUTPUT_BYTES) {
      throw new ServiceError("INDEX_SEARCH_OUTPUT_LIMIT",
        `Index search result text may not exceed ${MAX_INDEX_OUTPUT_BYTES} UTF-8 bytes; reduce max_results.`, 413);
    }
    return result;
  }

  if (name === "list_tree") {
    rejectUnknownProperties(args, ["commit_sha", "path", "max_depth"]);
    const path = args.path === undefined || args.path === "" ? "" : validatePath(args.path);
    const commitSha = validateCommitSha(args.commit_sha);
    const maxDepth = integerArg(args, "max_depth");
    if (maxDepth !== undefined && maxDepth < 1) {
      throw new ServiceError("INVALID_MAX_DEPTH", "max_depth must be a positive integer.");
    }
    observation.markSchemaValidated();
    const entries = await client.listTree(path, commitSha, maxDepth);
    const result = observedJsonTextResult({ service_version: serviceVersion, commit_sha: commitSha, path, entries }, observation);
    if (new TextEncoder().encode(result.content[0].text).byteLength > MAX_TREE_OUTPUT_BYTES) {
      throw new ServiceError(
        "TREE_OUTPUT_LIMIT", `Tree result text may not exceed ${MAX_TREE_OUTPUT_BYTES} UTF-8 bytes; reduce path scope or max_depth.`, 413,
      );
    }
    return result;
  }

  if (name === "list_directory") {
    rejectUnknownProperties(args, ["commit_sha", "path"]);
    const path = args.path === undefined || args.path === "" ? "" : validatePath(args.path);
    const commitSha = validateCommitSha(args.commit_sha);
    observation.markSchemaValidated();
    const entries = await client.listDirectory(path, commitSha);
    const result = observedJsonTextResult({ service_version: serviceVersion, commit_sha: commitSha, path, entries }, observation);
    if (new TextEncoder().encode(result.content[0].text).byteLength > MAX_DIRECTORY_OUTPUT_BYTES) {
      throw new ServiceError(
        "DIRECTORY_OUTPUT_LIMIT", `Directory result text may not exceed ${MAX_DIRECTORY_OUTPUT_BYTES} UTF-8 bytes.`, 413,
      );
    }
    return result;
  }

  if (name === "resolve_ref") {
    rejectUnknownProperties(args, ["ref"]);
    const ref = validateRef(args.ref);
    observation.markSchemaValidated();
    const commitSha = await client.resolveRef(ref);
    return observedJsonTextResult({ ref, commit_sha: commitSha }, observation);
  }

  if (name === "stat_file") {
    rejectUnknownProperties(args, ["path", "commit_sha"]);
    const path = validatePath(args.path);
    const commitSha = validateCommitSha(args.commit_sha);
    observation.markSchemaValidated();
    const file = await client.getFile(path, commitSha);
    return observedJsonTextResult({
      service_version: serviceVersion,
      commit_sha: file.commitSha,
      path: file.path,
      blob_sha: file.blobSha,
      byte_length: file.analysis.byteLength,
      line_count: file.analysis.lineCount,
      first_line_fingerprint: file.analysis.firstLineFingerprint,
      last_line_fingerprint: file.analysis.lastLineFingerprint,
      is_binary: file.analysis.isBinary,
      is_symlink: file.isSymlink,
      is_submodule: file.isSubmodule,
      is_lfs_pointer: file.analysis.isLfsPointer,
      encoding: file.analysis.encoding,
    }, observation);
  }

  if (name === "get_file_text") {
    rejectUnknownProperties(args, [
      "path",
      "commit_sha",
      "start_line",
      "end_line",
      "byte_offset",
      "byte_limit",
      "max_bytes",
      "include_sha256",
    ]);
    const path = validatePath(args.path);
    const commitSha = validateCommitSha(args.commit_sha);
    const hasLineSelector = args.start_line !== undefined || args.end_line !== undefined;
    const hasByteSelector = args.byte_offset !== undefined || args.byte_limit !== undefined;
    if (hasLineSelector && hasByteSelector) {
      throw new ServiceError(
        "MUTUALLY_EXCLUSIVE_RANGE",
        "Line selectors and byte selectors cannot be used together.",
      );
    }
    const requestedStartLine = args.start_line === undefined
      ? undefined
      : integerArg(args, "start_line")!;
    const requestedEndLine = args.end_line === undefined
      ? undefined
      : integerArg(args, "end_line")!;
    if (requestedStartLine !== undefined && requestedStartLine < 1) {
      throw new ServiceError("INVALID_INTEGER", "start_line must be an integer of at least 1.");
    }
    if (requestedEndLine !== undefined && requestedEndLine < 1) {
      throw new ServiceError("INVALID_INTEGER", "end_line must be an integer of at least 1.");
    }
    const requestedByteOffset = args.byte_offset === undefined
      ? undefined
      : integerArg(args, "byte_offset")!;
    if (requestedByteOffset !== undefined && requestedByteOffset < 0) {
      throw new ServiceError("INVALID_INTEGER", "byte_offset must be a non-negative integer.");
    }
    const requestedByteLimit = args.byte_limit === undefined
      ? undefined
      : integerArg(args, "byte_limit")!;
    if (requestedByteLimit !== undefined && requestedByteLimit < 1) {
      throw new ServiceError("INVALID_INTEGER", "byte_limit must be an integer of at least 1.");
    }
    const maxBytes = integerArg(args, "max_bytes", DEFAULT_MAX_BYTES)!;
    if (maxBytes < 1 || maxBytes > MAX_MAX_BYTES) {
      throw new ServiceError(
        "INVALID_MAX_BYTES",
        `max_bytes must be between 1 and ${MAX_MAX_BYTES}.`,
      );
    }
    const includeSha256 = booleanArg(args, "include_sha256", false);

    observation.markSchemaValidated();
    const file = await client.getFile(path, commitSha);
    requireUtf8(file.analysis);

    let selectionStart = 0;
    let selectionEnd = file.bytes.byteLength;
    let range = "full";
    if (hasLineSelector) {
      const startLine = requestedStartLine ?? 1;
      const endLine = requestedEndLine ?? file.analysis.lineCount;
      const selected = lineByteRange(
        file.bytes,
        startLine,
        endLine,
        file.analysis.lineCount,
      );
      selectionStart = selected.start;
      selectionEnd = selected.end;
      range = `lines:${startLine}-${endLine}`;
    } else if (hasByteSelector) {
      const offset = requestedByteOffset ?? 0;
      if (offset > file.bytes.byteLength) {
        throw new ServiceError(
          "BYTE_RANGE_OUT_OF_BOUNDS",
          [
            "byte_offset exceeds the maximum valid offset for this ordinary UTF-8 file.",
            `byte_length: ${file.bytes.byteLength}`,
            `requested_byte_offset: ${offset}`,
            `max_valid_byte_offset: ${file.bytes.byteLength}`,
            "empty_eof_read_allowed: true",
          ].join("\n"),
        );
      }
      const limit = requestedByteLimit ?? file.bytes.byteLength - offset;
      if (offset < file.bytes.byteLength && (file.bytes[offset] & 0xc0) === 0x80) {
        let safeOffset = offset;
        while (safeOffset > 0 && (file.bytes[safeOffset] & 0xc0) === 0x80) {
          safeOffset -= 1;
        }
        throw new ServiceError(
          "BYTE_OFFSET_SPLITS_UTF8",
          `byte_offset points inside a multi-byte UTF-8 character.\nsafe_offset: ${safeOffset}`,
        );
      }
      selectionStart = offset;
      const requestedSelectionEnd = Math.min(file.bytes.byteLength, offset + limit);
      try {
        // byte_limit is a maximum. Report the actual half-open range after
        // retreating from a continuation byte, rather than advertising an
        // impossible continuation inside one UTF-8 character.
        selectionEnd = safeUtf8End(file.bytes, offset, requestedSelectionEnd);
      } catch (error) {
        if (error instanceof ServiceError && error.code === "MAX_BYTES_SPLITS_UTF8") {
          throw new ServiceError(
            "BYTE_LIMIT_SPLITS_UTF8",
            "byte_limit is too small to include the next complete UTF-8 character.",
          );
        }
        throw error;
      }
      range = `bytes:${selectionStart}-${selectionEnd}`;
    }

    const requestedEnd = Math.min(selectionEnd, selectionStart + maxBytes);
    const chunkEnd = safeUtf8End(file.bytes, selectionStart, requestedEnd);
    const chunk = file.bytes.slice(selectionStart, chunkEnd);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(chunk);
    } catch {
      throw new ServiceError(
        "CHUNK_UTF8_INVALID",
        "The selected byte range cannot be decoded as complete UTF-8 characters.",
      );
    }
    const selectionTruncated = chunkEnd < selectionEnd;
    const fileHasMore = chunkEnd < file.bytes.byteLength;
    if (selectionTruncated) {
      // A bytes:a-b range always names the bytes actually delivered. The
      // requested selection boundary remains explicit for bounded continuation.
      range = `bytes:${selectionStart}-${chunkEnd}`;
    }
    let sha256: string | undefined;
    if (includeSha256) {
      if (file.bytes.byteLength > SHA256_MAX_BYTES) {
        throw new ServiceError(
          "SHA256_SIZE_LIMIT",
          `include_sha256 is limited to ${SHA256_MAX_BYTES} bytes; this file has ${file.bytes.byteLength} bytes.`,
        );
      }
      sha256 = await digestHex("SHA-256", file.bytes);
    }

    const delimiters = delimiterFor(body);
    const header = [
      "GITHUB_FILE_TEXT_V1",
      `service_version: ${serviceVersion}`,
      `commit: ${file.commitSha}`,
      `path: ${file.path}`,
      `blob_sha: ${file.blobSha}`,
      ...(sha256 ? [`sha256: ${sha256}`] : []),
      `byte_length: ${file.analysis.byteLength}`,
      `line_count: ${file.analysis.lineCount}`,
      `first_line_fingerprint: ${file.analysis.firstLineFingerprint}`,
      `last_line_fingerprint: ${file.analysis.lastLineFingerprint}`,
      `range: ${range}`,
      `selection_end_byte_offset: ${selectionEnd}`,
      `chunk_bytes: ${chunk.byteLength}`,
      `chunk_lines: ${lineCountForChunk(chunk)}`,
      `truncated: ${selectionTruncated}`,
      `has_more: ${fileHasMore}`,
      `next_byte_offset: ${fileHasMore ? chunkEnd : "null"}`,
      "encoding: utf-8",
      ...observationTextLines(observation.snapshot()),
      ...(delimiters.nonceLine ? [delimiters.nonceLine] : []),
      delimiters.begin,
    ].join("\n");
    return textResult(`${header}\n${body}${delimiters.end}`);
  }

  if (name === "search_in_file") {
    rejectUnknownProperties(args, [
      "path",
      "commit_sha",
      "pattern",
      "max_matches",
      "context_lines",
    ]);
    const path = validatePath(args.path);
    const commitSha = validateCommitSha(args.commit_sha);
    const pattern = stringArg(args, "pattern", { required: true });
    if (pattern.length > 512) {
      throw new ServiceError("PATTERN_TOO_LONG", "pattern may contain at most 512 characters.");
    }
    const maxMatches = integerArg(args, "max_matches", 50)!;
    const contextLines = integerArg(args, "context_lines", 0)!;
    if (maxMatches < 1 || maxMatches > 500) {
      throw new ServiceError("INVALID_MAX_MATCHES", "max_matches must be between 1 and 500.");
    }
    if (contextLines < 0 || contextLines > 20) {
      throw new ServiceError("INVALID_CONTEXT_LINES", "context_lines must be between 0 and 20.");
    }

    observation.markSchemaValidated();
    const file = await client.getFile(path, commitSha);
    if (file.bytes.byteLength > MAX_SEARCH_BYTES) {
      throw new ServiceError(
        "SEARCH_SIZE_LIMIT",
        `search_in_file is limited to ${MAX_SEARCH_BYTES} bytes per file.`,
        413,
      );
    }
    const text = requireUtf8(file.analysis);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].endsWith("\r")) lines[index] = lines[index].slice(0, -1);
    }
    const cleanLines = lines;
    let totalMatches = 0;
    const candidateIndexes: number[] = [];
    for (let index = 0; index < cleanLines.length; index += 1) {
      if (cleanLines[index].includes(pattern)) {
        totalMatches += 1;
        if (candidateIndexes.length < maxMatches) candidateIndexes.push(index);
      }
    }

    const selected: Array<{
      line_number: number;
      line: string;
      context_before: string[];
      context_after: string[];
    }> = [];
    let estimatedBytes = 4_096;
    let outputBudgetHit = false;
    for (const index of candidateIndexes) {
      const candidate = {
        line_number: index + 1,
        line: cleanLines[index],
        context_before: cleanLines.slice(Math.max(0, index - contextLines), index),
        context_after: cleanLines.slice(index + 1, index + 1 + contextLines),
      };
      const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength + 256;
      if (estimatedBytes + candidateBytes > MAX_SEARCH_OUTPUT_BYTES) {
        outputBudgetHit = true;
        break;
      }
      estimatedBytes += candidateBytes;
      selected.push(candidate);
    }
    if (outputBudgetHit && selected.length === 0 && totalMatches > 0) {
      throw new ServiceError(
        "SEARCH_OUTPUT_LIMIT",
        `The first search result and its context exceed the ${MAX_SEARCH_OUTPUT_BYTES}-byte output budget; reduce context_lines or read the matching line with get_file_text.`,
        413,
      );
    }

    const payload = {
      service_version: serviceVersion,
      commit_sha: file.commitSha,
      path: file.path,
      pattern_kind: "literal",
      pattern,
      total_matches: totalMatches,
      truncated: totalMatches > selected.length,
      truncation_reason: outputBudgetHit
        ? "output_bytes"
        : totalMatches > candidateIndexes.length
          ? "max_matches"
          : null,
      matches: selected,
    };
    const observedPayload = { ...payload, ...observation.snapshot() };
    const serialized = JSON.stringify(observedPayload, null, 2);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SEARCH_OUTPUT_BYTES) {
      throw new ServiceError(
        "SEARCH_OUTPUT_LIMIT",
        "The serialized search result exceeded its output budget.",
        413,
      );
    }
    return textResult(serialized);
  }

  if (name === "put_file_text") {
    rejectUnknownProperties(args, [
      "path",
      "content",
      "message",
      "branch",
      "expected_parent_sha",
    ]);
    const path = validatePath(stringArg(args, "path", { required: true }));
    const content = stringArg(args, "content");
    const message = stringArg(args, "message", { required: true });
    if (message.length > 500) {
      throw new ServiceError(
        "INVALID_COMMIT_MESSAGE",
        "message must be a non-empty string of at most 500 characters.",
      );
    }
    const branch = stringArg(args, "branch", { required: true, defaultValue: "main" });
    const expectedParentSha = args.expected_parent_sha === undefined
      ? undefined
      : validateCommitSha(args.expected_parent_sha, "expected_parent_sha");
    observation.markSchemaValidated();
    const result = await client.writeFiles({
      files: [{ path, content }],
      message,
      branch,
      expectedParentSha,
    });
    return observedJsonTextResult(result, observation);
  }

  if (name === "put_files_text") {
    rejectUnknownProperties(args, [
      "files",
      "deletions",
      "message",
      "branch",
      "expected_parent_sha",
    ]);
    if (!Array.isArray(args.files)) {
      throw new ServiceError("INVALID_FILES", "files must be an array.");
    }
    if (args.deletions !== undefined && !Array.isArray(args.deletions)) {
      throw new ServiceError("INVALID_DELETIONS", "deletions must be an array of paths.");
    }
    const deletions = (args.deletions ?? []) as unknown[];
    const deletionPaths = deletions.map((path) => validatePath(path));
    const entryCount = args.files.length + deletionPaths.length;
    if (entryCount < 1 || entryCount > 20) {
      throw new ServiceError(
        "INVALID_FILE_COUNT",
        "files and deletions must contain between 1 and 20 entries in total.",
      );
    }
    const files: WriteInput[] = args.files.map((value, index) => {
      const file = objectArgs(value);
      rejectUnknownProperties(file, ["path", "content"], `files[${index}]`);
      return {
        path: validatePath(stringArg(file, "path", { required: true })),
        content: stringArg(file, "content"),
      };
    });
    const message = stringArg(args, "message", { required: true });
    if (message.length > 500) {
      throw new ServiceError(
        "INVALID_COMMIT_MESSAGE",
        "message must be a non-empty string of at most 500 characters.",
      );
    }
    const branch = stringArg(args, "branch", { required: true, defaultValue: "main" });
    const expectedParentSha = args.expected_parent_sha === undefined
      ? undefined
      : validateCommitSha(args.expected_parent_sha, "expected_parent_sha");
    observation.markSchemaValidated();
    const result = await client.writeFiles({
      files,
      deletions: deletionPaths,
      message,
      branch,
      expectedParentSha,
    });
    return observedJsonTextResult(result, observation);
  }

  if (name === "verify_write") {
    rejectUnknownProperties(args, ["path", "commit_sha", "expected_blob_sha"]);
    const path = validatePath(args.path);
    const commitSha = validateCommitSha(args.commit_sha);
    const expected = stringArg(args, "expected_blob_sha", { required: true }).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      throw new ServiceError(
        "INVALID_BLOB_SHA",
        "expected_blob_sha must be a complete 40-character hexadecimal Git blob SHA.",
      );
    }
    observation.markSchemaValidated();
    const file = await client.getFile(path, commitSha);
    return observedJsonTextResult({
      service_version: serviceVersion,
      commit_sha: file.commitSha,
      path: file.path,
      expected_blob_sha: expected,
      blob_sha: file.blobSha,
      byte_length: file.bytes.byteLength,
      match: file.blobSha === expected,
    }, observation);
  }

  throw new ServiceError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
}
