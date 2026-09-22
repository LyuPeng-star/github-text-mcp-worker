import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { digestHex, encodeUtf8, gitBlobSha } from "../src/encoding.ts";
import { GitHubClient, MAX_COMMIT_FILES, MAX_DIRECTORY_ENTRIES, MAX_TREE_ENTRIES } from "../src/github.ts";
import { handleRequest } from "../src/index.ts";
import { ObservationContext } from "../src/observation.ts";
import { callTool as callServiceTool } from "../src/service.ts";
import { MAX_COMMIT_OUTPUT_BYTES, MAX_DIRECTORY_OUTPUT_BYTES, MAX_TREE_OUTPUT_BYTES, MAX_INDEX_OUTPUT_BYTES, SHA256_MAX_BYTES } from "../src/service.ts";
import type { Env, FetchLike } from "../src/types.ts";
import { createCorpusRepository } from "./corpus-repository.ts";
import {
  ALLOW_RATE_LIMITER,
  CONNECTOR_TOKEN,
  FULL_COMMIT,
  GITHUB_TOKEN,
  OBSERVATION_ENV,
  SOURCE_COMMIT,
  assertTextOnly,
  callTool,
  createReadMock,
  errorCode,
  independentEnvelopeCheck,
  parseEnvelope,
  parseToolErrorFields,
  rpc,
  utf8,
} from "./helpers.ts";

function assertJsonObservation(
  value: any,
  attempted: boolean,
  outcome: string,
): void {
  assert.equal(value.deployment_version_id, "11111111-2222-3333-4444-555555555555");
  assert.equal(value.deployment_identity_scope, "cloudflare_worker_version_metadata");
  assert.equal(value.deployment_version_tag, "source-bbbbbbbbbbbb");
  assert.equal(value.deployment_version_created_at, "2026-08-31T12:00:00.000Z");
  assert.equal(value.source_commit, SOURCE_COMMIT);
  assert.ok(Number.isInteger(value.observed_elapsed_ms));
  assert.ok(value.observed_elapsed_ms >= 0);
  assert.equal(value.observed_elapsed_scope, "worker_clock_after_schema_validation");
  assert.match(value.observed_elapsed_clock_note, /not reliable total elapsed time/);
  assert.equal(value.github_fetch_attempted, attempted);
  assert.equal(value.github_fetch_outcome, outcome);
}

function assertTextObservation(
  fields: Record<string, string>,
  attempted: boolean,
  outcome: string,
): void {
  assert.equal(fields.deployment_version_id, "11111111-2222-3333-4444-555555555555");
  assert.equal(fields.deployment_identity_scope, "cloudflare_worker_version_metadata");
  assert.equal(fields.deployment_version_tag, "source-bbbbbbbbbbbb");
  assert.equal(fields.deployment_version_created_at, "2026-08-31T12:00:00.000Z");
  assert.equal(fields.source_commit, SOURCE_COMMIT);
  assert.ok(Number.isInteger(Number(fields.observed_elapsed_ms)));
  assert.ok(Number(fields.observed_elapsed_ms) >= 0);
  assert.equal(fields.observed_elapsed_scope, "worker_clock_after_schema_validation");
  assert.match(fields.observed_elapsed_clock_note, /not reliable total elapsed time/);
  assert.equal(fields.github_fetch_attempted, String(attempted));
  assert.equal(fields.github_fetch_outcome, outcome);
}

const DEPLOY_CLEAN_SCRIPT = fileURLToPath(
  new URL("../scripts/deploy-clean.mjs", import.meta.url),
);

interface DeployGuardFixture {
  cwd: string;
  env: NodeJS.ProcessEnv;
  wranglerLog: string;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function requireProcessSuccess(
  result: ReturnType<typeof runProcess>,
  description: string,
): void {
  assert.equal(
    result.status,
    0,
    `${description} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function createDeployGuardRepository(): Promise<DeployGuardFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "psearch-deploy-guard-"));
  requireProcessSuccess(
    runProcess("git", ["init", "-q", "--initial-branch=main"], cwd),
    "git init",
  );
  await writeFile(join(cwd, "tracked.txt"), "baseline\n", "utf8");
  requireProcessSuccess(runProcess("git", ["add", "tracked.txt"], cwd), "git add");
  requireProcessSuccess(
    runProcess(
      "git",
      [
        "-c",
        "user.name=deploy-guard-test",
        "-c",
        "user.email=deploy-guard-test@example.invalid",
        "commit",
        "-q",
        "-m",
        "baseline",
      ],
      cwd,
    ),
    "git commit",
  );
  requireProcessSuccess(
    runProcess("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], cwd),
    "git update-ref origin/main",
  );

  const fakeBin = join(cwd, ".git", "fake-bin");
  const wranglerLog = join(cwd, ".git", "wrangler-invocations.jsonl");
  const fakeWrangler = join(fakeBin, "wrangler");
  await mkdir(fakeBin, { recursive: true });
  // A clean process may have no PATH. Resolve the platform's utility path and
  // make the current Node executable available to the fake Wrangler's shebang.
  const defaultPath = runProcess("getconf", ["PATH"], cwd);
  requireProcessSuccess(defaultPath, "getconf PATH");
  await symlink(process.execPath, join(fakeBin, "node"));
  await writeFile(
    fakeWrangler,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs");',
      "const output = process.env.DEPLOY_GUARD_WRANGLER_LOG;",
      "if (!output) process.exit(97);",
      'appendFileSync(output, `${JSON.stringify(process.argv.slice(2))}\\n`, "utf8");',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeWrangler, 0o755);
  return {
    cwd,
    wranglerLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? defaultPath.stdout.trim()}`,
      DEPLOY_GUARD_WRANGLER_LOG: wranglerLog,
    },
  };
}

function deployGuardHead(fixture: DeployGuardFixture, ref = "HEAD"): string {
  const result = runProcess("git", ["rev-parse", "--verify", ref], fixture.cwd);
  requireProcessSuccess(result, `git rev-parse --verify ${ref}`);
  const commit = result.stdout.trim().toLowerCase();
  assert.match(commit, /^[0-9a-f]{40}$/);
  return commit;
}

async function commitDeployGuardFile(
  fixture: DeployGuardFixture,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(fixture.cwd, path), content, "utf8");
  requireProcessSuccess(runProcess("git", ["add", path], fixture.cwd), `git add ${path}`);
  requireProcessSuccess(
    runProcess(
      "git",
      [
        "-c",
        "user.name=deploy-guard-test",
        "-c",
        "user.email=deploy-guard-test@example.invalid",
        "commit",
        "-q",
        "-m",
        message,
      ],
      fixture.cwd,
    ),
    `git commit ${path}`,
  );
  return deployGuardHead(fixture);
}

function runDeployGuard(fixture: DeployGuardFixture) {
  return runProcess(
    process.execPath,
    [DEPLOY_CLEAN_SCRIPT, "--dry-run"],
    fixture.cwd,
    fixture.env,
  );
}

async function readWranglerInvocations(
  fixture: DeployGuardFixture,
): Promise<string[][]> {
  try {
    const raw = await readFile(fixture.wranglerLog, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("initialize advertises tools only and returns one JSON object", async () => {
  const mock = await createReadMock([]);
  const response = await rpc(mock.fetcher, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const payload = await response.json() as any;
  assert.deepEqual(Object.keys(payload.result.capabilities), ["tools"]);
  assert.equal(payload.result.serverInfo.name, "github-text-mcp-worker");
  assert.equal(payload.result.serverInfo.version, "test-version");
});

test("tools/list exposes thirteen tools without owner, repo, or resource schemas", async () => {
  const mock = await createReadMock([]);
  const response = await rpc(mock.fetcher, "tools/list");
  const payload = await response.json() as any;
  assert.equal(payload.result.tools.length, 13);
  const serialized = JSON.stringify(payload.result);
  assert.doesNotMatch(serialized, /"owner"|"repo"/);
  assert.doesNotMatch(serialized, /resource_link|resources\/read|resources\/list/);
  const getTool = payload.result.tools.find((tool: any) => tool.name === "get_file_text");
  assert.match(getTool.description, /1-based closed intervals/);
  assert.match(getTool.description, /truncated means max_bytes reduced/);
  assert.match(getTool.description, /has_more means later file bytes remain/);
  assert.match(getTool.description, /chunk_lines counts returned line fragments/);
  assert.match(getTool.description, /fingerprint.*describe the entire file/);
  assert.equal(getTool.inputSchema.properties.max_bytes.default, 65_536);
  assert.match(getTool.inputSchema.properties.max_bytes.description, /CPU margin/);
  const searchTool = payload.result.tools.find((tool: any) => tool.name === "search_in_file");
  assert.match(searchTool.description, /literal text, not a regular expression/);
  assert.match(searchTool.description, /truncated means the result list was reduced/);
  const resolveTool = payload.result.tools.find((tool: any) => tool.name === "resolve_ref");
  assert.match(resolveTool.description, /bound repository/);
  assert.deepEqual(resolveTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(resolveTool.inputSchema.type, "object");
  assert.equal(resolveTool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(resolveTool.inputSchema.properties), ["ref"]);
  assert.deepEqual(resolveTool.inputSchema.required ?? [], []);
  assert.equal(resolveTool.inputSchema.properties.ref.type, "string");
  assert.equal(resolveTool.inputSchema.properties.ref.default, "main");
  const directoryTool = payload.result.tools.find((tool: any) => tool.name === "list_directory");
  assert.deepEqual(directoryTool.annotations, resolveTool.annotations);
  assert.equal(directoryTool.inputSchema.additionalProperties, false);
  assert.deepEqual(directoryTool.inputSchema.required, ["commit_sha"]);
  assert.deepEqual(Object.keys(directoryTool.inputSchema.properties).sort(), ["commit_sha", "path"]);
  assert.equal(directoryTool.inputSchema.properties.path.default, "");
  assert.equal(directoryTool.inputSchema.properties.commit_sha.pattern, "^[0-9a-fA-F]{40}$");
  assert.match(directoryTool.description, /UTF-8 path bytes without Unicode normalization/);
  assert.match(directoryTool.description, /DIRECTORY_OUTPUT_LIMIT instead of truncating/);
  const metadataTool = payload.result.tools.find((tool: any) => tool.name === "get_commit_metadata");
  assert.deepEqual(metadataTool.annotations, resolveTool.annotations);
  assert.equal(metadataTool.inputSchema.additionalProperties, false);
  assert.deepEqual(metadataTool.inputSchema.required, ["commit_sha"]);
  assert.deepEqual(Object.keys(metadataTool.inputSchema.properties), ["commit_sha"]);
  assert.equal(metadataTool.inputSchema.properties.commit_sha.pattern, "^[0-9a-fA-F]{40}$");
  assert.match(metadataTool.description, /first parent, including merge commits/);
  assert.match(metadataTool.description, /COMMIT_FILES_INCOMPLETE/);
  assert.match(metadataTool.description, /COMMIT_FILES_UNAVAILABLE/);
  assert.match(metadataTool.description, /zero-change commit succeeds with files: \[\]/);
  assert.equal(mock.calls.length, 0);
});

const METADATA_TREE_SHA = "d".repeat(40);
const METADATA_PARENT_SHA = "b".repeat(40);
const METADATA_DATE = "2025-01-01T00:00:00Z";

function metadataFile(filename: string, additions = 1, deletions = 0) {
  return { filename, status: "modified", additions, deletions };
}

function commitMetadataMock(
  files: Array<Record<string, any>>,
  options: { parents?: string[]; tree?: string; commitSha?: string; binding?: { owner: string; repo: string } } = {},
) {
  const binding = options.binding ?? { owner: "fixture-owner", repo: "secondary-repository" };
  const prefix = `/repos/${binding.owner}/${binding.repo}`;
  const commitSha = options.commitSha ?? FULL_COMMIT;
  const parents = options.parents ?? [METADATA_PARENT_SHA];
  const core = {
    sha: commitSha, parents: parents.map((sha) => ({ sha })),
    commit: { author: { date: METADATA_DATE }, committer: { date: METADATA_DATE },
      tree: { sha: options.tree ?? METADATA_TREE_SHA }, message: "message-sentinel-must-not-be-returned" },
    stats: { additions: files.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0) },
  };
  const pages: Array<{ body: any; link: string | null; status?: number }> = [];
  const pageCount = Math.max(1, Math.ceil(files.length / 100));
  const url = (page: number) => `https://api.github.com/repositories/123/commits/${commitSha}?per_page=100&page=${page}`;
  for (let page = 1; page <= pageCount; page++) {
    const links = [];
    if (page < pageCount) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(pageCount)}>; rel="last"`);
    if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
    pages.push({ body: { ...structuredClone(core), files: files.slice((page - 1) * 100, page * 100) }, link: links.length ? links.join(", ") : null });
  }
  const parent = { body: { sha: parents[0], tree: { sha: options.tree ?? METADATA_TREE_SHA } } };
  const calls: Array<{ path: string; method: string; authorization: string | null }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, "https://api.github.com");
    const method = init?.method ?? "GET";
    assert.equal(method, "GET");
    calls.push({ path: target.pathname + target.search, method, authorization: new Headers(init?.headers).get("authorization") });
    if (target.pathname === `${prefix}/git/commits/${parents[0]}`) {
      assert.equal(target.search, "");
      return new Response(JSON.stringify(parent.body));
    }
    assert.equal(target.pathname, `${prefix}/commits/${commitSha}`);
    assert.equal(target.searchParams.get("per_page"), "100");
    const page = Number(target.searchParams.get("page"));
    assert.ok(page >= 1 && page <= pages.length);
    const reply = pages[page - 1];
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.link ? { link: reply.link } : {} });
  };
  return { fetcher, calls, pages, parent };
}

test("get_commit_metadata returns exact immutable fields, rename metadata and UTF-8 sorted paths", async () => {
  const names = ["😀.txt", "\ue000.txt", "é.txt", "e\u0301.txt", "a.txt"];
  const files = names.map((name) => ({ ...metadataFile(name, 3, 2), changes: 999, patch: "patch-sentinel", previous_filename: "must-not-appear" }));
  files[0] = { ...files[0], status: "renamed", previous_filename: "old-e\u0301.txt" };
  const mock = commitMetadataMock(files);
  const result = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT.toUpperCase() }, { env: OBSERVATION_ENV });
  assert.equal(result.result.isError, undefined);
  assertTextOnly(result.result);
  const payload = JSON.parse(result.text);
  assert.equal(payload.commit_sha, FULL_COMMIT);
  assert.deepEqual(payload.parent_shas, [METADATA_PARENT_SHA]);
  assert.equal(payload.author_date, METADATA_DATE);
  assert.equal(payload.committer_date, METADATA_DATE);
  const expectedPaths = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.deepEqual(payload.files.map((f: any) => f.path), expectedPaths);
  for (const file of payload.files) {
    assert.equal(file.additions, 3);
    assert.equal(file.deletions, 2);
    assert.deepEqual(Object.keys(file).sort(), file.status === "renamed"
      ? ["additions", "deletions", "path", "previous_path", "status"] : ["additions", "deletions", "path", "status"]);
    if (file.status === "renamed") assert.equal(file.previous_path, "old-e\u0301.txt");
  }
  assert.deepEqual(Buffer.from(payload.files.find((f: any) => f.path === "e\u0301.txt").path), Buffer.from("e\u0301.txt"));
  assertJsonObservation(payload, true, "succeeded");
  assert.doesNotMatch(result.text, /"changes"|"message"|patch-sentinel|message-sentinel|must-not-appear|chunk_bytes|---BEGIN FILE/);
});

test("get_commit_metadata preserves synthetic merge parents and first-parent file changes", async () => {
  // Synthetic merge response with two parents and asymmetric per-file changes.
  const commitSha = "1111111111111111111111111111111111111111";
  const parents = ["2222222222222222222222222222222222222222", "3333333333333333333333333333333333333333"];
  const files = [
    metadataFile("docs/engineering/handoff.md", 8, 1), metadataFile("src/github.ts", 104, 0),
    metadataFile("src/service.ts", 43, 0), metadataFile("test/service.test.ts", 283, 10),
  ];
  const mock = commitMetadataMock(files, { commitSha, parents, tree: "4444444444444444444444444444444444444444" });
  const result = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: commitSha });
  const payload = JSON.parse(result.text);
  assert.equal(payload.commit_sha, commitSha);
  assert.deepEqual(payload.parent_shas, parents);
  assert.deepEqual(payload.files, files.map(({ filename, ...file }) => ({ path: filename, ...file })));
  assert.equal(payload.author_date, "2025-01-01T00:00:00Z");
  assert.equal(payload.committer_date, "2025-01-01T00:00:00Z");
});

test("get_commit_metadata rejects ref, abbreviated SHA and extra arguments before fetching", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, "INVALID_COMMIT_SHA"], [{ commit_sha: "abcd" }, "SHORT_COMMIT_SHA"], [{ commit_sha: "main" }, "REF_NAME_NOT_ALLOWED"],
    ...["owner", "repo", "ref", "path"].map((key): [Record<string, unknown>, string] => [{ commit_sha: FULL_COMMIT, [key]: "x" }, "UNEXPECTED_ARGUMENT"]),
  ];
  for (const [args, code] of cases) {
    const result = await callTool(async () => { assert.fail("must not fetch"); }, "get_commit_metadata", args, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assertTextObservation(parseToolErrorFields(result.text), false, "not_attempted");
  }
});

test("get_commit_metadata aggregates pages and rejects incomplete or inconsistent pagination", async () => {
  const files = Array.from({ length: 101 }, (_, n) => metadataFile(`f${String(n).padStart(3, "0")}`));
  const complete = commitMetadataMock([...files].reverse());
  const result = await callTool(complete.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT });
  assert.deepEqual(JSON.parse(result.text).files.map((f: any) => f.path), files.map((f) => f.filename));
  assert.equal(complete.calls.length, 2);
  const mutations: Array<(mock: ReturnType<typeof commitMetadataMock>) => void> = [
    (mock) => { mock.pages[0].link = null; },
    (mock) => { mock.pages[1].body.files = [mock.pages[0].body.files[0]]; },
    (mock) => { mock.pages[1].body.commit.author.date = "2026-09-11T00:00:00Z"; },
    (mock) => { mock.pages[1].body.files = []; },
    (mock) => { mock.pages[0].link = mock.pages[0].link!.replace("page=2", "page=1"); },
    (mock) => { mock.pages[0].link = mock.pages[0].link!.replace("api.github.com", "secret.invalid"); },
    (mock) => { mock.pages[0].link = "unparseable"; },
    (mock) => { mock.pages[0].body.files.pop(); },
    (mock) => { mock.pages[0].link = mock.pages[0].link!.replace(`/repositories/123/commits/${FULL_COMMIT}`, "/repos/other-owner/other-repo/commits/" + FULL_COMMIT); },
  ];
  for (const mutate of mutations) {
    const mock = commitMetadataMock(files);
    mutate(mock);
    const failed = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT });
    assert.equal(failed.result.isError, true);
    assert.equal(errorCode(failed.text), "COMMIT_FILES_INCOMPLETE");
    assert.equal(parseToolErrorFields(failed.text).result, "null");
    assert.doesNotMatch(failed.text, /"files"|other-owner|secret\.invalid/);
  }
  const failedPage = commitMetadataMock(files);
  failedPage.pages[1].status = 503;
  const failed = await callTool(failedPage.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT });
  assert.equal(errorCode(failed.text), "GITHUB_UPSTREAM_ERROR");
  assert.equal(parseToolErrorFields(failed.text).result, "null");
});

test("get_commit_metadata distinguishes verified empty commits and pure merges from unavailable files", async () => {
  for (const parents of [[], [METADATA_PARENT_SHA], [METADATA_PARENT_SHA, "c".repeat(40)]]) {
    const mock = commitMetadataMock([], { parents, tree: parents.length ? METADATA_TREE_SHA : "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
    const result = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT }, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, undefined);
    assert.deepEqual(JSON.parse(result.text).files, []);
    assert.deepEqual(JSON.parse(result.text).parent_shas, parents);
    assertJsonObservation(JSON.parse(result.text), true, "succeeded");
    assert.equal(mock.calls.length, parents.length ? 2 : 1);
  }
  for (const parents of [[], [METADATA_PARENT_SHA], [METADATA_PARENT_SHA, "c".repeat(40)]]) {
    const mock = commitMetadataMock([], { parents });
    mock.parent.body.tree.sha = "e".repeat(40);
    const result = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "COMMIT_FILES_UNAVAILABLE");
    assert.equal(parseToolErrorFields(result.text).result, "null");
  }
  for (const missing of [undefined, null]) {
    const mock = commitMetadataMock([]);
    mock.pages[0].body.files = missing;
    const result = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT });
    assert.equal(errorCode(result.text), "COMMIT_FILES_UNAVAILABLE");
    assert.equal(parseToolErrorFields(result.text).result, "null");
  }
});

test("get_commit_metadata rejects malformed metadata without returning upstream text", async () => {
  const mutations: Array<(body: any) => void> = [
    (body) => { body.sha = "bad"; }, (body) => { body.parents = [{ sha: "short" }]; },
    (body) => { body.commit.author.date = "Bearer secret-sentinel"; }, (body) => { body.commit.tree.sha = "bad"; },
    (body) => { body.files[0].additions = -1; }, (body) => { body.files[0].deletions = 1.5; },
    (body) => { body.files[0].filename = "../escape"; }, (body) => { body.files[0].filename = "\ud800"; },
    (body) => { body.files[0].status = "unknown"; }, (body) => { body.files[0].status = "renamed"; },
  ];
  for (const mutate of mutations) {
    const mock = commitMetadataMock([metadataFile("x")]);
    mutate(mock.pages[0].body);
    const result = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT }, { env: OBSERVATION_ENV });
    assert.equal(errorCode(result.text), "GITHUB_COMMIT_RESPONSE_INVALID");
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assertTextObservation(parseToolErrorFields(result.text), true, "succeeded");
    assert.doesNotMatch(result.text, /Bearer|secret-sentinel|escape/);
  }
});

test("get_commit_metadata enforces the file cap below GitHub's pagination ceiling", async () => {
  assert.equal(MAX_COMMIT_FILES, 1_000);
  const files = Array.from({ length: MAX_COMMIT_FILES }, (_, n) => metadataFile(`f${String(n).padStart(4, "0")}`));
  const complete = await callTool(commitMetadataMock(files).fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT });
  assert.equal(complete.result.isError, undefined);
  assert.equal(JSON.parse(complete.text).files.length, MAX_COMMIT_FILES);
  const excessive = commitMetadataMock([...files, metadataFile("extra")]);
  const result = await callTool(excessive.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT });
  assert.equal(errorCode(result.text), "COMMIT_OUTPUT_LIMIT");
  assert.equal(parseToolErrorFields(result.text).result, "null");
  assert.equal(excessive.calls.length, 1);
  const ceiling = commitMetadataMock(files);
  ceiling.pages[0].link = ceiling.pages[0].link!.replace("&page=10>", "&page=30>");
  assert.equal(errorCode((await callTool(ceiling.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT })).text), "COMMIT_OUTPUT_LIMIT");
});

test("get_commit_metadata counts diagnostics in its serialized UTF-8 output budget", async () => {
  assert.equal(MAX_COMMIT_OUTPUT_BYTES, 131_072);
  const files = Array.from({ length: 150 }, (_, n) => ({ path: `f${n}${"x".repeat(500)}`, status: "modified", additions: 0, deletions: 0 }));
  const payload = { commit_sha: FULL_COMMIT, parent_shas: [METADATA_PARENT_SHA], author_date: METADATA_DATE, committer_date: METADATA_DATE, files };
  let remaining = MAX_COMMIT_OUTPUT_BYTES - 100 - Buffer.byteLength(JSON.stringify(payload, null, 2));
  for (const file of files) {
    const growth = Math.min(1024 - file.path.length, remaining);
    file.path += "x".repeat(growth);
    remaining -= growth;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(payload, null, 2)) < MAX_COMMIT_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...payload, ...new ObservationContext(OBSERVATION_ENV, () => 0).snapshot() }, null, 2)) > MAX_COMMIT_OUTPUT_BYTES);
  const mock = commitMetadataMock(files.map(({ path, ...file }) => ({ filename: path, ...file })));
  const result = await callTool(mock.fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT }, { env: OBSERVATION_ENV });
  assert.equal(errorCode(result.text), "COMMIT_OUTPUT_LIMIT");
  assert.equal(parseToolErrorFields(result.text).result, "null");
  assertTextObservation(parseToolErrorFields(result.text), true, "succeeded");
});

test("get_commit_metadata uses injected bindings, GET only and safe network errors", async () => {
  const mock = commitMetadataMock([], { binding: { owner: "injected-owner", repo: "injected-repo" } });
  const observation = new ObservationContext(OBSERVATION_ENV);
  const client = new GitHubClient("injected-secret", mock.fetcher, "test-version", observation, { owner: "injected-owner", repo: "injected-repo" });
  const result = await callServiceTool(client, "test-version", "get_commit_metadata", { commit_sha: FULL_COMMIT }, observation);
  assert.deepEqual(JSON.parse(result.content[0].text).files, []);
  assert.ok(mock.calls.every((call) => call.method === "GET" && call.authorization === "Bearer injected-secret" && call.path.startsWith("/repos/injected-owner/injected-repo/")));
  const cases: Array<[FetchLike, string, string]> = [
    [async () => new Response(JSON.stringify({ message: "Bearer secret-sentinel" }), { status: 404 }), "COMMIT_NOT_FOUND", "upstream_not_found"],
    [async () => { throw new Error("Bearer secret-sentinel"); }, "GITHUB_NETWORK_ERROR", "upstream_error"],
  ];
  for (const [fetcher, code, outcome] of cases) {
    const failed = await callTool(fetcher, "get_commit_metadata", { commit_sha: FULL_COMMIT }, { env: OBSERVATION_ENV });
    assert.equal(errorCode(failed.text), code);
    assert.equal(parseToolErrorFields(failed.text).result, "null");
    assertTextObservation(parseToolErrorFields(failed.text), true, outcome);
    assert.doesNotMatch(failed.text, /Bearer|secret-sentinel/);
  }
});

const DIRECTORY_ROOT_SHA = "d".repeat(40);

function directoryReadMock(
  entries: unknown[],
  binding = { owner: "fixture-owner", repo: "secondary-repository" },
) {
  const prefix = `/repos/${binding.owner}/${binding.repo}`;
  const replies = new Map<string, unknown>([
    [`/git/commits/${FULL_COMMIT}`, { sha: FULL_COMMIT, tree: { sha: DIRECTORY_ROOT_SHA } }],
    [`/git/trees/${DIRECTORY_ROOT_SHA}`, { sha: DIRECTORY_ROOT_SHA, truncated: false, tree: entries }],
  ]);
  const calls: Array<{ path: string; method: string; authorization: string | null }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(url.pathname.startsWith(prefix + "/"));
    assert.equal(url.search, "", "directory requests must not enable recursive traversal");
    const path = url.pathname.slice(prefix.length);
    const method = init?.method ?? "GET";
    assert.equal(method, "GET");
    calls.push({ path: url.pathname, method, authorization: new Headers(init?.headers).get("authorization") });
    assert.ok(replies.has(path), `unexpected directory request: ${path}`);
    return new Response(JSON.stringify(replies.get(path)));
  };
  return { fetcher, calls, replies };
}

function directoryFile(path: string, size = 1) {
  return { path, mode: "100644", type: "blob", sha: "b".repeat(40), size };
}

test("list_directory sorts a single layer by UTF-8 path bytes independently of upstream order", async () => {
  const files = ["é.txt", "e\u0301.txt", "a.txt", "A.txt", "😀.txt", "\ue000.txt"].map((name) => directoryFile(name, 17));
  const entries = [...files, { path: "nested", mode: "040000", type: "tree", sha: "e".repeat(40) }];
  const expectedPaths = entries.map((entry) => entry.path)
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  let previous: unknown;
  for (const source of [entries, [...entries].reverse()]) {
    const mock = directoryReadMock(source);
    const result = await callTool(mock.fetcher, "list_directory", { commit_sha: FULL_COMMIT.toUpperCase() }, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, undefined);
    assert.equal(result.result.content.length, 1);
    assertTextOnly(result.result);
    const payload = JSON.parse(result.text);
    assert.equal(payload.path, "");
    assert.equal(payload.commit_sha, FULL_COMMIT);
    assert.deepEqual(payload.entries.map((entry: any) => entry.path), expectedPaths);
    for (const entry of payload.entries) {
      assert.equal(entry.name, entry.path);
      assert.deepEqual(Object.keys(entry).sort(), entry.type === "file"
        ? ["blob_sha", "byte_length", "name", "path", "type"] : ["name", "path", "type"]);
      if (entry.type === "file") {
        assert.equal(entry.blob_sha, "b".repeat(40));
        assert.equal(entry.byte_length, 17);
      } else assert.equal(entry.type, "directory");
    }
    if (previous) assert.deepEqual(payload.entries, previous);
    previous = payload.entries;
    assertJsonObservation(payload, true, "succeeded");
    assert.doesNotMatch(result.text, /chunk_bytes|GITHUB_FILE_TEXT|---BEGIN FILE/);
    assert.deepEqual(mock.calls.map(({ path }) => path), [
      `/repos/fixture-owner/secondary-repository/git/commits/${FULL_COMMIT}`,
      `/repos/fixture-owner/secondary-repository/git/trees/${DIRECTORY_ROOT_SHA}`,
    ]);
  }
});

test("list_directory preserves an NFD filename byte-for-byte from the runtime corpus Git tree", async (t) => {
  const corpus = createCorpusRepository();
  t.after(() => rm(corpus.directory, { recursive: true, force: true }));
  const listing = spawnSync("git", ["ls-tree", "-z", "-l", `${corpus.commit}:probes/synthetic-readpath-v1/files`], {
    cwd: corpus.directory,
  });
  assert.equal(listing.status, 0);
  let expectedName: Buffer | undefined;
  let metadata: string[] | undefined;
  for (let start = 0; start < listing.stdout.length;) {
    const end = listing.stdout.indexOf(0, start);
    assert.ok(end >= 0);
    const record = listing.stdout.subarray(start, end);
    const tab = record.indexOf(9);
    const name = record.subarray(tab + 1);
    if (Buffer.from(name).toString("utf8").startsWith("P12_")) {
      expectedName = Buffer.from(name);
      metadata = Buffer.from(record.subarray(0, tab)).toString("ascii").trim().split(/\s+/);
    }
    start = end + 1;
  }
  assert.ok(expectedName && metadata);
  const name = new TextDecoder("utf-8", { fatal: true }).decode(expectedName);
  assert.notEqual(name, name.normalize("NFC"));
  const mock = directoryReadMock([{
    path: name, mode: metadata[0], type: metadata[1], sha: metadata[2], size: Number(metadata[3]),
  }]);
  const result = await callTool(mock.fetcher, "list_directory", { commit_sha: FULL_COMMIT });
  const [entry] = JSON.parse(result.text).entries;
  assert.deepEqual(Buffer.from(entry.name, "utf8"), expectedName);
  assert.deepEqual(Buffer.from(entry.path, "utf8"), expectedName);
  assert.equal(entry.blob_sha, metadata[2]);
  assert.equal(entry.byte_length, Number(metadata[3]));
});

test("list_directory walks the exact directory path and returns only its immediate children", async () => {
  const childSha = "e".repeat(40);
  const nestedSha = "f".repeat(40);
  const mock = directoryReadMock([{ path: "alpha", mode: "040000", type: "tree", sha: childSha }]);
  mock.replies.set(`/git/trees/${childSha}`, { sha: childSha, truncated: false, tree: [
    { path: "nested", mode: "040000", type: "tree", sha: nestedSha }, directoryFile("sibling.txt"),
  ] });
  mock.replies.set(`/git/trees/${nestedSha}`, { sha: nestedSha, truncated: false, tree: [
    directoryFile("leaf.txt", 0),
    { path: "subdir", mode: "040000", type: "tree", sha: "1".repeat(40) },
  ] });
  const result = await callTool(mock.fetcher, "list_directory", { commit_sha: FULL_COMMIT, path: "alpha/nested" });
  const payload = JSON.parse(result.text);
  assert.equal(payload.path, "alpha/nested");
  assert.deepEqual(payload.entries, [
    { name: "leaf.txt", path: "alpha/nested/leaf.txt", type: "file", blob_sha: "b".repeat(40), byte_length: 0 },
    { name: "subdir", path: "alpha/nested/subdir", type: "directory" },
  ]);
  assert.deepEqual(mock.calls.map(({ path }) => path.split("/").at(-1)), [FULL_COMMIT, DIRECTORY_ROOT_SHA, childSha, nestedSha]);
  const empty = await callTool(directoryReadMock([]).fetcher, "list_directory", { commit_sha: FULL_COMMIT, path: "" });
  assert.deepEqual(JSON.parse(empty.text).entries, []);
});

test("list_directory rejects ref parameters and invalid immutable paths before fetching", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, "INVALID_COMMIT_SHA"], [{ commit_sha: "abc123" }, "SHORT_COMMIT_SHA"],
    [{ commit_sha: "main" }, "REF_NAME_NOT_ALLOWED"],
    ...["owner", "repo", "ref", "recursive"].map((key): [Record<string, unknown>, string] => [
      { commit_sha: FULL_COMMIT, [key]: "unexpected" }, "UNEXPECTED_ARGUMENT",
    ]),
    ...["/", ".", "..", "../directory", "a/../b", "a//b", "a/", "a\nb", null, []].map((path): [Record<string, unknown>, string] => [
      { commit_sha: FULL_COMMIT, path }, "INVALID_PATH",
    ]),
  ];
  for (const [args, expected] of cases) {
    let fetched = false;
    const result = await callTool(async () => { fetched = true; throw new Error("must not fetch"); },
      "list_directory", args, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), expected);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assertTextObservation(parseToolErrorFields(result.text), false, "not_attempted");
    assert.equal(fetched, false);
  }
});

test("list_directory refuses missing paths, non-directories, symlinks and submodules", async () => {
  for (const [entries, path, code] of [
    [[], "missing", "PATH_NOT_FOUND"],
    [[directoryFile("file.txt")], "file.txt", "NOT_A_DIRECTORY"],
    [[{ ...directoryFile("link"), mode: "120000" }], "link", "SYMLINK_NOT_SUPPORTED"],
    [[{ path: "submodule", mode: "160000", type: "commit", sha: FULL_COMMIT }], "submodule", "SUBMODULE_NOT_SUPPORTED"],
  ] as const) {
    const mock = directoryReadMock([...entries]);
    const result = await callTool(mock.fetcher, "list_directory", { commit_sha: FULL_COMMIT, path });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assert.equal(mock.calls.length, 2);
  }
});

test("list_directory fails explicitly on incomplete trees or invalid entry metadata", async () => {
  const invalidTrees = [
    null, {}, { sha: "wrong", truncated: false, tree: [] },
    ...[
      [directoryFile("x", -1)], [directoryFile("x", 1.5)],
      [{ ...directoryFile("x"), size: undefined }], [{ ...directoryFile("x"), sha: "short" }],
      [directoryFile("a/b")], [directoryFile("../x")], [directoryFile("bad\nname")],
      [directoryFile("\ud800")], [directoryFile("same"), directoryFile("same")], [null],
    ].map((tree) => ({ sha: DIRECTORY_ROOT_SHA, truncated: false, tree })),
  ];
  for (const tree of [...invalidTrees, { sha: DIRECTORY_ROOT_SHA, truncated: true, tree: [] }]) {
    const mock = directoryReadMock([]);
    mock.replies.set(`/git/trees/${DIRECTORY_ROOT_SHA}`, tree);
    const result = await callTool(mock.fetcher, "list_directory", { commit_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), tree && "truncated" in tree && tree.truncated === true
      ? "DIRECTORY_TREE_INCOMPLETE" : "GITHUB_TREE_RESPONSE_INVALID");
    assert.equal(parseToolErrorFields(result.text).result, "null");
  }
});

test("list_directory enforces its entry cap without silently truncating", async () => {
  assert.equal(MAX_DIRECTORY_ENTRIES, 1_000);
  const entries = Array.from({ length: MAX_DIRECTORY_ENTRIES }, (_, index) => ({
    path: `d${String(index).padStart(4, "0")}`, mode: "040000", type: "tree", sha: FULL_COMMIT,
  }));
  const complete = await callTool(directoryReadMock(entries).fetcher, "list_directory", { commit_sha: FULL_COMMIT });
  assert.equal(complete.result.isError, undefined);
  assert.equal(JSON.parse(complete.text).entries.length, MAX_DIRECTORY_ENTRIES);
  const excessive = await callTool(directoryReadMock([...entries, { ...entries[0], path: "extra" }]).fetcher,
    "list_directory", { commit_sha: FULL_COMMIT }, { env: OBSERVATION_ENV });
  assert.equal(excessive.result.isError, true);
  assert.equal(errorCode(excessive.text), "DIRECTORY_OUTPUT_LIMIT");
  assert.equal(parseToolErrorFields(excessive.text).result, "null");
  assertTextObservation(parseToolErrorFields(excessive.text), true, "succeeded");
});

test("list_directory includes diagnostics in its serialized UTF-8 output budget", async () => {
  assert.equal(MAX_DIRECTORY_OUTPUT_BYTES, 131_072);
  const entries = Array.from({ length: 100 }, (_, index) => ({
    name: `d${index}${"x".repeat(500)}`, path: `d${index}${"x".repeat(500)}`, type: "directory",
  }));
  const payload = { service_version: "test-version", commit_sha: FULL_COMMIT, path: "", entries };
  let remaining = MAX_DIRECTORY_OUTPUT_BYTES - 100 - Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8");
  for (const entry of entries) {
    const growth = Math.min(1024 - entry.name.length, Math.floor(remaining / 2));
    entry.name += "x".repeat(growth);
    entry.path = entry.name;
    remaining -= growth * 2;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8") < MAX_DIRECTORY_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...payload, ...new ObservationContext(OBSERVATION_ENV, () => 0).snapshot() }, null, 2), "utf8") > MAX_DIRECTORY_OUTPUT_BYTES);
  const mock = directoryReadMock(entries.map(({ name }) => ({ path: name, mode: "040000", type: "tree", sha: FULL_COMMIT })));
  const result = await callTool(mock.fetcher, "list_directory", { commit_sha: FULL_COMMIT }, { env: OBSERVATION_ENV });
  assert.equal(result.result.isError, true);
  assert.equal(errorCode(result.text), "DIRECTORY_OUTPUT_LIMIT");
  assert.equal(parseToolErrorFields(result.text).result, "null");
  assertTextObservation(parseToolErrorFields(result.text), true, "succeeded");
});

test("list_directory uses injected bindings and preserves safe network diagnostics", async () => {
  const mock = directoryReadMock([], { owner: "binding-owner", repo: "binding-repository" });
  const observation = new ObservationContext(OBSERVATION_ENV);
  const client = new GitHubClient("injected-secret", mock.fetcher, "test-version", observation,
    { owner: "binding-owner", repo: "binding-repository" });
  const result = await callServiceTool(client, "test-version", "list_directory", { commit_sha: FULL_COMMIT }, observation);
  assert.deepEqual(JSON.parse(result.content[0].text).entries, []);
  assert.ok(mock.calls.every((call) => call.method === "GET" && call.authorization === "Bearer injected-secret"));
  const cases: Array<[FetchLike, string, string]> = [
    [async () => new Response(JSON.stringify({ message: "Bearer sensitive-sentinel https://secret.invalid/path" }), { status: 404 }), "COMMIT_NOT_FOUND", "upstream_not_found"],
    [async () => { throw new Error("Bearer sensitive-sentinel"); }, "GITHUB_NETWORK_ERROR", "upstream_error"],
  ];
  for (const [fetcher, code, outcome] of cases) {
    const failed = await callTool(fetcher, "list_directory", { commit_sha: FULL_COMMIT }, { env: OBSERVATION_ENV });
    assert.equal(errorCode(failed.text), code);
    assertTextObservation(parseToolErrorFields(failed.text), true, outcome);
    assert.doesNotMatch(failed.text, /Bearer|sensitive|secret\.invalid/);
  }
});

const TREE_TEST_BINDING = { owner: "fixture-owner", repo: "primary-repository" };

function treeReadMock(entries: unknown[]) {
  const replies = new Map<string, unknown>([
    [`/git/commits/${FULL_COMMIT}`, { sha: FULL_COMMIT, tree: { sha: DIRECTORY_ROOT_SHA } }],
    [`/git/trees/${DIRECTORY_ROOT_SHA}?recursive=1`, { sha: DIRECTORY_ROOT_SHA, truncated: false, tree: entries }],
  ]);
  const calls: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const prefix = `/repos/${TREE_TEST_BINDING.owner}/${TREE_TEST_BINDING.repo}`;
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(url.pathname.startsWith(prefix + "/"));
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer primary-outbound-test-token");
    const key = url.pathname.slice(prefix.length) + url.search;
    calls.push(key);
    assert.ok(replies.has(key), `unexpected tree request: ${key}`);
    return new Response(JSON.stringify(replies.get(key)));
  };
  return { fetcher, replies, calls };
}

async function callListing(fetcher: FetchLike, name: string, args: Record<string, unknown>) {
  const response = await rpc(fetcher, "tools/call", { name, arguments: args }, {
    pathname: "/primary/mcp", authorization: "Bearer primary-inbound-test-token",
    env: { ...prefixTestEnv(), ...OBSERVATION_ENV, SERVICE_VERSION: "test-version" },
  });
  assert.equal(response.status, 200);
  const { result } = await response.json() as any;
  assertTextOnly(result);
  assert.equal(result.content.length, 1);
  return { result, text: result.content[0].text as string };
}

function treeDirectory(path: string, sha = FULL_COMMIT) {
  return { path, type: "tree", mode: "040000", sha };
}

test("list_tree schema fixes recursion, immutable input, local budgets and read-only annotations", async () => {
  const response = await rpc(async () => { throw new Error("must not fetch"); }, "tools/list");
  const { tools } = (await response.json() as any).result;
  const tree = tools.find((tool: any) => tool.name === "list_tree");
  const directory = tools.find((tool: any) => tool.name === "list_directory");
  assert.deepEqual(tree.annotations, directory.annotations);
  assert.deepEqual(tree.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tree.inputSchema.required, ["commit_sha"]);
  assert.deepEqual(Object.keys(tree.inputSchema.properties).sort(), ["commit_sha", "max_depth", "path"]);
  assert.equal(tree.inputSchema.additionalProperties, false);
  assert.equal(tree.inputSchema.properties.commit_sha.pattern, "^[0-9a-fA-F]{40}$");
  assert.deepEqual(tree.inputSchema.properties.path, directory.inputSchema.properties.path);
  assert.equal(tree.inputSchema.properties.max_depth.type, "integer");
  assert.equal(tree.inputSchema.properties.max_depth.minimum, 1);
  assert.equal(Object.hasOwn(tree.inputSchema.properties.max_depth, "default"), false);
  assert.match(tree.description, /TREE_INCOMPLETE.*TREE_OUTPUT_LIMIT/);
  assert.match(tree.description, /path or max_depth to stay within local output budgets/);
  assert.match(directory.description, /Symlinks and submodules are returned without blob_sha or byte_length/);
});

test("both listing tools return all four entry types without dereferencing special entries", async () => {
  const entries = [
    directoryFile("file", 0), { ...directoryFile("exec"), mode: "100755" }, treeDirectory("dir"),
    { path: "link", mode: "120000", type: "blob", sha: FULL_COMMIT },
    { path: "module", mode: "160000", type: "commit", sha: FULL_COMMIT, size: 123 },
  ];
  let previous: unknown;
  for (const name of ["list_directory", "list_tree"]) {
    const mock = treeReadMock(entries);
    mock.replies.set(`/git/trees/${DIRECTORY_ROOT_SHA}`, { sha: DIRECTORY_ROOT_SHA, truncated: false, tree: entries });
    const result = await callListing(mock.fetcher, name, { commit_sha: FULL_COMMIT });
    assert.equal(result.result.isError, undefined);
    const payload = JSON.parse(result.text);
    assertJsonObservation(payload, true, "succeeded");
    assert.deepEqual([...new Set(payload.entries.map((entry: any) => entry.type))].sort(), ["directory", "file", "submodule", "symlink"]);
    for (const entry of payload.entries) {
      assert.deepEqual(Object.keys(entry).sort(), [
        name === "list_tree" ? "depth" : "name", "path", "type",
        ...(entry.type === "file" ? ["blob_sha", "byte_length"] : []),
      ].sort());
    }
    const common = payload.entries.map(({ name: _name, depth: _depth, ...entry }: any) => entry);
    if (previous) assert.deepEqual(common, previous);
    previous = common;
    assert.equal(mock.calls.length, 2);
    assert.doesNotMatch(result.text, /chunk_bytes|GITHUB_FILE_TEXT|---BEGIN FILE/);
  }
});

test("list_tree sorts full UTF-8 paths, preserves Unicode, and counts depth relative to the root", async () => {
  const entries = [treeDirectory("nested"), treeDirectory("nested/deeper"),
    directoryFile("nested/deeper/leaf", 0),
    ...["é", "e\u0301", "😀", "\ue000", "A", "a", "nested/e\u0301"].map((path) => directoryFile(path, 17)),
  ];
  const expected = entries.map(({ path }) => path).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  let previous: unknown;
  for (const order of [entries, [...entries].reverse()]) {
    const mock = treeReadMock(order);
    const result = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT.toUpperCase() });
    assert.equal(result.result.isError, undefined);
    const payload = JSON.parse(result.text);
    assert.equal(payload.commit_sha, FULL_COMMIT);
    assert.equal(payload.path, "");
    assert.deepEqual(payload.entries.map((entry: any) => entry.path), expected);
    for (const entry of payload.entries) assert.equal(entry.depth, entry.path.split("/").length);
    if (previous) assert.deepEqual(payload.entries, previous);
    previous = payload.entries;
    assert.deepEqual(mock.calls, [`/git/commits/${FULL_COMMIT}`, `/git/trees/${DIRECTORY_ROOT_SHA}?recursive=1`]);
  }
  const shallow = await callListing(treeReadMock(entries).fetcher, "list_tree", { commit_sha: FULL_COMMIT, max_depth: 1 });
  assert.deepEqual(JSON.parse(shallow.text).entries.map((entry: any) => entry.path), expected.filter((path) => !path.includes("/")));
  const empty = await callListing(treeReadMock([]).fetcher, "list_tree", { commit_sha: FULL_COMMIT, path: "" });
  assert.deepEqual(JSON.parse(empty.text).entries, []);
});

test("list_tree resolves the exact subtree before recursion and applies max_depth relative to path", async () => {
  const outerSha = "e".repeat(40), innerSha = "f".repeat(40);
  const path = "目录/e\u0301";
  const mock = treeReadMock([]);
  mock.replies.set(`/git/trees/${DIRECTORY_ROOT_SHA}`, { sha: DIRECTORY_ROOT_SHA, truncated: false,
    tree: [treeDirectory("目录", outerSha), treeDirectory("目录-sibling")] });
  mock.replies.set(`/git/trees/${outerSha}`, { sha: outerSha, truncated: false,
    tree: [treeDirectory("e\u0301", innerSha), treeDirectory("é")] });
  mock.replies.set(`/git/trees/${innerSha}?recursive=1`, { sha: innerSha, truncated: false,
    tree: [treeDirectory("child"), directoryFile("child/deep"), directoryFile("file")] });
  const result = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT, path, max_depth: 1 });
  const payload = JSON.parse(result.text);
  assert.equal(payload.path, path);
  assert.deepEqual(payload.entries, [
    { path: `${path}/child`, type: "directory", depth: 1 },
    { path: `${path}/file`, type: "file", blob_sha: "b".repeat(40), byte_length: 1, depth: 1 },
  ]);
  assert.deepEqual(mock.calls, [`/git/commits/${FULL_COMMIT}`, `/git/trees/${DIRECTORY_ROOT_SHA}`,
    `/git/trees/${outerSha}`, `/git/trees/${innerSha}?recursive=1`]);
});

test("list_tree rejects invalid SHA, path, depth and forbidden parameters before fetching", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, "INVALID_COMMIT_SHA"], [{ commit_sha: "abc123" }, "SHORT_COMMIT_SHA"],
    [{ commit_sha: "main" }, "REF_NAME_NOT_ALLOWED"], [{ commit_sha: "refs/heads/main" }, "REF_NAME_NOT_ALLOWED"],
    ...["owner", "repo", "ref", "recursive", "chunk_bytes"].map((key): [Record<string, unknown>, string] => [
      { commit_sha: FULL_COMMIT, [key]: true }, "UNEXPECTED_ARGUMENT",
    ]),
    ...[null, [], "/", ".", "..", "a/../b", "a//b", "a/", "a\nb"].map((path): [Record<string, unknown>, string] => [
      { commit_sha: FULL_COMMIT, path }, "INVALID_PATH",
    ]),
    ...[0, -1].map((max_depth): [Record<string, unknown>, string] => [
      { commit_sha: FULL_COMMIT, max_depth }, "INVALID_MAX_DEPTH",
    ]),
    ...[null, "1", true, 1.5, Number.MAX_SAFE_INTEGER + 1].map((max_depth): [Record<string, unknown>, string] => [
      { commit_sha: FULL_COMMIT, max_depth }, "INVALID_INTEGER",
    ]),
  ];
  for (const [args, code] of cases) {
    let fetched = false;
    const result = await callListing(async () => { fetched = true; throw new Error("must not fetch"); }, "list_tree", args);
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assertTextObservation(parseToolErrorFields(result.text), false, "not_attempted");
    assert.equal(fetched, false);
  }
});

test("list_tree refuses missing directories and traversal through file or special entries", async () => {
  for (const [entry, path, code] of [
    [treeDirectory("other"), "missing", "PATH_NOT_FOUND"],
    [directoryFile("file"), "file", "NOT_A_DIRECTORY"],
    [{ ...directoryFile("link"), mode: "120000" }, "link", "SYMLINK_NOT_SUPPORTED"],
    [{ ...directoryFile("link"), mode: "120000" }, "link/child", "SYMLINK_NOT_SUPPORTED"],
    [{ path: "module", type: "commit", mode: "160000", sha: FULL_COMMIT }, "module", "SUBMODULE_NOT_SUPPORTED"],
  ] as const) {
    const mock = treeReadMock([]);
    mock.replies.set(`/git/trees/${DIRECTORY_ROOT_SHA}`, { sha: DIRECTORY_ROOT_SHA, truncated: false, tree: [entry] });
    const result = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT, path });
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assert.equal(mock.calls.length, 2);
  }
});

test("list_tree rejects malformed trees, duplicates, dangling children and invalid file metadata", async () => {
  const invalid = [null, {}, { sha: FULL_COMMIT, truncated: false, tree: [] },
    ...[
      [null], [directoryFile("x", -1)], [directoryFile("x", 1.5)],
      [{ ...directoryFile("x"), size: undefined }], [{ ...directoryFile("x"), sha: "short" }],
      [directoryFile("x"), directoryFile("x")], [directoryFile("\ud800")], [directoryFile("../x")],
      [directoryFile("x\ny")], [directoryFile("x/y")], [directoryFile("x"), directoryFile("x/y")],
      [{ ...directoryFile("link"), mode: "120000", type: "tree" }],
      [{ path: "module", mode: "160000", type: "blob", sha: FULL_COMMIT }],
      [{ ...directoryFile("x"), mode: "100664" }],
    ].map((tree) => ({ sha: DIRECTORY_ROOT_SHA, truncated: false, tree })),
  ];
  for (const tree of invalid) {
    const mock = treeReadMock([]);
    mock.replies.set(`/git/trees/${DIRECTORY_ROOT_SHA}?recursive=1`, tree);
    const result = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT });
    assert.equal(errorCode(result.text), "GITHUB_TREE_RESPONSE_INVALID");
    assert.equal(parseToolErrorFields(result.text).result, "null");
  }
});

test("list_tree distinguishes upstream truncation from local entry limits, never returning partial lists", async () => {
  assert.equal(MAX_TREE_ENTRIES, 5_000);
  const entries = Array.from({ length: MAX_TREE_ENTRIES }, (_, index) => treeDirectory(`d${index}`));
  const mock = treeReadMock(entries);
  const observation = new ObservationContext(OBSERVATION_ENV);
  const client = new GitHubClient("primary-outbound-test-token", mock.fetcher, "test-version", observation, TREE_TEST_BINDING);
  // Isolate the entry boundary from the independent serialized byte boundary.
  assert.equal((await client.listTree("", FULL_COMMIT)).length, MAX_TREE_ENTRIES);
  entries.push(treeDirectory("extra"));
  const limited = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT });
  assert.equal(errorCode(limited.text), "TREE_OUTPUT_LIMIT");
  assert.equal(parseToolErrorFields(limited.text).result, "null");
  for (const max_depth of [undefined, 1]) {
    mock.replies.set(`/git/trees/${DIRECTORY_ROOT_SHA}?recursive=1`, { sha: DIRECTORY_ROOT_SHA, truncated: true, tree: entries });
    const incomplete = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT, max_depth });
    assert.equal(errorCode(incomplete.text), "TREE_INCOMPLETE");
    assert.equal(parseToolErrorFields(incomplete.text).result, "null");
    assertTextObservation(parseToolErrorFields(incomplete.text), true, "succeeded");
  }
  mock.replies.set(`/git/trees/${DIRECTORY_ROOT_SHA}`, { sha: DIRECTORY_ROOT_SHA, truncated: true, tree: [] });
  const ancestor = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT, path: "child" });
  assert.equal(errorCode(ancestor.text), "TREE_INCOMPLETE");
});

test("list_tree depth selection avoids local entry overflow without silently truncating", async () => {
  const entries = [treeDirectory("parent"), ...Array.from({ length: MAX_TREE_ENTRIES }, (_, index) => directoryFile(`parent/f${index}`))];
  const result = await callListing(treeReadMock(entries).fetcher, "list_tree", { commit_sha: FULL_COMMIT, max_depth: 1 });
  assert.deepEqual(JSON.parse(result.text).entries, [{ path: "parent", type: "directory", depth: 1 }]);
});

test("list_tree applies an inclusive UTF-8 text budget including diagnostics and excludes JSON-RPC", async () => {
  assert.equal(MAX_TREE_OUTPUT_BYTES, 131_072);
  async function render(entries: unknown[]) {
    const observation = new ObservationContext(OBSERVATION_ENV, () => 0);
    const mock = treeReadMock(entries);
    const client = new GitHubClient("primary-outbound-test-token", mock.fetcher, "test-version", observation, TREE_TEST_BINDING);
    return callServiceTool(client, "test-version", "list_tree", { commit_sha: FULL_COMMIT }, observation);
  }
  const base = JSON.parse((await render([])).content[0].text);
  const projected = Array.from({ length: 160 }, (_, index) => ({ path: `d${index}é${"x".repeat(700)}`, type: "directory", depth: 1 }));
  const expected = { ...base, entries: projected };
  let remaining = MAX_TREE_OUTPUT_BYTES - Buffer.byteLength(JSON.stringify(expected, null, 2));
  assert.ok(remaining > 0);
  for (const entry of projected) {
    const growth = Math.min(1024 - entry.path.length, remaining);
    entry.path += "x".repeat(growth);
    remaining -= growth;
  }
  assert.equal(remaining, 0);
  const exact = projected.map(({ path }) => treeDirectory(path));
  const result = await render(exact);
  assert.equal(Buffer.byteLength(result.content[0].text), MAX_TREE_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result })) > MAX_TREE_OUTPUT_BYTES);
  exact.at(-1)!.path += "x";
  await assert.rejects(render(exact), { code: "TREE_OUTPUT_LIMIT", httpStatus: 413 });
  const overflow = await callListing(treeReadMock(exact).fetcher, "list_tree", { commit_sha: FULL_COMMIT });
  assert.equal(errorCode(overflow.text), "TREE_OUTPUT_LIMIT");
  assert.equal(parseToolErrorFields(overflow.text).result, "null");
  const withoutDiagnostics = { service_version: base.service_version, commit_sha: FULL_COMMIT, path: "", entries: exact.map(({ path }) => ({ path, type: "directory", depth: 1 })) };
  assert.ok(Buffer.byteLength(JSON.stringify(withoutDiagnostics, null, 2)) < MAX_TREE_OUTPUT_BYTES);
});

test("list_tree validates commit identity and preserves safe upstream failure diagnostics", async () => {
  for (const commit of [null, {}, { sha: FULL_COMMIT, tree: { sha: "short" } }, { sha: "f".repeat(40), tree: { sha: DIRECTORY_ROOT_SHA } }]) {
    const mock = treeReadMock([]);
    mock.replies.set(`/git/commits/${FULL_COMMIT}`, commit);
    const result = await callListing(mock.fetcher, "list_tree", { commit_sha: FULL_COMMIT });
    assert.equal(errorCode(result.text), "GITHUB_COMMIT_RESPONSE_INVALID");
    assert.equal(mock.calls.length, 1);
  }
  const cases: Array<[FetchLike, string, string]> = [
    [async () => new Response('{"message":"Bearer secret-sentinel"}', { status: 404 }), "COMMIT_NOT_FOUND", "upstream_not_found"],
    [async () => { throw new Error("Bearer secret-sentinel"); }, "GITHUB_NETWORK_ERROR", "upstream_error"],
  ];
  for (const [fetcher, code, outcome] of cases) {
    const result = await callListing(fetcher, "list_tree", { commit_sha: FULL_COMMIT });
    assert.equal(errorCode(result.text), code);
    assertTextObservation(parseToolErrorFields(result.text), true, outcome);
    assert.doesNotMatch(result.text, /Bearer|secret-sentinel/);
    assert.equal(parseToolErrorFields(result.text).result, "null");
  }
});

function indexItem(path = "src/bindings.ts", repository = "fixture-owner/primary-repository") {
  return { path, sha: "c".repeat(40), repository: { full_name: repository },
    text_matches: [{ fragment: "private upstream snippet must never be returned" }], html_url: "https://secret.invalid" };
}

function indexReadMock(options: {
  prefix?: "primary" | "secondary"; payload?: unknown; status?: number; headers?: Record<string, string>;
} = {}) {
  const prefix = options.prefix ?? "primary";
  const calls: Array<{ url: URL; method: string }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/search/code");
    assert.equal(init?.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${prefix}-outbound-test-token`);
    assert.equal(new Headers(init.headers).get("accept"), "application/vnd.github+json");
    calls.push({ url, method: init.method });
    return new Response(JSON.stringify(Object.hasOwn(options, "payload") ? options.payload : {
      total_count: 1, incomplete_results: false,
      items: [indexItem("src/bindings.ts", `fixture-owner/${prefix === "primary" ? "primary-repository" : "secondary-repository"}`)],
    }), { status: options.status ?? 200, headers: options.headers });
  };
  return { fetcher, calls };
}

async function callIndex(fetcher: FetchLike, args: Record<string, unknown>, prefix = "primary") {
  const response = await rpc(fetcher, "tools/call", { name: "search_repo_index", arguments: args }, {
    pathname: `/${prefix}/mcp`, authorization: `Bearer ${prefix}-inbound-test-token`,
    env: { ...prefixTestEnv(), ...OBSERVATION_ENV, SERVICE_VERSION: "test-version" },
  });
  assert.equal(response.status, 200);
  const { result } = await response.json() as any;
  assertTextOnly(result);
  assert.equal(result.content.length, 1);
  return { result, text: result.content[0].text as string };
}

test("search_repo_index schema describes unanchored evidence, verification and bounded single-page search", async () => {
  const response = await rpc(async () => { throw new Error("must not fetch"); }, "tools/list");
  const tools = (await response.json() as any).result.tools;
  const search = tools.find((tool: any) => tool.name === "search_repo_index");
  assert.deepEqual(search.annotations, tools.find((tool: any) => tool.name === "list_tree").annotations);
  assert.deepEqual(search.inputSchema.required, ["query"]);
  assert.deepEqual(Object.keys(search.inputSchema.properties), ["query", "max_results"]);
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(search.inputSchema.properties.query.maxLength, 256);
  assert.deepEqual(search.inputSchema.properties.max_results, { type: "integer", minimum: 1, maximum: 100, default: 30 });
  assert.doesNotMatch(JSON.stringify(search.inputSchema), /"owner"|"repo"|"commit_sha"/);
  assert.match(search.description, /index_scope is default_branch, anchored is false, and verification_required is true/);
  assert.match(search.description, /list_tree or stat_file.*compare.*indexed_blob_sha/);
  assert.match(search.description, /If equal.*trustworthy.*If different.*search_in_file/);
  assert.match(search.description, /eventually consistent.*cannot be pinned/);
  assert.match(search.description, /INDEX_SEARCH_RATE_LIMITED.*INDEX_QUERY_INVALID.*INDEX_SEARCH_UNSUPPORTED/);
});

test("search_repo_index uses each injected binding and returns positions and indexed SHA with one request", async () => {
  const query = '  "e\u0301 phrase" language:TypeScript  ';
  for (const binding of PREFIX_CASES) {
    const mock = indexReadMock({ prefix: binding.prefix });
    const result = await callIndex(mock.fetcher, { query }, binding.prefix);
    assert.equal(result.result.isError, undefined);
    const payload = JSON.parse(result.text);
    assert.equal(payload.index_scope, "default_branch");
    assert.equal(payload.anchored, false);
    assert.equal(payload.verification_required, true);
    assert.equal(payload.total_count, 1);
    assert.equal(payload.incomplete_results, false);
    assert.equal(payload.has_more, false);
    assert.deepEqual(payload.items, [{ path: "src/bindings.ts", indexed_blob_sha: "c".repeat(40) }]);
    assertJsonObservation(payload, true, "succeeded");
    assert.doesNotMatch(result.text, /private upstream|secret\.invalid|text_matches|chunk_bytes|---BEGIN FILE/);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url.searchParams.get("q"), `${query} repo:fixture-owner/${binding.repository}`);
    assert.deepEqual([...mock.calls[0].url.searchParams.keys()].sort(), ["page", "per_page", "q"]);
    assert.equal(mock.calls[0].url.searchParams.get("per_page"), "30");
    assert.equal(mock.calls[0].url.searchParams.get("page"), "1");
  }
});

test("search_repo_index preserves upstream ranking, Unicode paths and exact query while normalizing SHA case", async () => {
  const items = [indexItem("z"), { ...indexItem("e\u0301"), sha: "A".repeat(40) }, indexItem("é")];
  const mock = indexReadMock({ payload: { total_count: 3, incomplete_results: false, items } });
  const query = "x&per_page=100?query=é+%23";
  const result = await callIndex(mock.fetcher, { query, max_results: 3 });
  assert.deepEqual(JSON.parse(result.text).items, items.map(({ path, sha }) => ({ path, indexed_blob_sha: sha.toLowerCase() })));
  assert.equal(mock.calls[0].url.searchParams.get("q"), `${query} repo:fixture-owner/primary-repository`);
  assert.equal(mock.calls[0].url.searchParams.get("per_page"), "3");
  assert.equal(mock.calls.length, 1);
});

test("search_repo_index rejects invalid query shapes, scope overrides and unexpected arguments before fetching", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    ...[undefined, null, [], 1, "", "  ", "a".repeat(257), "😀".repeat(257), "\ud800", "x\ny", "x\u2028y",
      '"unterminated', 'trailing\\', "x repo:other/repo", "x OR REPO:other/repo", "x -repo:a/b",
      "x org:other", "x user:other", '"repo:other/repo"', "x repo :other/repo",
    ].map((query): [Record<string, unknown>, string] => [{ query }, "INDEX_QUERY_INVALID"]),
    ...["owner", "repo", "commit_sha", "ref", "page", "recursive"].map((key): [Record<string, unknown>, string] => [
      { query: "term", [key]: "unexpected" }, "UNEXPECTED_ARGUMENT",
    ]),
    ...[0, -1, 101].map((max_results): [Record<string, unknown>, string] => [{ query: "term", max_results }, "INVALID_MAX_RESULTS"]),
    ...[null, "1", true, 1.5, Number.MAX_SAFE_INTEGER + 1].map((max_results): [Record<string, unknown>, string] => [
      { query: "term", max_results }, "INVALID_INTEGER",
    ]),
  ];
  for (const [args, code] of cases) {
    let attempts = 0;
    const result = await callIndex(async () => { attempts++; throw new Error("must not fetch"); }, args);
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assertTextObservation(parseToolErrorFields(result.text), false, "not_attempted");
    assert.equal(attempts, 0);
  }
  for (const query of ["a".repeat(256), "😀".repeat(256), '"escaped \\" phrase"']) {
    const mock = indexReadMock();
    const result = await callIndex(mock.fetcher, { query, max_results: 100 });
    assert.equal(result.result.isError, undefined);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url.searchParams.get("q"), `${query} repo:fixture-owner/primary-repository`);
  }
});

test("search_repo_index exposes incomplete and capped results without paging or claiming anchored absence", async () => {
  for (const [total_count, incomplete_results, items] of [
    [20, false, [indexItem()]], [1, true, [indexItem()]], [0, false, []], [0, true, []],
  ] as const) {
    const mock = indexReadMock({ payload: { total_count, incomplete_results, items }, headers: { link: '<https://api.github.com/search/code?page=2>; rel="next"' } });
    const result = await callIndex(mock.fetcher, { query: "term", max_results: 1 });
    const payload = JSON.parse(result.text);
    assert.equal(payload.incomplete_results, incomplete_results);
    assert.equal(payload.has_more, total_count > items.length);
    assert.equal(payload.anchored, false);
    assert.equal(payload.verification_required, true);
    assert.equal(mock.calls.length, 1);
  }
});

test("search_repo_index never exposes malformed, cross-repository or duplicate index entries", async () => {
  const invalidItems = [null, {}, { ...indexItem(), sha: "short" }, { ...indexItem(), sha: undefined },
    { ...indexItem(), path: "../x" }, { ...indexItem(), path: "bad\npath" }, { ...indexItem(), path: "\ud800" },
    { ...indexItem(), repository: undefined }, indexItem("foreign", "another-owner/another-repo")];
  const invalid = [null, {}, { total_count: -1, incomplete_results: false, items: [] },
    { total_count: 0.5, incomplete_results: false, items: [] }, { total_count: 0, items: [] },
    { total_count: 0, incomplete_results: false, items: [indexItem()] },
    { total_count: 2, incomplete_results: false, items: [indexItem(), indexItem()] },
    ...invalidItems.map((item) => ({ total_count: 1, incomplete_results: false, items: [item] })),
  ];
  for (const payload of invalid) {
    const mock = indexReadMock({ payload });
    const result = await callIndex(mock.fetcher, { query: "term" });
    assert.equal(errorCode(result.text), "INDEX_SEARCH_RESPONSE_INVALID");
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assert.doesNotMatch(result.text, /foreign|private upstream|another-owner/);
    assert.equal(mock.calls.length, 1);
  }
  const tooMany = indexReadMock({ payload: { total_count: 2, incomplete_results: false, items: [indexItem("a"), indexItem("b")] } });
  assert.equal(errorCode((await callIndex(tooMany.fetcher, { query: "term", max_results: 1 })).text), "INDEX_SEARCH_RESPONSE_INVALID");
});

test("search_repo_index separates binding unsupported, invalid query and code-search quota errors", async () => {
  const cases: Array<[number, unknown, Record<string, string>, string]> = [
    [403, { message: "Resource not accessible by personal access token" }, {}, "INDEX_SEARCH_UNSUPPORTED"],
    [403, { message: "Forbidden" }, { "x-ratelimit-remaining": "9" }, "INDEX_SEARCH_UNSUPPORTED"],
    [422, { message: "Validation Failed", errors: [{ message: "The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them." }] }, {}, "INDEX_SEARCH_UNSUPPORTED"],
    [422, { message: "Resource not accessible by integration" }, {}, "INDEX_SEARCH_UNSUPPORTED"],
    [422, { message: "Code search is not supported for this token" }, {}, "INDEX_SEARCH_UNSUPPORTED"],
    [404, { message: "Not Found" }, {}, "INDEX_SEARCH_UNSUPPORTED"],
    [422, { message: "Validation Failed", errors: [{ message: "The search is longer than 256 characters." }] }, {}, "INDEX_QUERY_INVALID"],
    [422, { message: "Validation Failed" }, {}, "INDEX_QUERY_INVALID"],
    [400, { message: "Invalid query" }, {}, "INDEX_QUERY_INVALID"],
    [403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789021025" }, "INDEX_SEARCH_RATE_LIMITED"],
    [403, { message: "Forbidden" }, { "retry-after": "60" }, "INDEX_SEARCH_RATE_LIMITED"],
    [403, { message: "You have exceeded a secondary rate limit" }, {}, "INDEX_SEARCH_RATE_LIMITED"],
    [422, { message: "This endpoint has been spammed" }, {}, "INDEX_SEARCH_RATE_LIMITED"],
    [429, { message: "Too Many Requests" }, { "retry-after": "60" }, "INDEX_SEARCH_RATE_LIMITED"],
    [401, { message: "Bad credentials" }, {}, "GITHUB_AUTH_FAILED"],
    [500, { message: "upstream failure" }, {}, "GITHUB_UPSTREAM_ERROR"],
  ];
  for (const prefix of ["primary", "secondary"] as const) {
    for (const [status, payload, headers, code] of cases) {
      const mock = indexReadMock({ prefix, status, payload, headers });
      const result = await callIndex(mock.fetcher, { query: "term" }, prefix);
      assert.equal(result.result.isError, true);
      assert.equal(errorCode(result.text), code);
      assert.equal(parseToolErrorFields(result.text).result, "null");
      assertTextObservation(parseToolErrorFields(result.text), true, status === 404 ? "upstream_not_found" : "upstream_error");
      assert.equal(mock.calls.length, 1, "errors must not trigger retries or capability probes");
    }
  }
});

test("search_repo_index reports only validated retry hints and sanitizes upstream errors", async () => {
  const mock = indexReadMock({ status: 429, payload: { message: "Bearer secret-sentinel https://secret.invalid" },
    headers: { "retry-after": "60", "x-ratelimit-reset": "1789021025" } });
  const result = await callIndex(mock.fetcher, { query: "term" });
  assert.match(result.text, /retry_after_seconds=60/);
  assert.match(result.text, /reset_at_unix_seconds=1789021025/);
  assert.doesNotMatch(result.text, /Bearer|secret-sentinel|secret\.invalid/);
  const badHeaders = indexReadMock({ status: 429, headers: { "retry-after": "secret-sentinel", "x-ratelimit-reset": "99999999999999999999999" } });
  const bad = await callIndex(badHeaders.fetcher, { query: "term" });
  assert.doesNotMatch(bad.text, /secret-sentinel|99999999999999999999999|retry_after_seconds=|reset_at_unix_seconds=/);
  const failed = await callIndex(async () => { throw new Error("Bearer secret-sentinel"); }, { query: "term" });
  assert.equal(errorCode(failed.text), "GITHUB_NETWORK_ERROR");
  assertTextObservation(parseToolErrorFields(failed.text), true, "upstream_error");
  assert.doesNotMatch(failed.text, /Bearer|secret-sentinel/);
});

test("search_repo_index hits can be checked against anchored file SHA and stale hits re-searched", async () => {
  const indexedBytes = utf8("needle was here\n");
  const indexedSha = await gitBlobSha(indexedBytes);
  for (const bytes of [indexedBytes, utf8("the word was removed\n")]) {
    const path = "proof.txt";
    const mock = indexReadMock({ prefix: "secondary", payload: { total_count: 1, incomplete_results: false,
      items: [{ ...indexItem(path, "fixture-owner/secondary-repository"), sha: indexedSha }] } });
    const hit = JSON.parse((await callIndex(mock.fetcher, { query: "needle" }, "secondary")).text).items[0];
    assert.equal(mock.calls.length, 1);
    const anchored = await createReadMock([{ path, bytes }]);
    const stat = JSON.parse((await callTool(anchored.fetcher, "stat_file", { path, commit_sha: FULL_COMMIT })).text);
    const sameBytes = stat.blob_sha === hit.indexed_blob_sha;
    assert.equal(sameBytes, bytes === indexedBytes);
    if (!sameBytes) {
      const searched = JSON.parse((await callTool(anchored.fetcher, "search_in_file", {
        path, commit_sha: FULL_COMMIT, pattern: "needle",
      })).text);
      assert.equal(searched.commit_sha, FULL_COMMIT);
      assert.equal(searched.total_matches, 0, "an indexed hit is not evidence of a hit in changed bytes");
    }
  }
});

test("search_repo_index specialization preserves generic GitHub 403 and 422 behavior for other tools", async () => {
  for (const [status, code] of [[403, "GITHUB_FORBIDDEN"], [422, "GITHUB_CONFLICT"]] as const) {
    const result = await callTool(async () => new Response('{"message":"denied"}', { status }), "stat_file", { path: "x", commit_sha: FULL_COMMIT });
    assert.equal(errorCode(result.text), code);
  }
});

test("search_repo_index enforces the inclusive serialized byte budget with diagnostics", async () => {
  assert.equal(MAX_INDEX_OUTPUT_BYTES, 131_072);
  async function render(items: unknown[]) {
    const mock = indexReadMock({ payload: { total_count: items.length, incomplete_results: false, items } });
    const observation = new ObservationContext(OBSERVATION_ENV, () => 0);
    const client = new GitHubClient("primary-outbound-test-token", mock.fetcher, "test-version", observation, TREE_TEST_BINDING);
    return callServiceTool(client, "test-version", "search_repo_index", { query: "term", max_results: 100 }, observation);
  }
  const base = JSON.parse((await render([])).content[0].text);
  const items = Array.from({ length: 100 }, (_, i) => indexItem(`p${i}${"é".repeat(400)}`));
  const projected = items.map(({ path, sha }) => ({ path, indexed_blob_sha: sha }));
  const expected = { ...base, total_count: items.length, items: projected };
  let remaining = MAX_INDEX_OUTPUT_BYTES - Buffer.byteLength(JSON.stringify(expected, null, 2));
  assert.ok(remaining > 0);
  for (let i = 0; i < items.length; i++) {
    const growth = Math.min(1024 - items[i].path.length, remaining);
    items[i].path += "x".repeat(growth);
    projected[i].path = items[i].path;
    remaining -= growth;
  }
  assert.equal(remaining, 0);
  const result = await render(items);
  assert.equal(Buffer.byteLength(result.content[0].text), MAX_INDEX_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result })) > MAX_INDEX_OUTPUT_BYTES);
  items.at(-1)!.path += "x";
  await assert.rejects(render(items), { code: "INDEX_SEARCH_OUTPUT_LIMIT", httpStatus: 413 });
  const overflow = await callIndex(indexReadMock({ payload: { total_count: items.length, incomplete_results: false, items } }).fetcher,
    { query: "term", max_results: 100 });
  assert.equal(errorCode(overflow.text), "INDEX_SEARCH_OUTPUT_LIMIT");
  assert.equal(parseToolErrorFields(overflow.text).result, "null");
});

test("resolve_ref accepts the advertised ref grammar and rejects cross-repository forms before fetching", async () => {
  const listing = await rpc(async () => { throw new Error("listing must not fetch"); }, "tools/list");
  const tools = (await listing.json() as any).result.tools;
  const schema = tools.find((tool: any) => tool.name === "resolve_ref").inputSchema;
  const pattern = new RegExp(schema.properties.ref.pattern);
  const valid = [
    "main", "v1.2.3", "release-candidate", "résultat", "release😀",
    "refs/heads/main", "refs/heads/feature/x", "refs/tags/release/v1",
  ];
  const invalid: unknown[] = [
    "", null, true, 1, [], {}, "owner/repo", "fixture-owner/secondary-repository",
    "/repos/fixture-owner/secondary-repository", "https://github.com/owner/repo",
    "refs/remotes/origin/main", "refs/other/main", "heads/main", "tags/v1",
    "/main", "main/", "refs/heads/", "refs/tags/", "refs/heads//main",
    "refs/heads/a/", "refs/heads/a//b", "..", "a..b", "../main",
    "refs/heads/a/../b", "a b", "a\tb", "a\nb", "main\n", "a\u0000b",
    "a\u007fb", "a\u0085b", "a\u2028b", "main~1", "main^", "a:b",
    "a?b", "a*b", "a[b", "a\\b", ".hidden", "refs/heads/.hidden/x",
    "a.lock", "refs/tags/a.lock/b", "a.", "refs/heads/a.", "@", "a@{b}",
    "\ud800", "a\udc00b",
  ];
  for (const ref of valid) {
    assert.equal(pattern.test(ref), true, ref);
    const gitRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    assert.equal(spawnSync("git", ["check-ref-format", gitRef]).status, 0, ref);
    const result = await callTool(async () => new Response(JSON.stringify({ sha: FULL_COMMIT })),
      "resolve_ref", { ref }, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, undefined, ref);
    assert.equal(JSON.parse(result.text).ref, ref);
  }
  for (const ref of invalid) {
    assert.equal(typeof ref === "string" && pattern.test(ref), false, JSON.stringify(ref));
    let fetched = false;
    const result = await callTool(async () => {
      fetched = true;
      throw new Error("invalid ref must not fetch");
    }, "resolve_ref", { ref }, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "INVALID_REF", JSON.stringify(ref));
    const fields = parseToolErrorFields(result.text);
    assert.equal(fields.result, "null");
    assertTextObservation(fields, false, "not_attempted");
    assert.equal(fetched, false);
  }
});

test("resolve_ref rejects unsupported parameters and malformed dispatch without fetching", async () => {
  let fetched = false;
  const neverFetch: FetchLike = async () => {
    fetched = true;
    throw new Error("invalid parameters must not fetch");
  };
  for (const args of [
    { owner: "elsewhere" }, { repo: "elsewhere" }, { commit_sha: FULL_COMMIT },
    { ref: "main", path: "README.md" },
  ]) {
    const result = await callTool(neverFetch, "resolve_ref", args, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "UNEXPECTED_ARGUMENT");
    assertTextObservation(parseToolErrorFields(result.text), false, "not_attempted");
  }
  for (const args of [null, [], "main"]) {
    const response = await rpc(neverFetch, "tools/call", { name: "resolve_ref", arguments: args });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).error.code, -32602);
  }
  assert.equal(fetched, false);
});

test("resolve_ref returns the upstream commit SHA and diagnostics without a file envelope", async () => {
  const expected = "1234567890abcdef1234567890abcdef12345678";
  const cases = [
    [{}, "main", "/commits/main"],
    [{ ref: "v1.2.3" }, "v1.2.3", "/commits/v1.2.3"],
    [{ ref: "refs/heads/feature/x" }, "refs/heads/feature/x", "/commits/heads%2Ffeature%2Fx"],
    [{ ref: "refs/tags/release/v1" }, "refs/tags/release/v1", "/commits/tags%2Frelease%2Fv1"],
  ] as const;
  for (const [args, ref, suffix] of cases) {
    const calls: string[] = [];
    const fetcher: FetchLike = async (input, init) => {
      calls.push(new URL(String(input)).pathname);
      assert.equal(init?.method, "GET");
      return new Response(JSON.stringify({ sha: expected.toUpperCase(), files: [{ patch: "not returned" }] }));
    };
    const result = await callTool(fetcher, "resolve_ref", args, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, undefined);
    assert.equal(result.result.content.length, 1);
    assertTextOnly(result.result);
    const receipt = JSON.parse(result.text);
    assert.equal(receipt.ref, ref);
    assert.equal(receipt.commit_sha, expected);
    assert.match(receipt.commit_sha, /^[0-9a-f]{40}$/);
    assertJsonObservation(receipt, true, "succeeded");
    assert.deepEqual(Object.keys(receipt).sort(), [
      "ref", "commit_sha", "deployment_version_id", "deployment_identity_scope",
      "deployment_version_tag", "deployment_version_created_at", "source_commit",
      "observed_elapsed_ms", "observed_elapsed_scope", "observed_elapsed_clock_note",
      "github_fetch_attempted", "github_fetch_outcome",
    ].sort());
    assert.doesNotMatch(result.text, /byte_length|chunk_bytes|GITHUB_FILE_TEXT|---BEGIN FILE|not returned/);
    assert.deepEqual(calls, [`/repos/fixture-owner/secondary-repository${suffix}`]);
  }
});

test("resolve_ref distinguishes missing refs from invalid upstream commit SHA responses", async () => {
  const missing = await callTool(async () => new Response(JSON.stringify({
    message: "Authorization: Bearer sensitive-sentinel https://secret.invalid/path",
  }), { status: 404 }), "resolve_ref", { ref: "missing" }, { env: OBSERVATION_ENV });
  assert.equal(missing.result.isError, true);
  assert.equal(errorCode(missing.text), "REF_NOT_FOUND");
  const missingFields = parseToolErrorFields(missing.text);
  assert.equal(missingFields.result, "null");
  assertTextObservation(missingFields, true, "upstream_not_found");
  assert.doesNotMatch(missing.text, /sensitive|Bearer|secret\.invalid/);
  for (const response of [null, [], {}, { sha: null }, { sha: 123 },
    { sha: "abc123" }, { sha: "g".repeat(40) }, { sha: "a".repeat(41) },
    { sha: FULL_COMMIT + "\n" }, { sha: "Authorization: Bearer sensitive-sentinel" }]) {
    const result = await callTool(async () => new Response(JSON.stringify(response)),
      "resolve_ref", {}, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "GITHUB_COMMIT_RESPONSE_INVALID");
    const fields = parseToolErrorFields(result.text);
    assert.equal(fields.result, "null");
    assertTextObservation(fields, true, "succeeded");
    assert.doesNotMatch(result.text, /sensitive|Bearer|commit_sha:/);
  }
});

test("resolve_ref preserves network diagnostics without leaking credentials or upstream messages", async () => {
  const cases: Array<[FetchLike, string]> = [
    [() => { throw new TypeError("Bearer sensitive-sentinel"); }, "GITHUB_FETCH_INVOCATION_ERROR"],
    [async () => { throw new Error("Bearer sensitive-sentinel"); }, "GITHUB_NETWORK_ERROR"],
    [async () => { throw new DOMException("sensitive-sentinel", "AbortError"); }, "GITHUB_FETCH_ABORTED"],
    [async () => { throw new DOMException("sensitive-sentinel", "TimeoutError"); }, "GITHUB_FETCH_TIMEOUT"],
  ];
  for (const [status, code] of [[401, "GITHUB_AUTH_FAILED"], [403, "GITHUB_FORBIDDEN"],
    [429, "GITHUB_QUOTA_EXCEEDED"], [500, "GITHUB_UPSTREAM_ERROR"]] as const) {
    cases.push([async () => new Response(JSON.stringify({
      message: "Authorization: Bearer sensitive-sentinel https://secret.invalid/path",
    }), { status }), code]);
  }
  for (const [fetcher, expected] of cases) {
    const result = await callTool(fetcher, "resolve_ref", {}, { env: OBSERVATION_ENV });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), expected);
    const fields = parseToolErrorFields(result.text);
    assert.equal(fields.result, "null");
    assertTextObservation(fields, true, "upstream_error");
    assert.doesNotMatch(result.text, /sensitive|Authorization|Bearer|secret\.invalid|local-test-github-token/);
  }
});

test("GitHubClient requires an explicit repository binding at type-check time", () => {
  const fetcher: FetchLike = async () => { throw new Error("Construction must not fetch"); };
  const observation = new ObservationContext(OBSERVATION_ENV);
  const binding = { owner: "binding-owner", repo: "binding-repository" };
  assert.ok(new GitHubClient(GITHUB_TOKEN, fetcher, "test-version", observation, binding));
  // Compile-only negative cases: an optional/default binding makes these directives fail tsc.
  if (false) {
    // @ts-expect-error The repository binding must not be omitted.
    new GitHubClient(GITHUB_TOKEN, fetcher, "test-version", observation);
    // @ts-expect-error Explicit undefined must not select an implicit repository.
    new GitHubClient(GITHUB_TOKEN, fetcher, "test-version", observation, undefined);
  }
});

test("resolve_ref uses its injected repository binding and issues only the expected GET", async () => {
  const calls: string[] = [];
  const observation = new ObservationContext(OBSERVATION_ENV);
  const client = new GitHubClient("injected-secret", async (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer injected-secret");
    calls.push(`${init?.method} ${input}`);
    return new Response(JSON.stringify({ sha: FULL_COMMIT }));
  }, "test-version", observation, { owner: "binding-owner", repo: "binding-repository" });
  const result = await callServiceTool(client, "test-version", "resolve_ref", {
    ref: "refs/heads/feature/x",
  }, observation);
  assert.equal(JSON.parse(result.content[0].text).commit_sha, FULL_COMMIT);
  assert.deepEqual(calls, [
    "GET https://api.github.com/repos/binding-owner/binding-repository/commits/heads%2Ffeature%2Fx",
  ]);
  await assert.rejects(client.resolveRef("owner/repo"), { code: "INVALID_REF" });
  assert.equal(calls.length, 1);
});

test("default fetch injection preserves the host receiver instead of borrowing it as a client method", async () => {
  const bytes = utf8("default fetch path\n");
  const mock = await createReadMock([{ path: "default-fetch.txt", bytes }]);
  const upstream = mock.fetcher;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const receivers: unknown[] = [];
  const receiverSensitiveFetch: FetchLike = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    receivers.push(this);
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("fetch called with an invalid receiver");
    }
    return upstream(input, init);
  };

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: receiverSensitiveFetch,
  });
  try {
    const response = await handleRequest(
      new Request("https://worker.example/secondary/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${CONNECTOR_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "stat_file",
            arguments: { path: "default-fetch.txt", commit_sha: FULL_COMMIT },
          },
        }),
      }),
      {
        SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: CONNECTOR_TOKEN,
        GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN,
        SERVICE_VERSION: "test-version",
        MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER,
      },
    );
    const payload = await response.json() as any;
    assert.equal(payload.result.isError, undefined);
    assert.equal(JSON.parse(payload.result.content[0].text).byte_length, bytes.byteLength);
    assert.ok(receivers.length > 0);
    assert.ok(receivers.every((receiver) => receiver === undefined || receiver === globalThis));
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  }
});

test("SSE compatibility emits exactly one message event", async () => {
  const mock = await createReadMock([]);
  const response = await rpc(mock.fetcher, "ping", undefined, {
    accept: "text/event-stream",
  });
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /^event: message\ndata: \{"jsonrpc":"2.0"/);
  assert.equal((body.match(/^data:/gm) ?? []).length, 1);
});

test("authorization fails closed without leaking repository identity", async () => {
  const mock = await createReadMock([]);
  const missing = await rpc(mock.fetcher, "initialize", undefined, {
    authorization: null,
  });
  assert.equal(missing.status, 401);
  const missingBody = await missing.text();
  assert.equal(missingBody, "Unauthorized");
  assert.doesNotMatch(missingBody, /secondary-repository|fixture-owner/);

  const unconfigured = await rpc(mock.fetcher, "initialize", undefined, {
    env: { SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: undefined },
  });
  assert.equal(unconfigured.status, 503);
  assert.equal(await unconfigured.text(), "Service unavailable");
});

test("transport rejects unsafe origins, allows GET to fail with 405, and accepts notifications with 202", async () => {
  const mock = await createReadMock([]);
  const get = await handleRequest(
    new Request("https://worker.example/secondary/mcp", { method: "GET" }),
    { SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "local-test-connector-token", GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN, MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER },
    mock.fetcher,
  );
  assert.equal(get.status, 405);

  const hostile = await handleRequest(
    new Request("https://worker.example/secondary/mcp", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        authorization: "Bearer local-test-connector-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
    { SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "local-test-connector-token", GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN, MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER },
    mock.fetcher,
  );
  assert.equal(hostile.status, 403);

  const notification = await handleRequest(
    new Request("https://worker.example/secondary/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-connector-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }),
    { SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "local-test-connector-token", GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN, MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER },
    mock.fetcher,
  );
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("an unsupported MCP protocol header returns HTTP 400", async () => {
  const mock = await createReadMock([]);
  const response = await handleRequest(
    new Request("https://worker.example/secondary/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-connector-token",
        "content-type": "application/json",
        "mcp-protocol-version": "1900-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
    { SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "local-test-connector-token", GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN, MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER },
    mock.fetcher,
  );
  assert.equal(response.status, 400);
  const payload = await response.json() as any;
  assert.equal(payload.error.code, -32600);
});

test("rate limiting fails closed and oversized declared bodies are rejected before parsing", async () => {
  const mock = await createReadMock([]);
  const limited = await rpc(mock.fetcher, "ping", undefined, {
    env: {
      MCP_RATE_LIMITER_SECONDARY: {
        async limit() {
          return { success: false };
        },
      },
    },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");

  const oversized = await handleRequest(
    new Request("https://worker.example/secondary/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-connector-token",
        "content-type": "application/json",
        "content-length": "2097153",
      },
      body: "{}",
    }),
    {
      SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "local-test-connector-token", GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN,
      MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER,
    },
    mock.fetcher,
  );
  assert.equal(oversized.status, 413);
});

test("malformed JSON-RPC ids and tools/call params use protocol errors", async () => {
  const mock = await createReadMock([]);
  const objectId = await handleRequest(
    new Request("https://worker.example/secondary/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-connector-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: { invalid: true }, method: "ping" }),
    }),
    {
      SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "local-test-connector-token", GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN,
      MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER,
    },
    mock.fetcher,
  );
  assert.equal((await objectId.json() as any).error.code, -32600);

  const scalarParams = await handleRequest(
    new Request("https://worker.example/secondary/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-test-connector-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: 7 }),
    }),
    {
      SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "local-test-connector-token", GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN,
      MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER,
    },
    mock.fetcher,
  );
  assert.equal((await scalarParams.json() as any).error.code, -32600);

  for (const params of [
    { name: "unknown_tool", arguments: {} },
    { name: "stat_file", arguments: [] },
    { name: "stat_file", arguments: {}, extra: true },
  ]) {
    const response = await rpc(mock.fetcher, "tools/call", params);
    const payload = await response.json() as any;
    assert.equal(payload.error.code, -32602);
  }
  assert.equal(mock.calls.length, 0);
});

test("stat_file reports byte-exact CRLF metadata", async () => {
  const bytes = utf8("first\r\nsecond\r\n");
  const mock = await createReadMock([{ path: "crlf.txt", bytes }]);
  const { result, text } = await callTool(mock.fetcher, "stat_file", {
    path: "crlf.txt",
    commit_sha: FULL_COMMIT,
  });
  assertTextOnly(result);
  const stat = JSON.parse(text);
  assert.equal(stat.byte_length, bytes.byteLength);
  assert.equal(stat.line_count, 2);
  assert.equal(stat.first_line_fingerprint, "first");
  assert.equal(stat.last_line_fingerprint, "second");
  assert.equal(stat.encoding, "utf-8");
});

test("fingerprints visibly escape embedded line-separator characters", async () => {
  const bytes = utf8("alpha\rbeta\nomega\u2028tail\n");
  const mock = await createReadMock([{ path: "separators.txt", bytes }]);
  const result = await callTool(mock.fetcher, "stat_file", {
    path: "separators.txt",
    commit_sha: FULL_COMMIT,
  });
  const stat = JSON.parse(result.text);
  assert.equal(stat.first_line_fingerprint, "alpha\\rbeta");
  assert.equal(stat.last_line_fingerprint, "omega\\u2028tail");
});

test("a single-line UTF-8 BOM is excluded from both fingerprints", async () => {
  const mock = await createReadMock([
    { path: "bom-text.txt", bytes: utf8("\uFEFFabc") },
    { path: "bom-only.txt", bytes: utf8("\uFEFF") },
  ]);
  for (const [path, expected] of [
    ["bom-text.txt", "abc"],
    ["bom-only.txt", ""],
  ]) {
    const result = await callTool(mock.fetcher, "stat_file", {
      path,
      commit_sha: FULL_COMMIT,
    });
    const stat = JSON.parse(result.text);
    assert.equal(stat.first_line_fingerprint, expected);
    assert.equal(stat.last_line_fingerprint, expected);
  }
});

test("unknown tool arguments are rejected instead of silently ignored", async () => {
  const bytes = utf8("content");
  const mock = await createReadMock([{ path: "known.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "known.txt",
    commit_sha: FULL_COMMIT,
    owner: "attacker-controlled",
  });
  assert.equal(errorCode(result.text), "UNEXPECTED_ARGUMENT");
  assert.equal(mock.calls.length, 0);
});

test("get_file_text preserves bytes and optionally returns full-file SHA-256", async () => {
  const bytes = utf8("alpha\n中文\nomega");
  const mock = await createReadMock([{ path: "unicode.txt", bytes }]);
  const { result, text } = await callTool(mock.fetcher, "get_file_text", {
    path: "unicode.txt",
    commit_sha: FULL_COMMIT,
    include_sha256: true,
  });
  assertTextOnly(result);
  const parsed = independentEnvelopeCheck(text, bytes);
  assert.equal(parsed.fields.sha256, await digestHex("SHA-256", bytes));
  assert.equal(parsed.fields.range, "full");
  assert.equal(parsed.fields.next_byte_offset, "null");
});

test("one observation context reaches JSON, file envelopes, and tool errors", async () => {
  const bytes = utf8("observed body\n");
  const mock = await createReadMock([{ path: "observed.txt", bytes }]);
  const options = { env: OBSERVATION_ENV };

  const statResult = await callTool(mock.fetcher, "stat_file", {
    path: "observed.txt",
    commit_sha: FULL_COMMIT,
  }, options);
  const stat = JSON.parse(statResult.text);
  assertJsonObservation(stat, true, "succeeded");

  const fileResult = await callTool(mock.fetcher, "get_file_text", {
    path: "observed.txt",
    commit_sha: FULL_COMMIT,
  }, options);
  assertTextObservation(parseEnvelope(fileResult.text).fields, true, "succeeded");

  const refError = await callTool(mock.fetcher, "get_file_text", {
    path: "observed.txt",
    commit_sha: "main",
  }, options);
  assert.equal(errorCode(refError.text), "REF_NAME_NOT_ALLOWED");
  const refFields = parseToolErrorFields(refError.text);
  assert.equal(refFields.result, "null");
  assertTextObservation(refFields, false, "not_attempted");
  assert.doesNotMatch(refError.text, /---BEGIN FILE|commit: main/);

  const upstreamNotFound: FetchLike = async () =>
    new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  const missing = await callTool(upstreamNotFound, "stat_file", {
    path: "observed.txt",
    commit_sha: FULL_COMMIT,
  }, options);
  assert.equal(errorCode(missing.text), "COMMIT_NOT_FOUND");
  assertTextObservation(
    parseToolErrorFields(missing.text),
    true,
    "upstream_not_found",
  );
});

test("README 104-byte byte-selector degradation controls cover EOF and bounds", async () => {
  const readmeBytes = utf8(
    "# Synthetic README\n中文边界 fixture for byte ranges, EOF checks and immutable reads. XXXXXXXXXXXXXX\n",
  );
  assert.equal(readmeBytes.byteLength, 104);
  assert.equal(
    await gitBlobSha(readmeBytes),
    "06c9d70a5e15c439960ba779af2f612263ff5e1c",
  );
  const mock = await createReadMock([{ path: "README.md", bytes: readmeBytes }]);
  const options = { env: OBSERVATION_ENV };

  const fromStart = await callTool(mock.fetcher, "get_file_text", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
    byte_offset: 0,
  }, options);
  const startEnvelope = parseEnvelope(fromStart.text);
  assert.deepEqual(encodeUtf8(startEnvelope.body), readmeBytes);
  assert.equal(startEnvelope.fields.commit, FULL_COMMIT);
  assertTextObservation(startEnvelope.fields, true, "succeeded");

  const oneByteControl = await callTool(mock.fetcher, "get_file_text", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
    byte_offset: 0,
    byte_limit: 1,
  }, options);
  const oneByteEnvelope = parseEnvelope(oneByteControl.text);
  assert.equal(oneByteEnvelope.fields.range, "bytes:0-1");
  assert.equal(oneByteEnvelope.fields.chunk_bytes, "1");
  assert.equal(oneByteEnvelope.fields.has_more, "true");
  assert.equal(oneByteEnvelope.fields.next_byte_offset, "1");
  assert.equal(oneByteEnvelope.body, "#");
  assert.doesNotMatch(
    oneByteControl.text,
    /INVALID_INTEGER|BYTE_RANGE_OUT_OF_BOUNDS/,
  );

  const finalByte = await callTool(mock.fetcher, "get_file_text", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
    byte_offset: 103,
  }, options);
  const finalEnvelope = parseEnvelope(finalByte.text);
  assert.equal(Number(finalEnvelope.fields.chunk_bytes), 1);
  assert.deepEqual(encodeUtf8(finalEnvelope.body), readmeBytes.slice(103));

  const implicitEof = await callTool(mock.fetcher, "get_file_text", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
    byte_offset: 104,
  }, options);
  const explicitEof = await callTool(mock.fetcher, "get_file_text", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
    byte_offset: 104,
    byte_limit: 1,
  }, options);
  const implicitEnvelope = parseEnvelope(implicitEof.text);
  const explicitEnvelope = parseEnvelope(explicitEof.text);
  for (const envelope of [implicitEnvelope, explicitEnvelope]) {
    assert.equal(envelope.fields.range, "bytes:104-104");
    assert.equal(envelope.fields.byte_length, "104");
    assert.equal(envelope.fields.chunk_bytes, "0");
    assert.equal(envelope.fields.chunk_lines, "0");
    assert.equal(envelope.fields.truncated, "false");
    assert.equal(envelope.fields.has_more, "false");
    assert.equal(envelope.fields.next_byte_offset, "null");
    assert.equal(envelope.body, "");
    assertTextObservation(envelope.fields, true, "succeeded");
  }
  for (const key of [
    "range",
    "selection_end_byte_offset",
    "chunk_bytes",
    "chunk_lines",
    "truncated",
    "has_more",
    "next_byte_offset",
    "encoding",
  ]) {
    assert.equal(implicitEnvelope.fields[key], explicitEnvelope.fields[key]);
  }

  for (const offset of [105, 999_999]) {
    const outside = await callTool(mock.fetcher, "get_file_text", {
      path: "README.md",
      commit_sha: FULL_COMMIT,
      byte_offset: offset,
    }, options);
    assert.equal(errorCode(outside.text), "BYTE_RANGE_OUT_OF_BOUNDS");
    const fields = parseToolErrorFields(outside.text);
    assert.equal(fields.result, "null");
    assert.equal(fields.byte_length, "104");
    assert.equal(fields.requested_byte_offset, String(offset));
    assert.equal(fields.max_valid_byte_offset, "104");
    assert.equal(fields.empty_eof_read_allowed, "true");
    assert.doesNotMatch(outside.text, /-999895|:\s+-\d/);
    assertTextObservation(fields, true, "succeeded");
  }

  const negativeOffset = await callTool(mock.fetcher, "get_file_text", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
    byte_offset: -1,
  }, options);
  assert.equal(errorCode(negativeOffset.text), "INVALID_INTEGER");
  const negativeOffsetFields = parseToolErrorFields(negativeOffset.text);
  assert.equal(negativeOffsetFields.result, "null");
  assertTextObservation(negativeOffsetFields, false, "not_attempted");

  for (const byteLimit of [0, -1, -5]) {
    const invalidLimit = await callTool(mock.fetcher, "get_file_text", {
      path: "README.md",
      commit_sha: FULL_COMMIT,
      byte_offset: 0,
      byte_limit: byteLimit,
    }, options);
    assert.equal(errorCode(invalidLimit.text), "INVALID_INTEGER");
    assertTextObservation(
      parseToolErrorFields(invalidLimit.text),
      false,
      "not_attempted",
    );
  }

  const refError = await callTool(mock.fetcher, "get_file_text", {
    path: "README.md",
    commit_sha: "main",
  }, options);
  assert.equal(errorCode(refError.text), "REF_NAME_NOT_ALLOWED");
  assert.equal(parseToolErrorFields(refError.text).result, "null");
  assert.doesNotMatch(refError.text, /---BEGIN FILE---|^commit: [0-9a-f]{40}$/m);
  assertTextObservation(
    parseToolErrorFields(refError.text),
    false,
    "not_attempted",
  );
});

test("deploy guard rejects an unstaged tracked change", async () => {
  const fixture = await createDeployGuardRepository();
  try {
    await writeFile(join(fixture.cwd, "tracked.txt"), "unstaged\n", "utf8");
    const result = runDeployGuard(fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "deployment blocked: git diff is not clean\n");
    assert.deepEqual(await readWranglerInvocations(fixture), []);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("deploy guard rejects a staged tracked change", async () => {
  const fixture = await createDeployGuardRepository();
  try {
    await writeFile(join(fixture.cwd, "tracked.txt"), "staged\n", "utf8");
    requireProcessSuccess(
      runProcess("git", ["add", "tracked.txt"], fixture.cwd),
      "git add",
    );
    assert.equal(runProcess("git", ["diff", "--quiet"], fixture.cwd).status, 0);
    assert.equal(
      runProcess("git", ["diff", "--cached", "--quiet"], fixture.cwd).status,
      1,
    );
    const result = runDeployGuard(fixture);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "deployment blocked: git diff --cached is not clean\n",
    );
    assert.deepEqual(await readWranglerInvocations(fixture), []);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("deploy guard rejects a purely untracked file", async () => {
  const fixture = await createDeployGuardRepository();
  try {
    await writeFile(join(fixture.cwd, "untracked.txt"), "untracked\n", "utf8");
    assert.equal(runProcess("git", ["diff", "--quiet"], fixture.cwd).status, 0);
    assert.equal(
      runProcess("git", ["diff", "--cached", "--quiet"], fixture.cwd).status,
      0,
    );
    const status = runProcess(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      fixture.cwd,
    );
    requireProcessSuccess(status, "git status");
    assert.match(status.stdout, /^\?\? untracked\.txt$/m);
    const result = runDeployGuard(fixture);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "deployment blocked: tracked or untracked deployment inputs are pending\n",
    );
    assert.deepEqual(await readWranglerInvocations(fixture), []);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("deploy guard rejects an intent-to-add file through git diff", async () => {
  const fixture = await createDeployGuardRepository();
  try {
    await writeFile(join(fixture.cwd, "intent.txt"), "intent\n", "utf8");
    requireProcessSuccess(
      runProcess("git", ["add", "-N", "intent.txt"], fixture.cwd),
      "git add -N",
    );
    assert.equal(runProcess("git", ["diff", "--quiet"], fixture.cwd).status, 1);
    assert.equal(
      runProcess("git", ["diff", "--cached", "--quiet"], fixture.cwd).status,
      0,
    );
    const result = runDeployGuard(fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "deployment blocked: git diff is not clean\n");
    assert.deepEqual(await readWranglerInvocations(fixture), []);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("deploy guard accepts detached commits, feature branches, and repositories without origin", async () => {
  for (const mode of ["detached", "feature", "no-origin", "ahead"] as const) {
    const fixture = await createDeployGuardRepository();
    try {
      if (mode === "detached") requireProcessSuccess(runProcess("git", ["switch", "--detach", "HEAD"], fixture.cwd), "detach");
      if (mode === "feature") requireProcessSuccess(runProcess("git", ["switch", "-c", "feature/release"], fixture.cwd), "branch");
      if (mode === "no-origin") requireProcessSuccess(runProcess("git", ["update-ref", "-d", "refs/remotes/origin/main"], fixture.cwd), "remove origin ref");
      if (mode === "ahead") await commitDeployGuardFile(fixture, "local.txt", "local\n", "local commit");
      const head = deployGuardHead(fixture);
      const result = runDeployGuard(fixture);
      assert.equal(result.status, 0, result.stderr);
      const calls = await readWranglerInvocations(fixture);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes(`SOURCE_COMMIT:${head}`));
    } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
  }
});

test("deploy guard allows a clean committed tree and invokes Wrangler once", async () => {
  const fixture = await createDeployGuardRepository();
  try {
    const headResult = runProcess("git", ["rev-parse", "HEAD"], fixture.cwd);
    requireProcessSuccess(headResult, "git rev-parse HEAD");
    const head = headResult.stdout.trim();
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(deployGuardHead(fixture, "origin/main"), head);

    const result = runDeployGuard(fixture);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /deployment blocked:/);
    assert.match(
      result.stdout,
      /^deployment guard: PASS git diff --exit-code$/m,
    );
    assert.match(
      result.stdout,
      /^deployment guard: PASS git diff --cached --exit-code$/m,
    );
    assert.match(
      result.stdout,
      /^deployment guard: PASS git status --porcelain=v1 --untracked-files=all$/m,
    );
    assert.match(
      result.stdout,
      new RegExp(`^deployment guard: PASS HEAD ${head}$`, "m"),
    );
    assert.match(
      result.stdout,
      new RegExp(`^deployment guard: PASS tag source-${head.slice(0, 12)}$`, "m"),
    );
    assert.match(
      result.stdout,
      new RegExp(
        `^deployment guard: PASS argv .*SOURCE_COMMIT:${head}.*source-${head.slice(0, 12)}.*--dry-run.*$`,
        "m",
      ),
    );

    const invocations = await readWranglerInvocations(fixture);
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0], [
      "deploy",
      "--var",
      `SOURCE_COMMIT:${head}`,
      "--tag",
      `source-${head.slice(0, 12)}`,
      "--dry-run",
    ]);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("an explicitly limited selection can be complete while unread file bytes remain", async () => {
  const bytes = utf8("A中文B尾");
  const mock = await createReadMock([{ path: "limited.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "limited.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 0,
    byte_limit: 4,
  });
  const parsed = parseEnvelope(result.text);
  assert.equal(parsed.body, "A中");
  assert.equal(parsed.fields.range, "bytes:0-4");
  assert.equal(parsed.fields.selection_end_byte_offset, "4");
  assert.equal(parsed.fields.truncated, "false");
  assert.equal(parsed.fields.has_more, "true");
  assert.equal(parsed.fields.next_byte_offset, "4");
});

test("a complete whole-file delivery has no continuation", async () => {
  const bytes = utf8("完整文件\n");
  const mock = await createReadMock([{ path: "complete-file.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "complete-file.txt",
    commit_sha: FULL_COMMIT,
  });
  const parsed = parseEnvelope(result.text);
  assert.equal(parsed.fields.selection_end_byte_offset, String(bytes.byteLength));
  assert.equal(parsed.fields.truncated, "false");
  assert.equal(parsed.fields.has_more, "false");
  assert.equal(parsed.fields.next_byte_offset, "null");
});

test("line ranges are 1-based closed and preserve original terminators", async () => {
  const bytes = utf8("one\r\ntwo\nthree");
  const mock = await createReadMock([{ path: "lines.txt", bytes }]);
  const first = await callTool(mock.fetcher, "get_file_text", {
    path: "lines.txt",
    commit_sha: FULL_COMMIT,
    start_line: 1,
    end_line: 1,
  });
  assert.equal(parseEnvelope(first.text).body, "one\r\n");
  assert.equal(parseEnvelope(first.text).fields.range, "lines:1-1");

  const last = await callTool(mock.fetcher, "get_file_text", {
    path: "lines.txt",
    commit_sha: FULL_COMMIT,
    start_line: 3,
    end_line: 3,
  });
  const lastEnvelope = parseEnvelope(last.text);
  assert.equal(lastEnvelope.body, "three");
  assert.equal(lastEnvelope.fields.has_more, "false");
  assert.equal(lastEnvelope.fields.next_byte_offset, "null");

  const outside = await callTool(mock.fetcher, "get_file_text", {
    path: "lines.txt",
    commit_sha: FULL_COMMIT,
    start_line: 4,
    end_line: 4,
  });
  assert.equal(outside.result.isError, true);
  assert.equal(errorCode(outside.text), "LINE_RANGE_OUT_OF_BOUNDS");
});

test("a chunked line range exposes a bounded byte continuation", async () => {
  const bytes = utf8("one\ntwo\nthree");
  const mock = await createReadMock([{ path: "bounded-lines.txt", bytes }]);
  const first = await callTool(mock.fetcher, "get_file_text", {
    path: "bounded-lines.txt",
    commit_sha: FULL_COMMIT,
    start_line: 2,
    end_line: 2,
    max_bytes: 2,
  });
  const firstEnvelope = parseEnvelope(first.text);
  assert.equal(firstEnvelope.body, "tw");
  assert.equal(firstEnvelope.fields.range, "bytes:4-6");
  assert.equal(firstEnvelope.fields.selection_end_byte_offset, "8");
  assert.equal(firstEnvelope.fields.truncated, "true");
  assert.equal(firstEnvelope.fields.has_more, "true");
  assert.equal(firstEnvelope.fields.next_byte_offset, "6");

  const end = Number(firstEnvelope.fields.selection_end_byte_offset);
  const next = Number(firstEnvelope.fields.next_byte_offset);
  const second = await callTool(mock.fetcher, "get_file_text", {
    path: "bounded-lines.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: next,
    byte_limit: end - next,
  });
  const secondEnvelope = parseEnvelope(second.text);
  assert.equal(secondEnvelope.body, "o\n");
  assert.equal(secondEnvelope.fields.range, "bytes:6-8");
  assert.equal(secondEnvelope.fields.truncated, "false");
  assert.equal(secondEnvelope.fields.has_more, "true");
  assert.equal(secondEnvelope.fields.next_byte_offset, "8");
});

test("a completed middle line range reports the equivalent file continuation", async () => {
  const bytes = utf8("首行\n中间甲\n中间乙\n末行");
  const expectedNext = utf8("首行\n中间甲\n中间乙\n").byteLength;
  const mock = await createReadMock([{ path: "middle-lines.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "middle-lines.txt",
    commit_sha: FULL_COMMIT,
    start_line: 2,
    end_line: 3,
  });
  const parsed = parseEnvelope(result.text);
  assert.equal(parsed.body, "中间甲\n中间乙\n");
  assert.equal(parsed.fields.range, "lines:2-3");
  assert.equal(parsed.fields.selection_end_byte_offset, String(expectedNext));
  assert.equal(parsed.fields.truncated, "false");
  assert.equal(parsed.fields.has_more, "true");
  assert.equal(parsed.fields.next_byte_offset, String(expectedNext));
});

test("small explicit byte limits round-trip Chinese text without gaps or loops", async () => {
  const source = "甲乙丙丁\n中文续读边界\n尾行没有换行";
  const expected = utf8(source);
  const expectedBlobSha = await gitBlobSha(expected);
  const mock = await createReadMock([{ path: "roundtrip-zh.txt", bytes: expected }]);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let rounds = 0;
  for (; rounds < 100; rounds += 1) {
    const result = await callTool(mock.fetcher, "get_file_text", {
      path: "roundtrip-zh.txt",
      commit_sha: FULL_COMMIT,
      byte_offset: offset,
      byte_limit: 7,
    });
    const parsed = parseEnvelope(result.text);
    const chunk = utf8(parsed.body);
    assert.ok(chunk.byteLength > 0);
    assert.equal(parsed.fields.byte_length, String(expected.byteLength));
    assert.equal(parsed.fields.blob_sha, expectedBlobSha);
    assert.equal(
      parsed.fields.range,
      `bytes:${offset}-${offset + chunk.byteLength}`,
    );
    assert.equal(parsed.fields.truncated, "false");
    chunks.push(chunk);
    if (parsed.fields.has_more === "false") break;
    const next = Number(parsed.fields.next_byte_offset);
    assert.ok(next > offset);
    offset = next;
  }
  assert.equal(rounds + 1, 8);
  assert.ok(rounds < 100);
  const joined = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let cursor = 0;
  for (const chunk of chunks) {
    joined.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  assert.equal(joined.byteLength, expected.byteLength);
  assert.deepEqual(joined, expected);
  assert.equal(await gitBlobSha(joined), expectedBlobSha);
});

test("byte ranges and max_bytes never split a UTF-8 character", async () => {
  const bytes = utf8("A中文B");
  const mock = await createReadMock([{ path: "bytes.txt", bytes }]);
  const exact = await callTool(mock.fetcher, "get_file_text", {
    path: "bytes.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 1,
    byte_limit: 6,
  });
  assert.equal(exact.result.isError, undefined);
  assert.equal(parseEnvelope(exact.text).body, "中文");

  const inside = await callTool(mock.fetcher, "get_file_text", {
    path: "bytes.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 2,
    byte_limit: 3,
  });
  assert.equal(inside.result.isError, true);
  assert.equal(errorCode(inside.text), "BYTE_OFFSET_SPLITS_UTF8");
  assert.match(inside.text, /\nsafe_offset: 1(?:\n|$)/);

  const recovered = await callTool(mock.fetcher, "get_file_text", {
    path: "bytes.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 1,
    byte_limit: 6,
  });
  assert.equal(recovered.result.isError, undefined);
  assert.equal(parseEnvelope(recovered.text).body, "中文");

  const chunked = await callTool(mock.fetcher, "get_file_text", {
    path: "bytes.txt",
    commit_sha: FULL_COMMIT,
    max_bytes: 2,
  });
  const parsed = parseEnvelope(chunked.text);
  assert.equal(parsed.body, "A");
  assert.equal(parsed.fields.range, "bytes:0-1");
  assert.equal(parsed.fields.selection_end_byte_offset, String(bytes.byteLength));
  assert.equal(parsed.fields.chunk_bytes, "1");
  assert.equal(parsed.fields.truncated, "true");
  assert.equal(parsed.fields.has_more, "true");
  assert.equal(parsed.fields.next_byte_offset, "1");
});

test("byte_limit retreats to a truthful UTF-8 boundary or fails if no character fits", async () => {
  const bytes = utf8("A中B");
  const mock = await createReadMock([{ path: "byte-limit.txt", bytes }]);
  const retreated = await callTool(mock.fetcher, "get_file_text", {
    path: "byte-limit.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 0,
    byte_limit: 2,
  });
  const parsed = parseEnvelope(retreated.text);
  assert.equal(parsed.body, "A");
  assert.equal(parsed.fields.range, "bytes:0-1");
  assert.equal(parsed.fields.selection_end_byte_offset, "1");
  assert.equal(parsed.fields.truncated, "false");
  assert.equal(parsed.fields.has_more, "true");
  assert.equal(parsed.fields.next_byte_offset, "1");

  const tooSmall = await callTool(mock.fetcher, "get_file_text", {
    path: "byte-limit.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 1,
    byte_limit: 1,
  });
  assert.equal(errorCode(tooSmall.text), "BYTE_LIMIT_SPLITS_UTF8");
});

test("nonce delimiters frame literal end markers without changing a no-LF body", async () => {
  const body = "prefix---END FILE---suffix";
  const bytes = utf8(body);
  const mock = await createReadMock([{ path: "delimiter.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "delimiter.txt",
    commit_sha: FULL_COMMIT,
  });
  const parsed = independentEnvelopeCheck(result.text, bytes);
  assert.equal(parsed.body, body);
  assert.match(parsed.begin, /[0-9a-f]{12}/);
  assert.equal(parsed.fields.delimiter_nonce, parsed.begin.match(/[0-9a-f]{12}/)?.[0]);
});

test("a chunk containing the default end marker declares matching nonce delimiters", async () => {
  const firstChunk = "prefix\n---END FILE---\n";
  const body = `${firstChunk}suffix\n`;
  const bytes = utf8(body);
  const mock = await createReadMock([{ path: "chunked-delimiter.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "chunked-delimiter.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 0,
    byte_limit: bytes.byteLength,
    max_bytes: utf8(firstChunk).byteLength,
  });
  const parsed = parseEnvelope(result.text);
  const nonce = parsed.fields.delimiter_nonce;
  assert.match(nonce, /^[0-9a-f]{12}$/);
  assert.equal(parsed.begin, `---BEGIN FILE ${nonce}---`);
  assert.equal(parsed.end, `---END FILE ${nonce}---`);
  assert.equal(parsed.body, firstChunk);
  assert.equal(parsed.fields.has_more, "true");
  assert.equal(parsed.fields.next_byte_offset, String(utf8(firstChunk).byteLength));
});

test("chunk_lines counts returned line fragments at partial byte boundaries", async () => {
  const bytes = utf8("alpha\n中文beta\nomega");
  const mock = await createReadMock([{ path: "line-fragments.txt", bytes }]);
  const partialBothEnds = await callTool(mock.fetcher, "get_file_text", {
    path: "line-fragments.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 2,
    byte_limit: 10,
  });
  const partial = parseEnvelope(partialBothEnds.text);
  assert.equal(partial.body, "pha\n中文");
  assert.equal(partial.fields.chunk_lines, "2");

  const endingAtLf = await callTool(mock.fetcher, "get_file_text", {
    path: "line-fragments.txt",
    commit_sha: FULL_COMMIT,
    byte_offset: 2,
    byte_limit: 4,
  });
  const ended = parseEnvelope(endingAtLf.text);
  assert.equal(ended.body, "pha\n");
  assert.equal(ended.fields.chunk_lines, "1");
});

test("an inline begin-marker substring in a valid path cannot confuse envelope parsing", async () => {
  const path = "probes/x---BEGIN FILE---y.txt";
  const bytes = utf8("body stays body");
  const mock = await createReadMock([{ path, bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path,
    commit_sha: FULL_COMMIT,
  });
  const parsed = independentEnvelopeCheck(result.text, bytes);
  assert.equal(parsed.fields.path, path);
  assert.equal(parsed.body, "body stays body");
});

test("tree metadata rejects symlinks and submodules before Contents dereferencing", async () => {
  const mock = await createReadMock([], {
    symlinks: ["link.txt"],
    submodules: ["vendor/module"],
  });
  const symlink = await callTool(mock.fetcher, "get_file_text", {
    path: "link.txt",
    commit_sha: FULL_COMMIT,
  });
  const submodule = await callTool(mock.fetcher, "get_file_text", {
    path: "vendor/module",
    commit_sha: FULL_COMMIT,
  });
  assert.equal(errorCode(symlink.text), "SYMLINK_NOT_SUPPORTED");
  assert.equal(errorCode(submodule.text), "SUBMODULE_NOT_SUPPORTED");
  assert.equal(
    mock.calls.filter((call) => call.url.includes("/contents/")).length,
    0,
  );
});

test("line-breaking paths are rejected before any GitHub request", async () => {
  const mock = await createReadMock([]);
  for (const path of [
    "header\n---BEGIN FILE---\ninjection.txt",
    "next\u0085line.txt",
    "vertical\u000btab.txt",
    "escape\u001bsequence.txt",
    "unicode\u2028line.txt",
  ]) {
    const result = await callTool(mock.fetcher, "get_file_text", {
      path,
      commit_sha: FULL_COMMIT,
    });
    assert.equal(errorCode(result.text), "INVALID_PATH");
  }
  assert.equal(mock.calls.length, 0);
});

test("Contents API omission falls back to Git blobs and still verifies the blob SHA", async () => {
  const bytes = utf8("fallback body\n");
  const mock = await createReadMock([
    { path: "large.txt", bytes, forceBlobFallback: true },
  ]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "large.txt",
    commit_sha: FULL_COMMIT,
  });
  independentEnvelopeCheck(result.text, bytes);
  assert.ok(mock.calls.some((call) => call.url.includes("/git/blobs/")));
});

test("error matrix distinguishes path, directory, short SHA, ref name, binary, and auth", async () => {
  const mock = await createReadMock(
    [{ path: "binary.bin", bytes: new Uint8Array([0, 255, 65]) }],
    { directories: ["directory"] },
  );
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["missing", { path: "missing.txt", commit_sha: FULL_COMMIT }, "PATH_NOT_FOUND"],
    ["directory", { path: "directory", commit_sha: FULL_COMMIT }, "DIRECTORY_PATH"],
    ["short", { path: "binary.bin", commit_sha: "8fbb422" }, "SHORT_COMMIT_SHA"],
    ["ref", { path: "binary.bin", commit_sha: "main" }, "REF_NAME_NOT_ALLOWED"],
    ["binary", { path: "binary.bin", commit_sha: FULL_COMMIT }, "BINARY_FILE"],
  ];
  const seen = new Set<string>();
  for (const [, args, expected] of cases) {
    const result = await callTool(mock.fetcher, "get_file_text", args);
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), expected);
    assert.doesNotMatch(result.text, /---BEGIN FILE---/);
    seen.add(expected);
  }
  assert.equal(seen.size, cases.length);

  const unauthorized = await rpc(mock.fetcher, "tools/call", {
    name: "get_file_text",
    arguments: { path: "binary.bin", commit_sha: FULL_COMMIT },
  }, { authorization: null });
  assert.equal(unauthorized.status, 401);
});

test("a recursive-tree path miss uses the fixed safe 404 message", async () => {
  const mock = await createReadMock([]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "missing.txt",
    commit_sha: FULL_COMMIT,
  });
  assert.equal(errorCode(result.text), "PATH_NOT_FOUND");
  assert.match(
    result.text,
    /^ERROR PATH_NOT_FOUND\nmessage: GitHub did not find the requested resource\.\n/,
  );
  assert.equal(parseToolErrorFields(result.text).result, "null");
  assert.doesNotMatch(result.text, /message: Not Found/);
  assert.equal(mock.calls.filter((call) => call.url.includes("/contents/")).length, 0);
});

test("upstream SHA tampering is rejected before any content is returned", async () => {
  const mock = await createReadMock(
    [{ path: "tampered.txt", bytes: utf8("authentic bytes") }],
    { tamperBytesFor: "tampered.txt" },
  );
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "tampered.txt",
    commit_sha: FULL_COMMIT,
  });
  assert.equal(result.result.isError, true);
  assert.equal(errorCode(result.text), "BLOB_SHA_MISMATCH");
  assert.doesNotMatch(result.text, /authentic bytes/);
});

test("SHA-256 opt-in has an explicit size threshold", async () => {
  const bytes = utf8("x".repeat(SHA256_MAX_BYTES + 1));
  const mock = await createReadMock([{ path: "too-large.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "too-large.txt",
    commit_sha: FULL_COMMIT,
    include_sha256: true,
  });
  assert.equal(errorCode(result.text), "SHA256_SIZE_LIMIT");
});

test("SHA-256 opt-in includes the exact 262144-byte boundary", async () => {
  const bytes = utf8("x".repeat(SHA256_MAX_BYTES));
  const mock = await createReadMock([{ path: "sha-boundary.txt", bytes }]);
  const result = await callTool(mock.fetcher, "get_file_text", {
    path: "sha-boundary.txt",
    commit_sha: FULL_COMMIT,
    include_sha256: true,
    max_bytes: 1,
  });
  const parsed = parseEnvelope(result.text);
  assert.equal(parsed.fields.sha256, await digestHex("SHA-256", bytes));
  assert.equal(parsed.fields.has_more, "true");
});

test("synchronous fetch invocation errors and asynchronous network failures are distinguishable", async () => {
  const invocationFailure: FetchLike = function (): Promise<Response> {
    throw new TypeError("sensitive invocation sentinel");
  };
  const networkFailure: FetchLike = () =>
    Promise.reject(new Error("sensitive network sentinel"));
  const networkTypeFailure: FetchLike = () =>
    Promise.reject(new TypeError("sensitive asynchronous TypeError sentinel"));
  const abortedFailure: FetchLike = () =>
    Promise.reject(new DOMException("sensitive abort sentinel", "AbortError"));
  const timeoutFailure: FetchLike = () =>
    Promise.reject(new DOMException("sensitive timeout sentinel", "TimeoutError"));

  const invocation = await callTool(invocationFailure, "stat_file", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
  });
  const network = await callTool(networkFailure, "stat_file", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
  });
  const networkType = await callTool(networkTypeFailure, "stat_file", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
  });
  const aborted = await callTool(abortedFailure, "stat_file", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
  });
  const timeout = await callTool(timeoutFailure, "stat_file", {
    path: "README.md",
    commit_sha: FULL_COMMIT,
  });

  assert.equal(errorCode(invocation.text), "GITHUB_FETCH_INVOCATION_ERROR");
  assert.equal(errorCode(network.text), "GITHUB_NETWORK_ERROR");
  assert.equal(errorCode(networkType.text), "GITHUB_NETWORK_ERROR");
  assert.equal(errorCode(aborted.text), "GITHUB_FETCH_ABORTED");
  assert.equal(errorCode(timeout.text), "GITHUB_FETCH_TIMEOUT");
  for (const failure of [invocation, network, networkType, aborted, timeout]) {
    const fields = parseToolErrorFields(failure.text);
    assert.equal(fields.github_fetch_attempted, "true");
    assert.equal(fields.github_fetch_outcome, "upstream_error");
  }
  assert.match(invocation.text, /TypeError/);
  assert.match(network.text, /Error/);
  assert.match(networkType.text, /TypeError/);
  assert.match(aborted.text, /AbortError/);
  assert.match(timeout.text, /TimeoutError/);
  assert.notEqual(errorCode(invocation.text), errorCode(network.text));
  assert.doesNotMatch(
    `${invocation.text}\n${network.text}\n${networkType.text}\n${aborted.text}\n${timeout.text}`,
    /sensitive|Authorization|Bearer|token/i,
  );
});

test("literal search reports matching line numbers, context, and truncation", async () => {
  const bytes = utf8("zero\nneedle one\nneedle two\nlast\n");
  const mock = await createReadMock([{ path: "search.txt", bytes }]);
  const result = await callTool(mock.fetcher, "search_in_file", {
    path: "search.txt",
    commit_sha: FULL_COMMIT,
    pattern: "needle",
    max_matches: 1,
    context_lines: 1,
  });
  const payload = JSON.parse(result.text);
  assert.equal(payload.pattern_kind, "literal");
  assert.equal(payload.total_matches, 2);
  assert.equal(payload.truncated, true);
  assert.equal(payload.matches[0].line_number, 2);
  assert.equal(payload.github_fetch_attempted, true);
  assert.equal(payload.github_fetch_outcome, "succeeded");
  assert.deepEqual(payload.matches[0].context_before, ["zero"]);
  assert.deepEqual(payload.matches[0].context_after, ["needle two"]);
});

test("search context amplification is stopped by an explicit output budget", async () => {
  const longContext = "x".repeat(130_000);
  const bytes = utf8(`${longContext}\nhit one\nhit two\n`);
  const mock = await createReadMock([{ path: "amplification.txt", bytes }]);
  const result = await callTool(mock.fetcher, "search_in_file", {
    path: "amplification.txt",
    commit_sha: FULL_COMMIT,
    pattern: "hit",
    max_matches: 500,
    context_lines: 20,
  });
  assert.equal(errorCode(result.text), "SEARCH_OUTPUT_LIMIT");
});

test("GitHub primary and secondary rate limits have one typed quota error", async () => {
  for (const [status, headers, message] of [
    [429, { "x-ratelimit-remaining": "0" }, "API rate limit exceeded"],
    [403, { "x-ratelimit-remaining": "4999", "retry-after": "60" }, "secondary rate limit"],
  ] as const) {
    const fetcher = async () => new Response(JSON.stringify({ message }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
    const result = await callTool(fetcher, "stat_file", {
      path: "README.md",
      commit_sha: FULL_COMMIT,
    });
    assert.equal(errorCode(result.text), "GITHUB_QUOTA_EXCEEDED");
  }
});

test("GitHub error payloads never echo upstream secrets or URLs", async () => {
  const hostileMessage =
    "Authorization: Bearer test-sensitive-sentinel token=hidden download_url=https://secret.invalid/file";
  for (const [status, expectedCode] of [
    [404, "COMMIT_NOT_FOUND"],
    [409, "GITHUB_CONFLICT"],
    [422, "GITHUB_CONFLICT"],
    [500, "GITHUB_UPSTREAM_ERROR"],
  ] as const) {
    const fetcher: FetchLike = async () =>
      new Response(
        JSON.stringify({
          message: hostileMessage,
          download_url: "https://secret.invalid/download",
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    const result = await callTool(fetcher, "stat_file", {
      path: "README.md",
      commit_sha: FULL_COMMIT,
    });
    assert.equal(errorCode(result.text), expectedCode);
    assert.doesNotMatch(
      result.text,
      /Authorization|Bearer|ghp_|token|download_url|secret\.invalid/i,
    );
  }
});

test("degradation controls make one-byte truncation and summary-only responses fail", async () => {
  const bytes = utf8("complete body without trailing newline");
  const mock = await createReadMock([{ path: "complete.txt", bytes }]);
  const valid = await callTool(mock.fetcher, "get_file_text", {
    path: "complete.txt",
    commit_sha: FULL_COMMIT,
  });
  independentEnvelopeCheck(valid.text, bytes);

  const endAt = valid.text.lastIndexOf("---END FILE---");
  const truncated = valid.text.slice(0, endAt - 1) + valid.text.slice(endAt);
  assert.throws(() => independentEnvelopeCheck(truncated, bytes));
  assert.throws(() =>
    independentEnvelopeCheck(
      "successfully downloaded text file (SHA: deadbeef)",
      bytes,
    ),
  );
});

test("injected repository binding is used for commit, tree, Contents, and blob reads", async () => {
  const binding = { owner: "binding-owner", repo: "binding-repository" };
  const prefix = `/repos/${binding.owner}/${binding.repo}`;
  const path = "nested/injected.txt";
  const bytes = utf8("injected binding\n");
  const blobSha = await gitBlobSha(bytes);
  const treeSha = "e".repeat(40);
  const replies = new Map<string, unknown>([
    [`${prefix}/git/commits/${FULL_COMMIT}`, { tree: { sha: treeSha } }],
    [`${prefix}/git/trees/${treeSha}`, {
      truncated: false,
      tree: [{ path, mode: "100644", type: "blob", sha: blobSha }],
    }],
    [`${prefix}/contents/${path}`, {
      type: "file", sha: blobSha, size: bytes.byteLength, encoding: "none",
    }],
    [`${prefix}/git/blobs/${blobSha}`, {
      sha: blobSha,
      size: bytes.byteLength,
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
    }],
  ]);
  const calls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(replies.has(url.pathname), `unexpected bound path: ${url.pathname}`);
    calls.push(url.pathname + url.search);
    return new Response(JSON.stringify(replies.get(url.pathname)), {
      headers: { "content-type": "application/json" },
    });
  };
  const observation = new ObservationContext({});
  const client = new GitHubClient(GITHUB_TOKEN, fetcher, "test-version", observation, binding);
  const result = await callServiceTool(client, "test-version", "get_file_text", {
    path,
    commit_sha: FULL_COMMIT,
  }, observation);
  assert.deepEqual(encodeUtf8(parseEnvelope(result.content[0].text).body), bytes);
  assert.deepEqual(calls, [
    `${prefix}/git/commits/${FULL_COMMIT}`,
    `${prefix}/git/trees/${treeSha}?recursive=1`,
    `${prefix}/contents/${path}?ref=${FULL_COMMIT}`,
    `${prefix}/git/blobs/${blobSha}`,
  ]);
});

const PREFIX_CASES = [
  {
    prefix: "primary",
    repository: "primary-repository",
    connectorKey: "CONNECTOR_TOKEN_PRIMARY",
    githubKey: "GITHUB_TOKEN_PRIMARY",
    limiterKey: "MCP_RATE_LIMITER_PRIMARY",
    sibling: "secondary",
  },
  {
    prefix: "secondary",
    repository: "secondary-repository",
    connectorKey: "CONNECTOR_TOKEN_SECONDARY",
    githubKey: "GITHUB_TOKEN_SECONDARY",
    limiterKey: "MCP_RATE_LIMITER_SECONDARY",
    sibling: "primary",
  },
] as const;

function prefixTestEnv(): Env {
  return {
    PRIMARY_REPOSITORY: "fixture-owner/primary-repository", CONNECTOR_TOKEN_PRIMARY: "primary-inbound-test-token",
    SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: "secondary-inbound-test-token",
    GITHUB_TOKEN_PRIMARY: "primary-outbound-test-token",
    GITHUB_TOKEN_SECONDARY: "secondary-outbound-test-token",
    MCP_RATE_LIMITER_PRIMARY: ALLOW_RATE_LIMITER,
    MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER,
  };
}

function prefixTestRequest(
  pathname: string,
  prefix: string,
  method = "ping",
): Request {
  return new Request(`https://worker.example${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${prefix}-inbound-test-token`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      ...(method === "tools/call" ? {
        params: { name: "stat_file", arguments: { path: "README.md", commit_sha: FULL_COMMIT } },
      } : {}),
    }),
  });
}

for (const binding of PREFIX_CASES) {
  test(`/${binding.prefix}/mcp gets commit metadata with its bound repository and read credential`, async () => {
    const mock = commitMetadataMock([], { binding: { owner: "fixture-owner", repo: binding.repository } });
    const response = await rpc(mock.fetcher, "tools/call", { name: "get_commit_metadata", arguments: { commit_sha: FULL_COMMIT } }, {
      pathname: `/${binding.prefix}/mcp`, authorization: `Bearer ${binding.prefix}-inbound-test-token`,
      env: prefixTestEnv(),
    });
    assert.equal(response.status, 200);
    const { result } = await response.json() as any;
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text).files, []);
    assert.ok(mock.calls.every((call) => call.method === "GET" && call.authorization === `Bearer ${binding.prefix}-outbound-test-token`));
  });

  test(`/${binding.prefix}/mcp lists directories with its bound repository and read credential`, async () => {
    const mock = directoryReadMock([], { owner: "fixture-owner", repo: binding.repository });
    const response = await rpc(mock.fetcher, "tools/call", {
      name: "list_directory", arguments: { commit_sha: FULL_COMMIT },
    }, {
      pathname: `/${binding.prefix}/mcp?repo=ignored&ref=ignored`,
      authorization: `Bearer ${binding.prefix}-inbound-test-token`,
      env: { ...prefixTestEnv(), ...OBSERVATION_ENV },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.result.isError, undefined);
    assert.deepEqual(JSON.parse(payload.result.content[0].text).entries, []);
    assert.ok(mock.calls.every((call) => call.method === "GET" && call.authorization === `Bearer ${binding.prefix}-outbound-test-token`));
  });

  test(`/${binding.prefix}/mcp resolves refs with its own repository and credential using GET`, async () => {
    const calls: string[] = [];
    const response = await rpc(async (input, init) => {
      calls.push(`${init?.method} ${input}`);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${binding.prefix}-outbound-test-token`);
      return new Response(JSON.stringify({ sha: FULL_COMMIT }));
    }, "tools/call", { name: "resolve_ref", arguments: { ref: "refs/tags/release/v1" } }, {
      pathname: `/${binding.prefix}/mcp?repo=ignored&prefix=${binding.sibling}`,
      authorization: `Bearer ${binding.prefix}-inbound-test-token`,
      env: { ...prefixTestEnv(), ...OBSERVATION_ENV },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.result.isError, undefined);
    const receipt = JSON.parse(payload.result.content[0].text);
    assert.equal(receipt.ref, "refs/tags/release/v1");
    assert.equal(receipt.commit_sha, FULL_COMMIT);
    assertJsonObservation(receipt, true, "succeeded");
    assert.deepEqual(calls, [
      `GET https://api.github.com/repos/fixture-owner/${binding.repository}/commits/tags%2Frelease%2Fv1`,
    ]);
  });

  test(`/${binding.prefix}/mcp selects its repository and outbound credential for every read REST path`, async () => {
    const prefix = `/repos/fixture-owner/${binding.repository}`;
    const path = "nested/routed.txt";
    const bytes = utf8(`${binding.prefix} routed body\n`);
    const blobSha = await gitBlobSha(bytes);
    const treeSha = "e".repeat(40);
    const replies = new Map<string, unknown>([
      [`${prefix}/git/commits/${FULL_COMMIT}`, { tree: { sha: treeSha } }],
      [`${prefix}/git/trees/${treeSha}?recursive=1`, {
        truncated: false,
        tree: [{ path, mode: "100644", type: "blob", sha: blobSha }],
      }],
      [`${prefix}/contents/${path}?ref=${FULL_COMMIT}`, {
        type: "file", sha: blobSha, size: bytes.byteLength, encoding: "none",
      }],
      [`${prefix}/git/blobs/${blobSha}`, {
        sha: blobSha, size: bytes.byteLength, encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
      }],
    ]);
    const calls: string[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      const restPath = url.pathname + url.search;
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${binding.prefix}-outbound-test-token`);
      assert.ok(replies.has(restPath), `unexpected routed path: ${restPath}`);
      calls.push(restPath);
      return new Response(JSON.stringify(replies.get(restPath)), {
        headers: { "content-type": "application/json" },
      });
    };
    const response = await rpc(fetcher, "tools/call", {
      name: "get_file_text", arguments: { path, commit_sha: FULL_COMMIT },
    }, {
      pathname: `/${binding.prefix}/mcp?prefix=${binding.sibling}&repo=ignored`,
      authorization: `Bearer ${binding.prefix}-inbound-test-token`,
      env: prefixTestEnv(),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.result.isError, undefined);
    independentEnvelopeCheck(payload.result.content[0].text, bytes);
    assert.deepEqual(calls, [...replies.keys()]);
  });

  test(`/${binding.prefix}/mcp rejects the other binding and legacy inbound tokens`, async () => {
    let limiterCalls = 0;
    let fetchCalls = 0;
    const env = prefixTestEnv();
    env[binding.limiterKey] = { async limit() { limiterCalls++; return { success: true }; } };
    for (const token of [`${binding.sibling}-inbound-test-token`, CONNECTOR_TOKEN]) {
      const request = prefixTestRequest(`/${binding.prefix}/mcp`, binding.prefix);
      request.headers.set("authorization", `Bearer ${token}`);
      const response = await handleRequest(request, env, async () => {
        fetchCalls++;
        throw new Error("unauthorized requests must not fetch");
      });
      assert.equal(response.status, 401);
      assert.equal(await response.text(), "Unauthorized");
    }
    assert.equal(limiterCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  for (const secret of [binding.connectorKey, binding.githubKey]) {
    test(`/${binding.prefix}/mcp fails closed when ${secret} is missing or empty without reading shared credentials`, async () => {
      for (const missing of [undefined, ""]) {
        const env = prefixTestEnv();
        env[secret] = missing;
        let legacyReads = 0;
        let limiterCalls = 0;
        let fetchCalls = 0;
        Object.defineProperties(env, {
          CONNECTOR_TOKEN: { get() { legacyReads++; return `${binding.prefix}-inbound-test-token`; } },
          GITHUB_TOKEN: { get() { legacyReads++; return "shared-outbound-test-token"; } },
          MCP_RATE_LIMITER: { get() { legacyReads++; return ALLOW_RATE_LIMITER; } },
        });
        env[binding.limiterKey] = { async limit() { limiterCalls++; return { success: true }; } };
        const neverFetch: FetchLike = async () => {
          fetchCalls++;
          throw new Error("unconfigured requests must not fetch");
        };
        for (const method of ["initialize", "ping", "tools/list", "tools/call"]) {
          const response = await handleRequest(
            prefixTestRequest(`/${binding.prefix}/mcp`, binding.prefix, method), env, neverFetch,
          );
          assert.equal(response.status, 503);
          assert.equal(await response.text(), "Service unavailable");
        }
        const sibling = await handleRequest(
          prefixTestRequest(`/${binding.sibling}/mcp`, binding.sibling, "tools/list"), env, neverFetch,
        );
        assert.equal(sibling.status, 200);
        assert.equal(legacyReads, 0);
        assert.equal(limiterCalls, 0);
        assert.equal(fetchCalls, 0);
      }
    });
  }

  test(`/${binding.prefix}/mcp uses only its rate limiter and isolates missing, throwing, and exhausted limits`, async () => {
    for (const mode of ["missing", "throwing", "exhausted"] as const) {
      const env = prefixTestEnv();
      const keys: string[] = [];
      let legacyReads = 0;
      Object.defineProperty(env, "MCP_RATE_LIMITER", {
        get() { legacyReads++; return ALLOW_RATE_LIMITER; },
      });
      env[binding.limiterKey] = mode === "missing" ? undefined : {
        async limit({ key }) {
          keys.push(key);
          if (mode === "throwing") throw new Error("limiter unavailable");
          return { success: false };
        },
      };
      const neverFetch: FetchLike = async () => { throw new Error("ping must not fetch"); };
      const response = await handleRequest(
        prefixTestRequest(`/${binding.prefix}/mcp`, binding.prefix), env, neverFetch,
      );
      assert.equal(response.status, mode === "exhausted" ? 429 : 503);
      assert.equal(response.headers.get("retry-after"), mode === "exhausted" ? "60" : null);
      assert.deepEqual(keys, mode === "missing" ? [] : ["mcp-connector"]);
      const sibling = await handleRequest(
        prefixTestRequest(`/${binding.sibling}/mcp`, binding.sibling), env, neverFetch,
      );
      assert.equal(sibling.status, 200);
      assert.equal(legacyReads, 0);
    }
  });
}

test("unregistered prefixes and noncanonical MCP paths return 404 before accessing any binding", async () => {
  let envReads = 0;
  let fetchCalls = 0;
  const env = new Proxy(prefixTestEnv(), { get() { envReads++; throw new Error("404 must not read env"); } });
  for (const pathname of [
    "/mcp", "/", "/unknown/mcp", "/primary", "/secondary", "/primary/", "/secondary/",
    "/primary/mcp/", "/secondary/mcp/", "/primary/mcp/extra", "/secondary/mcp/extra",
    "/primary/health", "/secondary/sse", "/primary/messages", "/PRIMARY/mcp", "/primary//mcp",
    "//primary/mcp", "/%70rimary/mcp", "/primary%2fmcp", "/primary/%6dcp",
    "/constructor/mcp", "/__proto__/mcp", "/toString/mcp", "/health", "/sse",
    "/mcp?prefix=primary", "/?prefix=secondary",
  ]) {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await handleRequest(
        new Request(`https://worker.example${pathname}`, { method }), env,
        async () => { fetchCalls++; throw new Error("404 must not fetch"); },
      );
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.equal(await response.text(), "Not Found");
    }
  }
  assert.equal(envReads, 0);
  assert.equal(fetchCalls, 0);
});

test("each route exposes the E2-A tools/list baseline and unchanged older subsets", async () => {
  // E-0002 normalization; E2-A adds delete_branch without changing existing declarations.
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [
        key, normalize((value as Record<string, unknown>)[key]),
      ]));
    }
    return value;
  }
  const digest = (value: unknown) => createHash("sha256")
    .update(JSON.stringify(normalize(value)), "utf8").digest("hex");
  let fetchCalls = 0;
  for (const binding of PREFIX_CASES) {
    const response = await rpc(async () => {
      fetchCalls++;
      throw new Error("tools/list must not fetch upstream");
    }, "tools/list", undefined, {
      pathname: `/${binding.prefix}/mcp`,
      authorization: `Bearer ${binding.prefix}-inbound-test-token`,
      env: { ...prefixTestEnv(), SERVICE_VERSION: "test-version" },
    });
    assert.equal(response.status, 200);
    const { result } = await response.json() as any;
    const projection = {
      tools: result.tools.map(({ name, inputSchema }: any) => ({ name, inputSchema }))
        .sort((a: any, b: any) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    };
    for (const tool of result.tools) {
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /"owner"|"repo"/);
    }
    assert.equal(digest(projection), "ebc01bfa7973e850063c60b9a8fcb5d4a6d94f59a8e6566eb5e45327a4606627");
    assert.equal(digest(result), "d279d69a50635ab77272bc22dcf5d5c13c7467777ea20878b664f31055c5e3c6");
    const g3cResult = { ...result, tools: result.tools.filter((tool: any) => tool.name !== "delete_branch") };
    const g3cProjection = { tools: projection.tools.filter((tool: any) => tool.name !== "delete_branch") };
    assert.equal(digest(g3cProjection), "63533618387ad20b9249619536c11d911c5acbd04445bf5ebb9e2ecf78c1ff01");
    assert.equal(digest(g3cResult), "be0494d776d7966ab87ef2f0591674e16623f666d2103c637f31015d07082829");
    const g3bResult = { ...g3cResult, tools: g3cResult.tools.filter((tool: any) => tool.name !== "search_repo_index") };
    const g3bProjection = { tools: g3cProjection.tools.filter((tool: any) => tool.name !== "search_repo_index") };
    assert.equal(digest(g3bProjection), "e4f0ce46a0e669350713436d92d3179b7207be47d649e91df883bc9da37893d8");
    assert.equal(digest(g3bResult), "cb1384e111f42727f3f0dd06308793594b38f87c78f6e345a76dd067af685309");
    const g3aResult = { ...g3bResult, tools: g3bResult.tools.filter((tool: any) => tool.name !== "list_tree") };
    const g3aProjection = { tools: g3bProjection.tools.filter((tool: any) => tool.name !== "list_tree") };
    // Old schemas are stable; full declarations reflect both authorized semantic changes.
    assert.equal(digest(g3aProjection), "60c6ab3cdfa3fc917580f492e0b48c9dac60e964c0b7a2700e7d8ab914b08fcc");
    assert.equal(digest(g3aResult), "76063452a0f330cac53a3593adb03da5869b6c6f27b059c810dff761ba472608");
    const directoryResult = { ...g3bResult, tools: g3bResult.tools.filter((tool: any) => !["list_tree", "create_branch", "get_commit_metadata"].includes(tool.name)) };
    const directoryProjection = { tools: g3bProjection.tools.filter((tool: any) => !["list_tree", "create_branch", "get_commit_metadata"].includes(tool.name)) };
    assert.equal(digest(directoryProjection), "912759554f272eb7c9bb2e5eade64fc782132b7468adda5d53afedc58f611113");
    assert.equal(digest(directoryResult), "8efa1a47a009a834abcdefbd5a2491fd004151a3d9ff47087ca61499d2abdb9d");
    const previousResult = { ...directoryResult, tools: directoryResult.tools.filter((tool: any) => tool.name !== "list_directory") };
    const previousProjection = { tools: directoryProjection.tools.filter((tool: any) => tool.name !== "list_directory") };
    assert.equal(digest(previousProjection), "0c99afea90ce0c0043b6468efbd1afaf2c2578b39ef342298287cc4f71a7581c");
    assert.equal(digest(previousResult), "dc0bcb9647d6a2767e66f13695ee3e8893442457520f6b992a5a0ea8f83a8bb5");
    // The legacy subset now includes the explicitly authorized put_files_text schema change.
    const legacyResult = { ...previousResult, tools: previousResult.tools.filter((tool: any) => tool.name !== "resolve_ref") };
    const legacyProjection = {
      tools: previousProjection.tools.filter((tool: any) => tool.name !== "resolve_ref"),
    };
    assert.equal(digest(legacyProjection), "a8fbd06b58c410c4456b11b5f5dbc0b5f493c293a6248a04b486427a7dd841e4");
    assert.equal(digest(legacyResult), "8a62e4e6aa04f60cbf21c35eb39196612634ccf6a7604b15a8114e696e0c8fab");
  }
  assert.equal(fetchCalls, 0);
});

test("Wrangler assigns each prefix a distinct rate limit namespace", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.ratelimits.map((limiter: any) => limiter.name).sort(), [
    "MCP_RATE_LIMITER_PRIMARY", "MCP_RATE_LIMITER_SECONDARY",
  ]);
  assert.equal(new Set(config.ratelimits.map((limiter: any) => limiter.namespace_id)).size, 2);
  for (const limiter of config.ratelimits) {
    assert.match(limiter.namespace_id, /^[1-9][0-9]*$/);
    assert.notEqual(limiter.namespace_id, "2026083002");
    assert.deepEqual(limiter.simple, { limit: 60, period: 60 });
  }
});

function createBranchMock(options: {
  exists?: boolean;
  race?: boolean;
  sourceMissing?: boolean;
  sourcePayload?: unknown;
  createdPayload?: unknown;
  postStatus?: number;
  postThrows?: boolean;
  postInvalidJson?: boolean;
  prefix?: string;
} = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const prefix = options.prefix ?? "/repos/fixture-owner/primary-repository";
  let exists = options.exists ?? false;
  const fetcher: FetchLike = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    assert.ok(path.startsWith(`${prefix}/`), path);
    if (method === "GET" && path.startsWith(`${prefix}/git/ref/heads/`)) {
      return new Response(JSON.stringify(exists ? { object: { sha: FULL_COMMIT } } : { message: "Not Found" }), { status: exists ? 200 : 404 });
    }
    if (method === "GET" && path === `${prefix}/git/commits/${FULL_COMMIT}`) {
      return new Response(JSON.stringify(options.sourcePayload ?? { sha: FULL_COMMIT, tree: { sha: "d".repeat(40) } }), { status: options.sourceMissing ? 404 : 200 });
    }
    if (method === "POST" && path === `${prefix}/git/refs`) {
      if (options.postThrows) throw new Error(`secret ${GITHUB_TOKEN}`);
      if (options.postInvalidJson) return new Response("invalid success body");
      if (options.race) exists = true;
      return new Response(JSON.stringify(options.createdPayload ?? { ref: body.ref, object: { sha: body.sha, type: "commit" } }), {
        status: exists ? 422 : options.postStatus ?? 201,
      });
    }
    throw new Error(`Unexpected mock request ${method} ${path}`);
  };
  return { fetcher, calls };
}

async function callBranchTool(fetcher: FetchLike, args: Record<string, unknown>) {
  const response = await rpc(fetcher, "tools/call", { name: "create_branch", arguments: args }, {
    pathname: "/primary/mcp",
    env: { ...OBSERVATION_ENV, PRIMARY_REPOSITORY: "fixture-owner/primary-repository", CONNECTOR_TOKEN_PRIMARY: CONNECTOR_TOKEN, GITHUB_TOKEN_PRIMARY: GITHUB_TOKEN, MCP_RATE_LIMITER_PRIMARY: ALLOW_RATE_LIMITER },
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  const result = payload.result;
  assertTextOnly(result);
  return { result, text: result.content[0].text as string };
}

test("G3-A schemas register create_branch as a write tool and extend only the multi-file deletion input", async () => {
  const response = await rpc(async () => { throw new Error("Listing must not fetch"); }, "tools/list");
  const { result } = await response.json() as any;
  const branch = result.tools.find((tool: any) => tool.name === "create_branch");
  const multi = result.tools.find((tool: any) => tool.name === "put_files_text");
  const single = result.tools.find((tool: any) => tool.name === "put_file_text");
  assert.deepEqual(branch.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(multi.annotations, { ...branch.annotations, destructiveHint: true });
  assert.deepEqual(single.annotations, multi.annotations);
  assert.equal(branch.inputSchema.additionalProperties, false);
  assert.deepEqual(branch.inputSchema.required, ["branch", "from_commit_sha"]);
  assert.deepEqual(Object.keys(branch.inputSchema.properties), ["branch", "from_commit_sha"]);
  assert.equal(branch.inputSchema.properties.branch.maxLength, 200);
  assert.equal(branch.inputSchema.properties.from_commit_sha.pattern, "^[0-9a-fA-F]{40}$");
  assert.deepEqual(multi.inputSchema.required, ["files", "message"]);
  assert.equal(multi.inputSchema.properties.files.minItems, 0);
  assert.equal(multi.inputSchema.properties.deletions.type, "array");
  assert.equal(multi.inputSchema.properties.deletions.maxItems, 20);
  assert.equal(multi.inputSchema.properties.deletions.uniqueItems, true);
  assert.match(multi.description, /deletions count toward this limit but not the 262144-byte/);
  assert.equal(Object.hasOwn(single.inputSchema.properties, "deletions"), false);
  assert.doesNotMatch(JSON.stringify([branch.inputSchema, multi.inputSchema]), /"owner"|"repo"|"ref"/);
});

test("create_branch validates required immutable input before fetching and preserves tool error diagnostics", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, "INVALID_BRANCH"],
    [{ branch: "new" }, "INVALID_COMMIT_SHA"],
    ...["", "/new", "new/", "new//child", "new..child", "new branch", "n".repeat(201)].map((branch): [Record<string, unknown>, string] => [{ branch, from_commit_sha: FULL_COMMIT }, "INVALID_BRANCH"]),
    [{ branch: "new", from_commit_sha: "abc1234" }, "SHORT_COMMIT_SHA"],
    [{ branch: "new", from_commit_sha: "main" }, "REF_NAME_NOT_ALLOWED"],
    [{ branch: "new", from_commit_sha: "refs/heads/main" }, "REF_NAME_NOT_ALLOWED"],
    [{ branch: "new", from_commit_sha: 123 }, "INVALID_COMMIT_SHA"],
    ...["owner", "repo", "ref", "force"].map((key): [Record<string, unknown>, string] => [{ branch: "new", from_commit_sha: FULL_COMMIT, [key]: "override" }, "UNEXPECTED_ARGUMENT"]),
  ];
  for (const [args, code] of cases) {
    const mock = createBranchMock();
    const result = await callBranchTool(mock.fetcher, args);
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    const fields = parseToolErrorFields(result.text);
    assert.equal(fields.result, "null");
    assert.equal(fields.github_fetch_attempted, "false");
    assert.equal(mock.calls.length, 0);
  }
});

test("create_branch returns the immutable lowercase commit and diagnostics after its Git Refs POST", async () => {
  for (const branch of ["codex/new-branch", "n".repeat(200)]) {
    const mock = createBranchMock();
    const result = await callBranchTool(mock.fetcher, { branch, from_commit_sha: FULL_COMMIT.toUpperCase() });
    assert.equal(result.result.isError, undefined);
    const value = JSON.parse(result.text);
    assert.equal(value.branch, branch);
    assert.equal(value.commit_sha, FULL_COMMIT);
    assert.match(value.commit_sha, /^[0-9a-f]{40}$/);
    assertJsonObservation(value, true, "succeeded");
    for (const field of ["byte_length", "chunk_bytes", "files", "owner", "repo"]) assert.equal(Object.hasOwn(value, field), false);
    assert.doesNotMatch(result.text, /---BEGIN FILE/);
    const prefix = "/repos/fixture-owner/primary-repository";
    assert.deepEqual(mock.calls, [
      { method: "GET", path: `${prefix}/git/commits/${FULL_COMMIT}`, body: undefined },
      { method: "POST", path: `${prefix}/git/refs`, body: { ref: `refs/heads/${branch}`, sha: FULL_COMMIT } },
    ]);
  }
});

test("create_branch never overwrites an existing branch, including a competing creation", async () => {
  for (const options of [{ exists: true }, { race: true }]) {
    const mock = createBranchMock(options);
    const result = await callBranchTool(mock.fetcher, { branch: "new", from_commit_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "BRANCH_ALREADY_EXISTS");
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assert.equal(mock.calls.filter((call) => call.method === "POST").length, 1);
    assert.ok(mock.calls.every((call) => call.method === "GET" || call.method === "POST"));
  }
});

test("create_branch reports upstream failures without retrying writes or leaking credentials", async () => {
  const cases: Array<[Parameters<typeof createBranchMock>[0], string]> = [
    [{ sourceMissing: true }, "COMMIT_NOT_FOUND"],
    [{ sourcePayload: { sha: "d".repeat(40) } }, "GITHUB_COMMIT_RESPONSE_INVALID"],
    [{ sourcePayload: { sha: 42 } }, "GITHUB_COMMIT_RESPONSE_INVALID"],
    [{ createdPayload: { object: { sha: "d".repeat(40) } } }, "GITHUB_REF_RESPONSE_INVALID"],
    [{ createdPayload: { object: { sha: 42 } } }, "GITHUB_REF_RESPONSE_INVALID"],
    [{ createdPayload: { ref: "refs/heads/other", object: { sha: FULL_COMMIT } } }, "GITHUB_REF_RESPONSE_INVALID"],
    [{ postStatus: 422 }, "GITHUB_CONFLICT"],
    [{ postStatus: 403 }, "GITHUB_FORBIDDEN"],
    [{ postThrows: true }, "GITHUB_NETWORK_ERROR"],
    [{ postInvalidJson: true }, "GITHUB_INVALID_JSON"],
  ];
  for (const [options, code] of cases) {
    const mock = createBranchMock(options);
    const result = await callBranchTool(mock.fetcher, { branch: "new", from_commit_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    assert.equal(parseToolErrorFields(result.text).github_fetch_attempted, "true");
    assert.equal(result.text.includes(GITHUB_TOKEN), false);
    assert.equal(result.text.includes(CONNECTOR_TOKEN), false);
    assert.ok(mock.calls.filter((call) => call.method === "POST").length <= 1);
    assert.equal(mock.calls.some((call) => call.method === "PATCH" || call.method === "DELETE"), false);
  }
});

test("create_branch constructs every REST path from an injected repository binding", async () => {
  const binding = { owner: "injected-owner", repo: "injected-repo" };
  const prefix = `/repos/${binding.owner}/${binding.repo}`;
  const mock = createBranchMock({ prefix });
  const observation = new ObservationContext(OBSERVATION_ENV);
  const client = new GitHubClient(GITHUB_TOKEN, mock.fetcher, "test-version", observation, binding);
  const result = await callServiceTool(client, "test-version", "create_branch", {
    branch: "branch/new", from_commit_sha: FULL_COMMIT,
  }, observation);
  assert.equal(JSON.parse(result.content[0].text).commit_sha, FULL_COMMIT);
  assert.ok(mock.calls.every((call) => call.path.startsWith(`${prefix}/`)));
});

interface DeleteBranchMockFailure {
  stage: "repository" | "target" | "default" | "compare" | "delete";
  status?: number;
  payload?: unknown;
  raw?: string;
  throws?: boolean;
  headers?: Record<string, string>;
}

function deleteBranchMock(options: {
  prefix?: string;
  branch?: string;
  defaultBranch?: string;
  defaultHead?: string;
  heads?: string[];
  comparisonStatus?: string;
  failure?: DeleteBranchMockFailure;
} = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const prefix = options.prefix ?? "/repos/fixture-owner/primary-repository";
  const branch = options.branch ?? "feature/merged";
  const defaultBranch = options.defaultBranch ?? "main";
  const defaultHead = options.defaultHead ?? "d".repeat(40);
  const heads = options.heads ?? [FULL_COMMIT];
  let headReads = 0;
  const hostileMessage = `upstream-secret ${GITHUB_TOKEN} ${CONNECTOR_TOKEN} https://private.invalid/ref`;
  const reply = (stage: string, payload: unknown, status = 200) => {
    const failure = options.failure?.stage === stage ? options.failure : undefined;
    if (failure?.throws) throw new Error(hostileMessage);
    return new Response(failure?.raw ?? (status === 204 && !failure ? null : JSON.stringify(
      failure ? Object.hasOwn(failure, "payload") ? failure.payload : { message: hostileMessage } : payload,
    )), { status: failure?.status ?? status, headers: failure?.headers });
  };
  const fetcher: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    const path = url.pathname;
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body });
    assert.ok(path === prefix || path.startsWith(`${prefix}/`), path);
    if (method === "GET" && path === prefix) return reply("repository", { default_branch: defaultBranch });
    if (method === "GET" && path === `${prefix}/git/ref/heads/${encodeURIComponent(branch)}`) {
      const sha = heads[Math.min(headReads++, heads.length - 1)];
      return reply("target", { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }
    if (method === "GET" && path === `${prefix}/git/ref/heads/${encodeURIComponent(defaultBranch)}`) {
      return reply("default", { ref: `refs/heads/${defaultBranch}`, object: { sha: defaultHead, type: "commit" } });
    }
    if (method === "GET" && path === `${prefix}/compare/${defaultHead}...${heads[0]}`) {
      return reply("compare", {
        status: options.comparisonStatus ?? "behind",
        base_commit: { sha: defaultHead },
        merge_base_commit: { sha: heads[0] },
      });
    }
    if (method === "DELETE" && path === `${prefix}/git/refs/heads/${encodeURIComponent(branch)}`) {
      return reply("delete", null, 204);
    }
    throw new Error(`Unexpected mock request ${method} ${path}`);
  };
  return { fetcher, calls };
}

async function callDeleteBranchTool(fetcher: FetchLike, args: Record<string, unknown>, prefix = "primary") {
  const response = await rpc(fetcher, "tools/call", { name: "delete_branch", arguments: args }, {
    pathname: `/${prefix}/mcp`,
    authorization: `Bearer ${prefix}-inbound-test-token`,
    env: { ...OBSERVATION_ENV, ...prefixTestEnv() },
  });
  assert.equal(response.status, 200);
  const { result } = await response.json() as any;
  assertTextOnly(result);
  return { result, text: result.content[0].text as string };
}

test("delete_branch exposes only the two required inputs and destructive write annotations", async () => {
  const response = await rpc(async () => { throw new Error("Listing must not fetch"); }, "tools/list");
  const { result } = await response.json() as any;
  const tool = result.tools.find((entry: any) => entry.name === "delete_branch");
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ["branch", "expected_head_sha"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["branch", "expected_head_sha"]);
  const create = result.tools.find((entry: any) => entry.name === "create_branch");
  assert.deepEqual(tool.inputSchema.properties.branch, create.inputSchema.properties.branch);
  assert.equal(tool.inputSchema.properties.expected_head_sha.pattern, "^[0-9a-fA-F]{40}$");
  assert.doesNotMatch(JSON.stringify(tool.inputSchema), /"owner"|"repo"|"force"|"skip_ancestor_check"/);
  assert.match(tool.description, /no atomic expected-SHA condition/);
});

test("delete_branch rejects missing, invalid, abbreviated and unknown arguments before any fetch", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, "INVALID_BRANCH"],
    [{ branch: "feature/merged" }, "INVALID_COMMIT_SHA"],
    ...["", "/new", "new/", "new//child", "new..child", "new@{child", "new branch", "n".repeat(201), 123].map((branch): [Record<string, unknown>, string] => [{ branch, expected_head_sha: FULL_COMMIT }, "INVALID_BRANCH"]),
    [{ branch: "feature/merged", expected_head_sha: "abc1234" }, "SHORT_COMMIT_SHA"],
    [{ branch: "feature/merged", expected_head_sha: "main" }, "REF_NAME_NOT_ALLOWED"],
    [{ branch: "feature/merged", expected_head_sha: 123 }, "INVALID_COMMIT_SHA"],
    ...["owner", "repo", "ref", "force", "skip_ancestor_check", "unknown"].map((key): [Record<string, unknown>, string] => [{ branch: "feature/merged", expected_head_sha: FULL_COMMIT, [key]: "override" }, "UNEXPECTED_ARGUMENT"]),
  ];
  for (const [args, code] of cases) {
    const mock = deleteBranchMock();
    const result = await callDeleteBranchTool(mock.fetcher, args);
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).github_fetch_attempted, "false");
    assert.equal(mock.calls.length, 0);
  }
});

test("delete_branch rejects the actual default branch, including a non-main default, without writes", async () => {
  for (const branch of ["main", "release/stable"]) {
    const mock = deleteBranchMock({ branch, defaultBranch: branch });
    const result = await callDeleteBranchTool(mock.fetcher, { branch, expected_head_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "DEFAULT_BRANCH_DELETE_FORBIDDEN");
    assert.deepEqual(mock.calls.map(({ method }) => method), ["GET"]);
  }
});

test("delete_branch compares the expected head literally and rechecks changes during comparison without echoing the head", async () => {
  const changedHead = "c".repeat(40);
  for (const [heads, expected] of [
    [[changedHead], FULL_COMMIT],
    [[FULL_COMMIT], FULL_COMMIT.toUpperCase()],
    [[FULL_COMMIT, changedHead], FULL_COMMIT],
  ] as const) {
    const mock = deleteBranchMock({ heads: [...heads] });
    const result = await callDeleteBranchTool(mock.fetcher, { branch: "feature/merged", expected_head_sha: expected });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "BRANCH_HEAD_MISMATCH");
    assert.equal(result.text.includes(changedHead), false);
    assert.equal(result.text.includes(FULL_COMMIT), false);
    assert.ok(mock.calls.every(({ method }) => method === "GET"));
    assert.equal(mock.calls.some(({ path }) => path.includes("/compare/")), heads.length === 2);
  }
});

test("delete_branch refuses both ahead and diverged comparisons before any write", async () => {
  for (const comparisonStatus of ["ahead", "diverged"]) {
    const mock = deleteBranchMock({ comparisonStatus });
    const result = await callDeleteBranchTool(mock.fetcher, { branch: "feature/merged", expected_head_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), "BRANCH_NOT_MERGED");
    assert.ok(mock.calls.every(({ method }) => method === "GET"));
    assert.ok(mock.calls.at(-1)?.path.endsWith(`/compare/${"d".repeat(40)}...${FULL_COMMIT}`));
  }
});

test("delete_branch accepts behind and identical in both bound routes and returns deletion identity with diagnostics", async () => {
  for (const binding of PREFIX_CASES) {
    for (const comparisonStatus of ["behind", "identical"]) {
      const prefix = `/repos/fixture-owner/${binding.repository}`;
      const defaultHead = comparisonStatus === "identical" ? FULL_COMMIT : "d".repeat(40);
      const mock = deleteBranchMock({ prefix, defaultHead, comparisonStatus });
      const result = await callDeleteBranchTool(mock.fetcher, { branch: "feature/merged", expected_head_sha: FULL_COMMIT }, binding.prefix);
      assert.equal(result.result.isError, undefined);
      const value = JSON.parse(result.text);
      assert.equal(value.branch, "feature/merged");
      assert.equal(value.deleted_commit_sha, FULL_COMMIT);
      assertJsonObservation(value, true, "succeeded");
      const { branch, deleted_commit_sha, ...diagnostics } = value;
      assert.deepEqual(Object.keys(diagnostics).sort(), Object.keys(new ObservationContext(OBSERVATION_ENV).snapshot()).sort());
      assert.deepEqual(mock.calls, [
        { method: "GET", path: prefix, body: undefined },
        { method: "GET", path: `${prefix}/git/ref/heads/feature%2Fmerged`, body: undefined },
        { method: "GET", path: `${prefix}/git/ref/heads/main`, body: undefined },
        { method: "GET", path: `${prefix}/compare/${defaultHead}...${FULL_COMMIT}`, body: undefined },
        { method: "GET", path: `${prefix}/git/ref/heads/feature%2Fmerged`, body: undefined },
        { method: "DELETE", path: `${prefix}/git/refs/heads/feature%2Fmerged`, body: undefined },
      ]);
    }
  }
});

test("deleteBranch constructs paths from injected owners and validates inputs when called directly", async () => {
  for (const binding of [{ owner: "injected-one", repo: "repo-one" }, { owner: "injected-two", repo: "repo-two" }]) {
    const prefix = `/repos/${binding.owner}/${binding.repo}`;
    const mock = deleteBranchMock({ prefix, branch: "main", defaultBranch: "release/stable" });
    const observation = new ObservationContext(OBSERVATION_ENV);
    const client = new GitHubClient(GITHUB_TOKEN, mock.fetcher, "test-version", observation, binding);
    await assert.rejects(client.deleteBranch("bad branch", FULL_COMMIT), { code: "INVALID_BRANCH" });
    await assert.rejects(client.deleteBranch("main", "main"), { code: "REF_NAME_NOT_ALLOWED" });
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(await client.deleteBranch("main", FULL_COMMIT), { branch: "main", deleted_commit_sha: FULL_COMMIT });
    assert.ok(mock.calls.every(({ path }) => path === prefix || path.startsWith(`${prefix}/`)));
    assert.ok(mock.calls.some(({ path }) => path.endsWith("/git/ref/heads/release%2Fstable")));
  }
});

test("delete_branch classifies upstream refusals and uncertain deletion failures without retrying or leaking payloads", async () => {
  const cases: Array<readonly [DeleteBranchMockFailure, string]> = [
    ...(["repository", "target", "default", "compare", "delete"] as const).flatMap((stage) => [
      [{ stage, status: 403 }, "GITHUB_FORBIDDEN"],
      [{ stage, status: 422 }, "GITHUB_CONFLICT"],
    ] as const),
    [{ stage: "target", status: 404 }, "BRANCH_NOT_FOUND"],
    [{ stage: "delete", status: 404 }, "BRANCH_NOT_FOUND"],
    [{ stage: "delete", status: 403, headers: { "x-ratelimit-remaining": "0" } }, "GITHUB_QUOTA_EXCEEDED"],
    [{ stage: "delete", status: 403, headers: { "retry-after": "30" } }, "GITHUB_QUOTA_EXCEEDED"],
    [{ stage: "delete", status: 500 }, "GITHUB_UPSTREAM_ERROR"],
    [{ stage: "delete", throws: true }, "GITHUB_NETWORK_ERROR"],
    [{ stage: "delete", status: 200, raw: "not JSON" }, "GITHUB_INVALID_JSON"],
    [{ stage: "delete", status: 200, payload: null }, "GITHUB_DELETE_RESPONSE_INVALID"],
  ];
  for (const [failure, code] of cases) {
    const mock = deleteBranchMock({ failure });
    const result = await callDeleteBranchTool(mock.fetcher, { branch: "feature/merged", expected_head_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.equal(parseToolErrorFields(result.text).result, "null");
    for (const secret of [GITHUB_TOKEN, CONNECTOR_TOKEN, "upstream-secret", "private.invalid", "https://api.github.com"])
      assert.equal(result.text.includes(secret), false);
    assert.equal(mock.calls.filter(({ method }) => method === "DELETE").length, failure?.stage === "delete" ? 1 : 0);
    assert.ok(mock.calls.every(({ method }) => method === "GET" || method === "DELETE"));
    if (failure?.stage === "delete") assert.equal(mock.calls.at(-1)?.method, "DELETE");
  }
});

test("delete_branch fails closed on incomplete or contradictory upstream metadata without writes", async () => {
  const cases: Array<readonly [DeleteBranchMockFailure, string]> = [
    ...[null, {}, { default_branch: "" }, { default_branch: 42 }].map((payload) => [{ stage: "repository", status: 200, payload }, "GITHUB_REPOSITORY_RESPONSE_INVALID"] as const),
    ...[null, {}, { ref: "refs/heads/other", object: { sha: FULL_COMMIT } }, { ref: "refs/heads/feature/merged", object: { sha: "short" } }].map((payload) => [{ stage: "target", status: 200, payload }, "GITHUB_REF_RESPONSE_INVALID"] as const),
    [{ stage: "default", status: 200, payload: {} }, "GITHUB_REF_RESPONSE_INVALID"],
    ...[
      null, {}, { status: "unknown", base_commit: { sha: "d".repeat(40) } },
      { status: "behind", base_commit: { sha: FULL_COMMIT }, merge_base_commit: { sha: FULL_COMMIT } },
      { status: "behind", base_commit: { sha: "d".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } },
      { status: "identical", base_commit: { sha: "d".repeat(40) }, merge_base_commit: { sha: FULL_COMMIT } },
    ].map((payload) => [{ stage: "compare", status: 200, payload }, "GITHUB_COMPARE_RESPONSE_INVALID"] as const),
  ];
  for (const [failure, code] of cases) {
    const mock = deleteBranchMock({ failure });
    const result = await callDeleteBranchTool(mock.fetcher, { branch: "feature/merged", expected_head_sha: FULL_COMMIT });
    assert.equal(result.result.isError, true);
    assert.equal(errorCode(result.text), code);
    assert.ok(mock.calls.every(({ method }) => method === "GET"));
  }
});

test("deployment repository configuration fails closed and never falls back to another channel", async () => {
  let fetchCalls = 0;
  const neverFetch: FetchLike = async () => { fetchCalls++; throw new Error("must not fetch"); };
  for (const value of [undefined, "", "example-owner/example-repository", "owner/repo/extra", "../repo", "owner/..", "owner/repo?ref=main", "owner/repo%2Fescape", " owner/repo", "owner/repo\n"]) {
    const env = { ...prefixTestEnv(), PRIMARY_REPOSITORY: value };
    const primary = await handleRequest(prefixTestRequest("/primary/mcp", "primary"), env, neverFetch);
    assert.equal(primary.status, 503, `invalid configured repository: ${JSON.stringify(value)}`);
    assert.equal(await primary.text(), "Service unavailable");
    const secondary = await handleRequest(prefixTestRequest("/secondary/mcp", "secondary"), env, neverFetch);
    assert.equal(secondary.status, 200);
  }
  assert.equal(fetchCalls, 0);
});

test("deployment owner and repository bind the upstream independently of URL query parameters", async () => {
  const calls: string[] = [];
  const response = await rpc(async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(url.pathname, "/repos/configured-owner/configured.repo/commits/main");
    return new Response(JSON.stringify({ sha: FULL_COMMIT }));
  }, "tools/call", { name: "resolve_ref", arguments: { ref: "main" } }, {
    pathname: "/primary/mcp?owner=attacker&repo=other",
    authorization: "Bearer primary-inbound-test-token",
    env: { ...prefixTestEnv(), PRIMARY_REPOSITORY: "configured-owner/configured.repo", SECONDARY_REPOSITORY: "" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).result.isError, undefined);
  assert.equal(calls.length, 1);
});

test("custom allowed origins are exact and do not bypass bearer authentication", async () => {
  const neverFetch: FetchLike = async () => { throw new Error("ping must not fetch"); };
  const env = { ...prefixTestEnv(), ALLOWED_ORIGINS: "https://client.example, http://localhost:3000" };
  for (const [origin, expected] of [
    ["https://client.example", 200], ["http://localhost:3000", 200],
    ["https://client.example.attacker.invalid", 403], ["https://perplexity.ai", 403],
    ["null", 403], ["https://client.example/", 403],
  ] as const) {
    const request = prefixTestRequest("/primary/mcp", "primary");
    request.headers.set("origin", origin);
    assert.equal((await handleRequest(request, env, neverFetch)).status, expected);
  }
  const unauthorized = prefixTestRequest("/primary/mcp", "primary");
  unauthorized.headers.set("origin", "https://client.example");
  unauthorized.headers.delete("authorization");
  assert.equal((await handleRequest(unauthorized, env, neverFetch)).status, 401);
  const requestWithoutOrigin = prefixTestRequest("/primary/mcp", "primary");
  assert.equal((await handleRequest(requestWithoutOrigin, env, neverFetch)).status, 200);
});
