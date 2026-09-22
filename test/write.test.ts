import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/github.ts";
import { ObservationContext } from "../src/observation.ts";
import { callTool as callServiceTool } from "../src/service.ts";
import {
  decodeBase64,
  encodeBase64,
  encodeUtf8,
  gitBlobSha,
} from "../src/encoding.ts";
import type { FetchLike } from "../src/types.ts";
import {
  FULL_COMMIT,
  GITHUB_TOKEN,
  callTool,
  errorCode,
  json,
} from "./helpers.ts";

interface StoredEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface WriteMockOptions {
  initialFiles?: Array<{ path: string; content: string }>;
  ignoreDeletions?: boolean;
  truncateReadbackTree?: boolean;
  invalidReadbackTree?: boolean;
  patchBarrier?: number;
  failReadbackTree?: boolean;
  patchCommitThenThrow?: boolean;
  patchCommitThenBodyReadFailure?: boolean;
  patchCommitThenNonJson?: boolean;
  reconciliationObservedHead?: string;
}

async function createWriteMock(options: WriteMockOptions = {}) {
  const baseHead = "1".repeat(40);
  const baseTreeSha = "2".repeat(40);
  let head = baseHead;
  let objectCounter = 0x3000;
  let activeBlobCreates = 0;
  let maxActiveBlobCreates = 0;
  let patchCount = 0;
  let readbackTreeFailed = false;
  const patchWaiters: Array<() => void> = [];
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const forceValues: unknown[] = [];
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, StoredEntry>>([
    [baseTreeSha, new Map()],
  ]);
  const commits = new Map<string, { tree: string; parents: string[] }>([
    [baseHead, { tree: baseTreeSha, parents: [] }],
  ]);

  for (const file of options.initialFiles ?? []) {
    const bytes = encodeUtf8(file.content);
    const sha = await gitBlobSha(bytes);
    blobs.set(sha, bytes);
    trees.get(baseTreeSha)!.set(file.path, { path: file.path, mode: "100644", type: "blob", sha });
  }

  function nextSha(): string {
    objectCounter += 1;
    return objectCounter.toString(16).padStart(40, "0");
  }

  const fetcher: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (method === "GET" && url.pathname.endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: head } });
    }

    const commitGet = url.pathname.match(/\/git\/commits\/([0-9a-f]{40})$/);
    if (method === "GET" && commitGet) {
      const commit = commits.get(commitGet[1]);
      return commit
        ? json({ sha: commitGet[1], tree: { sha: commit.tree } })
        : json({ message: "Not Found" }, 404);
    }

    const treeGet = url.pathname.match(/\/git\/trees\/([0-9a-f]{40})$/);
    if (method === "GET" && treeGet) {
      const tree = trees.get(treeGet[1]);
      if (!tree) return json({ message: "Not Found" }, 404);
      const isReadback = treeGet[1] !== baseTreeSha;
      if (options.failReadbackTree && isReadback && !readbackTreeFailed) {
        readbackTreeFailed = true;
        return json({ message: "readback unavailable" }, 503);
      }
      return json({
        sha: treeGet[1],
        truncated: Boolean(options.truncateReadbackTree && isReadback),
        tree: options.invalidReadbackTree && isReadback ? {} : Array.from(tree.values()),
      });
    }

    if (method === "POST" && url.pathname.endsWith("/git/blobs")) {
      activeBlobCreates += 1;
      maxActiveBlobCreates = Math.max(maxActiveBlobCreates, activeBlobCreates);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const bytes = body.encoding === "base64"
        ? decodeBase64(body.content)
        : encodeUtf8(body.content);
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, bytes);
      activeBlobCreates -= 1;
      return json({ sha }, 201);
    }

    if (method === "POST" && url.pathname.endsWith("/git/trees")) {
      const base = trees.get(body.base_tree);
      assert.ok(base);
      const next = new Map(base);
      for (const entry of body.tree) {
        if (entry.sha === null) {
          assert.ok(base.has(entry.path), "deletion must name an existing base-tree path");
          if (!options.ignoreDeletions) {
            for (const path of next.keys()) {
              if (path === entry.path || path.startsWith(`${entry.path}/`)) next.delete(path);
            }
          }
          continue;
        }
        next.set(entry.path, {
          path: entry.path,
          mode: entry.mode,
          type: entry.type,
          sha: entry.sha,
        });
      }
      const sha = nextSha();
      trees.set(sha, next);
      return json({ sha }, 201);
    }

    if (method === "POST" && url.pathname.endsWith("/git/commits")) {
      const sha = nextSha();
      commits.set(sha, { tree: body.tree, parents: body.parents });
      return json({ sha, tree: { sha: body.tree } }, 201);
    }

    if (method === "PATCH" && url.pathname.endsWith("/git/refs/heads/main")) {
      patchCount += 1;
      forceValues.push(body.force);
      if (options.patchBarrier && patchCount <= options.patchBarrier) {
        await new Promise<void>((resolve) => {
          patchWaiters.push(resolve);
          if (patchWaiters.length === options.patchBarrier) {
            for (const release of patchWaiters) release();
          }
        });
      }
      const candidate = commits.get(body.sha);
      assert.ok(candidate);
      if (candidate.parents[0] !== head) {
        return json({ message: "Update is not a fast forward" }, 422);
      }
      head = options.reconciliationObservedHead ?? body.sha;
      if (options.patchCommitThenThrow) {
        throw new Error("simulated lost PATCH response");
      }
      if (options.patchCommitThenBodyReadFailure) {
        const response = json({ object: { sha: head } });
        Object.defineProperty(response, "text", {
          value: async () => {
            throw new Error("simulated PATCH body read failure");
          },
        });
        return response;
      }
      if (options.patchCommitThenNonJson) {
        return new Response("not-json", { status: 200 });
      }
      return json({ object: { sha: head } });
    }

    const blobGet = url.pathname.match(/\/git\/blobs\/([0-9a-f]{40})$/);
    if (method === "GET" && blobGet) {
      const bytes = blobs.get(blobGet[1]);
      return bytes
        ? json({
          sha: blobGet[1],
          size: bytes.byteLength,
          encoding: "base64",
          content: encodeBase64(bytes),
          truncated: false,
        })
        : json({ message: "Not Found" }, 404);
    }

    const contentsPrefix = "/repos/fixture-owner/secondary-repository/contents/";
    if (method === "GET" && url.pathname.startsWith(contentsPrefix)) {
      const path = url.pathname
        .slice(contentsPrefix.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const commitSha = url.searchParams.get("ref") ?? "";
      const commit = commits.get(commitSha);
      const entry = commit ? trees.get(commit.tree)?.get(path) : undefined;
      const bytes = entry ? blobs.get(entry.sha) : undefined;
      return entry && bytes
        ? json({
          type: "file",
          path,
          sha: entry.sha,
          size: bytes.byteLength,
          encoding: "base64",
          content: encodeBase64(bytes),
        })
        : json({ message: "Not Found" }, 404);
    }

    return json({ message: `Unhandled ${method} ${url.pathname}` }, 500);
  };

  return {
    fetcher,
    baseHead,
    get head() { return head; },
    calls,
    forceValues,
    trees,
    commits,
    blobs,
    get maxActiveBlobCreates() { return maxActiveBlobCreates; },
  };
}

test("expected_parent_sha mismatch rejects before creating any Git object", async () => {
  const mock = await createWriteMock();
  const result = await callTool(mock.fetcher, "put_file_text", {
    path: "diagnostics/readpath-selftest/run/wrong-parent.txt",
    content: "no write",
    message: "self-test: expected parent",
    branch: "main",
    expected_parent_sha: FULL_COMMIT,
  });
  assert.equal(result.result.isError, true);
  assert.equal(errorCode(result.text), "EXPECTED_PARENT_MISMATCH");
  assert.equal(mock.head, mock.baseHead);
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 0);
});

test("single-file write uses Git Data, force=false, and same-call readback", async () => {
  const mock = await createWriteMock();
  const path = "diagnostics/readpath-selftest/run/single.txt";
  const content = "single file\n中文\n";
  const result = await callTool(mock.fetcher, "put_file_text", {
    path,
    content,
    message: "self-test: single file",
    branch: "main",
    expected_parent_sha: mock.baseHead,
  });
  const receipt = JSON.parse(result.text);
  assert.equal(receipt.committed, true);
  assert.equal(receipt.before_head, mock.baseHead);
  assert.equal(receipt.after_head, mock.head);
  assert.equal(receipt.files.length, 1);
  assert.equal(receipt.files[0].path, path);
  assert.equal(receipt.files[0].verified, true);
  assert.equal(receipt.files[0].byte_length, encodeUtf8(content).byteLength);
  assert.equal(receipt.github_fetch_attempted, true);
  assert.equal(receipt.github_fetch_outcome, "succeeded");
  assert.deepEqual(mock.forceValues, [false]);
  assert.ok(
    mock.calls.some((call) =>
      call.method === "GET" && call.path.endsWith(`/git/commits/${receipt.after_head}`)
    ),
  );
  assert.equal(
    mock.calls.some((call) => call.path.includes("/contents/") && call.method === "PUT"),
    false,
  );

  const verified = await callTool(mock.fetcher, "verify_write", {
    path,
    commit_sha: receipt.after_head,
    expected_blob_sha: receipt.files[0].blob_sha,
  });
  const verification = JSON.parse(verified.text);
  assert.equal(verification.match, true);
  assert.equal(verification.github_fetch_attempted, true);
  assert.equal(verification.github_fetch_outcome, "succeeded");
});

test("20-file write is one commit, all files verify, and outbound concurrency stays at five", async () => {
  const mock = await createWriteMock();
  const files = Array.from({ length: 20 }, (_, index) => ({
    path: `diagnostics/readpath-selftest/run/multi-${index}.txt`,
    content: `file ${index}\n`,
  }));
  const result = await callTool(mock.fetcher, "put_files_text", {
    files,
    message: "self-test: twenty files",
    branch: "main",
    expected_parent_sha: mock.baseHead,
  });
  const receipt = JSON.parse(result.text);
  assert.equal(receipt.files.length, 20);
  assert.ok(receipt.files.every((file: any) => file.verified === true));
  assert.ok(mock.maxActiveBlobCreates <= 5);
  assert.ok(mock.calls.length <= 50, `subrequest count ${mock.calls.length}`);
  const commit = mock.commits.get(receipt.commit_sha);
  assert.deepEqual(commit?.parents, [mock.baseHead]);
});

test("two concurrent force=false updates from one parent allow at most one winner", async () => {
  const mock = await createWriteMock({ patchBarrier: 2 });
  const common = {
    message: "self-test: concurrent",
    branch: "main",
    expected_parent_sha: mock.baseHead,
  };
  const [left, right] = await Promise.all([
    callTool(mock.fetcher, "put_file_text", {
      ...common,
      path: "diagnostics/readpath-selftest/run/concurrent-left.txt",
      content: "left",
    }),
    callTool(mock.fetcher, "put_file_text", {
      ...common,
      path: "diagnostics/readpath-selftest/run/concurrent-right.txt",
      content: "right",
    }),
  ]);
  const outcomes = [left, right];
  const successes = outcomes.filter((outcome) => !outcome.result.isError);
  const failures = outcomes.filter((outcome) => outcome.result.isError);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(errorCode(failures[0].text), "REF_UPDATE_CONFLICT");
  assert.deepEqual(mock.forceValues, [false, false]);

  const winner = JSON.parse(successes[0].text);
  assert.equal(mock.head, winner.after_head);
  const visible = mock.trees.get(mock.commits.get(mock.head)!.tree)!;
  const visibleConcurrent = Array.from(visible.keys()).filter((path) =>
    path.includes("concurrent-"),
  );
  assert.equal(visibleConcurrent.length, 1);
});

test("a committed ref update with failed readback reports committed true and verified false", async () => {
  const mock = await createWriteMock({ failReadbackTree: true });
  const result = await callTool(mock.fetcher, "put_file_text", {
    path: "diagnostics/readpath-selftest/run/readback-fail.txt",
    content: "committed content",
    message: "self-test: readback failure",
    expected_parent_sha: mock.baseHead,
  });
  const receipt = JSON.parse(result.text);
  assert.equal(receipt.committed, true);
  assert.equal(receipt.after_head, mock.head);
  assert.equal(receipt.files[0].verified, false);
  assert.equal(receipt.files[0].error, "GITHUB_UPSTREAM_ERROR");
});

test("a lost PATCH response is reconciled when the ref already equals the candidate commit", async () => {
  const mock = await createWriteMock({ patchCommitThenThrow: true });
  const result = await callTool(mock.fetcher, "put_file_text", {
    path: "diagnostics/readpath-selftest/run/reconciled.txt",
    content: "reconciled content",
    message: "self-test: reconcile patch",
    expected_parent_sha: mock.baseHead,
  });
  const receipt = JSON.parse(result.text);
  assert.equal(receipt.committed, true);
  assert.equal(receipt.after_head, mock.head);
  assert.equal(receipt.files[0].verified, true);
});

test("an unexpected reconciliation head is never echoed in an error", async () => {
  const hostileHead =
    "Authorization: Bearer sensitive-token download_url=https://secret.invalid/file";
  const mock = await createWriteMock({
    patchCommitThenThrow: true,
    reconciliationObservedHead: hostileHead,
  });
  const result = await callTool(mock.fetcher, "put_file_text", {
    path: "diagnostics/readpath-selftest/run/reconcile-hostile.txt",
    content: "candidate content",
    message: "self-test: hostile reconciliation head",
    expected_parent_sha: mock.baseHead,
  });
  assert.equal(errorCode(result.text), "REF_UPDATE_OUTCOME_UNKNOWN");
  assert.doesNotMatch(
    result.text,
    /Authorization|Bearer|sensitive-token|download_url|secret\.invalid/i,
  );
});

for (const [label, options] of [
  ["body read failure", { patchCommitThenBodyReadFailure: true }],
  ["non-JSON success", { patchCommitThenNonJson: true }],
] as const) {
  test(`a committed PATCH with ${label} is reconciled without a blind retry`, async () => {
    const mock = await createWriteMock(options);
    const result = await callTool(mock.fetcher, "put_file_text", {
      path: `diagnostics/readpath-selftest/run/reconciled-${label.replaceAll(" ", "-")}.txt`,
      content: "committed exactly once",
      message: `self-test: reconcile ${label}`,
      expected_parent_sha: mock.baseHead,
    });
    const receipt = JSON.parse(result.text);
    assert.equal(receipt.committed, true);
    assert.equal(receipt.after_head, mock.head);
    assert.equal(receipt.files[0].verified, true);
    assert.equal(mock.forceValues.length, 1);
  });
}

test("nested write targets are rejected before any GitHub request", async () => {
  const mock = await createWriteMock();
  const result = await callTool(mock.fetcher, "put_files_text", {
    files: [
      { path: "diagnostics/readpath-selftest/collision", content: "file" },
      { path: "diagnostics/readpath-selftest/collision-foo", content: "decoy" },
      { path: "diagnostics/readpath-selftest/collision/child.txt", content: "child" },
    ],
    message: "self-test: nested collision",
  });
  assert.equal(errorCode(result.text), "NESTED_PATH_COLLISION");
  assert.equal(mock.calls.length, 0);
});

test("a misspelled concurrency guard is rejected before any GitHub request", async () => {
  const mock = await createWriteMock();
  const result = await callTool(mock.fetcher, "put_file_text", {
    path: "diagnostics/readpath-selftest/run/typo.txt",
    content: "must not write",
    message: "self-test: unknown argument",
    expected_parent_shaa: mock.baseHead,
  });
  assert.equal(errorCode(result.text), "UNEXPECTED_ARGUMENT");
  assert.equal(mock.calls.length, 0);
});

test("unpaired surrogate content is rejected before any GitHub request", async () => {
  const mock = await createWriteMock();
  const result = await callTool(mock.fetcher, "put_file_text", {
    path: "diagnostics/readpath-selftest/run/invalid.txt",
    content: "bad \ud800 value",
    message: "self-test: invalid unicode",
  });
  assert.equal(errorCode(result.text), "INVALID_UNICODE_STRING");
  assert.equal(mock.calls.length, 0);
});

test("injected repository binding is used for writes, ref reconciliation, and readback", async () => {
  const binding = { owner: "binding-owner", repo: "binding-repository" };
  const prefix = `/repos/${binding.owner}/${binding.repo}`;
  const mock = await createWriteMock({ patchCommitThenThrow: true });
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(url.pathname.startsWith(`${prefix}/`), `unexpected bound path: ${url.pathname}`);
    return mock.fetcher(input, init);
  };
  const observation = new ObservationContext({});
  const client = new GitHubClient(GITHUB_TOKEN, fetcher, "test-version", observation, binding);
  const path = "injected.txt";
  const content = "injected write\n";
  const result = await callServiceTool(client, "test-version", "put_file_text", {
    path,
    content,
    message: "test injected repository binding",
    branch: "main",
    expected_parent_sha: mock.baseHead,
  }, observation);
  const receipt = JSON.parse(result.content[0].text);
  const blobSha = await gitBlobSha(encodeUtf8(content));
  const baseTreeSha = mock.commits.get(mock.baseHead)!.tree;
  const createdTreeSha = mock.commits.get(receipt.after_head)!.tree;
  assert.equal(receipt.committed, true);
  assert.equal(receipt.after_head, mock.head);
  assert.deepEqual(receipt.files, [{
    path, blob_sha: blobSha, byte_length: encodeUtf8(content).byteLength, verified: true,
  }]);
  assert.deepEqual(mock.calls.map(({ method, path }) => `${method} ${path}`), [
    `GET ${prefix}/git/ref/heads/main`,
    `GET ${prefix}/git/commits/${mock.baseHead}`,
    `GET ${prefix}/git/trees/${baseTreeSha}`,
    `POST ${prefix}/git/blobs`,
    `POST ${prefix}/git/trees`,
    `POST ${prefix}/git/commits`,
    `PATCH ${prefix}/git/refs/heads/main`,
    `GET ${prefix}/git/ref/heads/main`,
    `GET ${prefix}/git/commits/${receipt.after_head}`,
    `GET ${prefix}/git/trees/${createdTreeSha}`,
    `GET ${prefix}/git/blobs/${blobSha}`,
  ]);
});

test("put_files_text atomically writes and deletes exact paths, preserving omitted paths and empty files", async () => {
  const nfd = "cafe\u0301.txt";
  const mock = await createWriteMock({ initialFiles: [
    { path: nfd, content: "remove" }, { path: "keep.txt", content: "keep" },
  ] });
  const result = await callTool(mock.fetcher, "put_files_text", {
    files: [{ path: "empty.txt", content: "" }], deletions: [nfd],
    message: "atomic write and delete", expected_parent_sha: mock.baseHead,
  });
  assert.equal(result.result.isError, undefined);
  const receipt = JSON.parse(result.text);
  assert.equal(receipt.committed, true);
  assert.equal(receipt.commit_sha, mock.head);
  assert.deepEqual(receipt.deletions, [{ path: nfd, verified: true }]);
  assert.equal(receipt.files[0].byte_length, 0);
  assert.equal(receipt.files[0].verified, true);
  const tree = mock.trees.get(mock.commits.get(mock.head)!.tree)!;
  assert.equal(tree.has(nfd), false);
  assert.equal(tree.has("keep.txt"), true);
  assert.equal(tree.has("empty.txt"), true);
  const treeCalls = mock.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/trees"));
  assert.equal(treeCalls.length, 1);
  assert.deepEqual(treeCalls[0].body.tree.find((entry: any) => entry.sha === null), {
    path: nfd, mode: "100644", type: "blob", sha: null,
  });
  assert.deepEqual(Buffer.from(treeCalls[0].body.tree[1].path), Buffer.from(nfd));
  assert.equal(mock.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/commits")).length, 1);
  assert.equal(mock.calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(mock.calls.some((call) => call.method === "DELETE"), false);
  assert.deepEqual(mock.forceValues, [false]);
});

test("put_files_text supports deletion-only commits and counts deletions toward the combined 20-path limit", async () => {
  const initialFiles = Array.from({ length: 20 }, (_, i) => ({ path: `old-${i}.txt`, content: "old" }));
  for (const writeCount of [0, 1]) {
    const mock = await createWriteMock({ initialFiles });
    const result = await callTool(mock.fetcher, "put_files_text", {
      files: writeCount ? [{ path: "new.txt", content: "new" }] : [],
      deletions: initialFiles.slice(writeCount).map((file) => file.path), message: "limit boundary",
    });
    assert.equal(result.result.isError, undefined);
    const receipt = JSON.parse(result.text);
    assert.equal(receipt.files.length, writeCount);
    assert.equal(receipt.deletions.length, 20 - writeCount);
    assert.ok(receipt.deletions.every((entry: any) => entry.verified));
    assert.equal(mock.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/blobs")).length, writeCount);
  }
  const mock = await createWriteMock({ initialFiles });
  const tooMany = await callTool(mock.fetcher, "put_files_text", {
    files: [{ path: "new.txt", content: "new" }], deletions: initialFiles.map((file) => file.path), message: "too many",
  });
  assert.equal(errorCode(tooMany.text), "INVALID_FILE_COUNT");
  assert.equal(mock.calls.length, 0);
});

test("deletions and path names do not consume the combined UTF-8 content budget", async () => {
  const deletedPath = "d".repeat(1024);
  for (const contentBytes of [262_144, 262_145]) {
    const mock = await createWriteMock({ initialFiles: [{ path: deletedPath, content: "old" }] });
    const result = await callTool(mock.fetcher, "put_files_text", {
      files: [{ path: "new.txt", content: "a".repeat(contentBytes) }],
      deletions: [deletedPath], message: "content budget boundary",
    });
    if (contentBytes === 262_144) {
      assert.equal(result.result.isError, undefined);
      assert.equal(JSON.parse(result.text).files[0].byte_length, contentBytes);
      assert.deepEqual(JSON.parse(result.text).deletions, [{ path: deletedPath, verified: true }]);
    } else {
      assert.equal(errorCode(result.text), "WRITE_SIZE_LIMIT");
      assert.equal(mock.calls.length, 0);
    }
  }
});

test("invalid deletion shapes, conflicts, missing paths, and empty requests never create Git objects", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ files: [], deletions: [] }, "INVALID_FILE_COUNT"],
    [{ files: [], deletions: "old.txt" }, "INVALID_DELETIONS"],
    [{ files: [], deletions: [42] }, "INVALID_PATH"],
    [{ files: [], deletions: ["../old.txt"] }, "INVALID_PATH"],
    [{ files: [], deletions: ["/old.txt"] }, "INVALID_PATH"],
    [{ files: [], deletions: ["old//file"] }, "INVALID_PATH"],
    [{ files: [], deletions: ["old\nfile"] }, "INVALID_PATH"],
    [{ files: [], deletions: ["old.txt", "old.txt"] }, "DUPLICATE_PATH"],
    [{ files: [{ path: "old.txt", content: "new" }], deletions: ["old.txt"] }, "WRITE_DELETE_CONFLICT"],
    [{ files: [{ path: "dir/new.txt", content: "new" }], deletions: ["dir"] }, "NESTED_PATH_COLLISION"],
    [{ files: [], deletions: ["dir", "dir/old.txt"] }, "NESTED_PATH_COLLISION"],
    [{ files: [{ path: "new.txt", content: "new" }], deletions: ["missing.txt"] }, "DELETE_PATH_NOT_FOUND"],
    [{ deletions: ["old.txt"] }, "INVALID_FILES"],
    [{ files: [], deletions: ["old.txt"], owner: "override" }, "UNEXPECTED_ARGUMENT"],
    [{ files: [], deletions: ["old.txt"], repo: "override" }, "UNEXPECTED_ARGUMENT"],
  ];
  for (const [args, code] of cases) {
    const mock = await createWriteMock({ initialFiles: [{ path: "old.txt", content: "old" }] });
    const result = await callTool(mock.fetcher, "put_files_text", { message: "invalid deletion", ...args });
    assert.equal(result.result.isError, true, JSON.stringify(args));
    assert.equal(errorCode(result.text), code, JSON.stringify(args));
    assert.equal(mock.head, mock.baseHead);
    assert.ok(mock.calls.every((call) => call.method === "GET"));
  }
});

test("deletion receipts distinguish committed changes from unavailable, incomplete, or mismatching readback", async () => {
  for (const [options, error] of [
    [{ failReadbackTree: true }, "GITHUB_UPSTREAM_ERROR"],
    [{ truncateReadbackTree: true }, "READBACK_TREE_INCOMPLETE"],
    [{ invalidReadbackTree: true }, "READBACK_TREE_INCOMPLETE"],
    [{ ignoreDeletions: true }, "READBACK_DELETE_MISMATCH"],
  ] as const) {
    const mock = await createWriteMock({ ...options, initialFiles: [{ path: "old.txt", content: "old" }] });
    const result = await callTool(mock.fetcher, "put_files_text", {
      files: [{ path: "new.txt", content: "new" }], deletions: ["old.txt"], message: "readback verification",
    });
    assert.equal(result.result.isError, undefined);
    const receipt = JSON.parse(result.text);
    assert.equal(receipt.committed, true);
    assert.equal(receipt.files.length, 1);
    assert.equal(receipt.files[0].verified, "ignoreDeletions" in options);
    assert.deepEqual(receipt.deletions, [{ path: "old.txt", verified: false, error }]);
  }
});

test("deletions use the injected binding and can remove a directory subtree or a special Git entry", async () => {
  const mock = await createWriteMock({ initialFiles: [{ path: "dir/child.txt", content: "child" }] });
  const baseTree = mock.trees.get(mock.commits.get(mock.baseHead)!.tree)!;
  baseTree.set("dir", { path: "dir", mode: "040000", type: "tree", sha: "c".repeat(40) });
  baseTree.set("link", { path: "link", mode: "120000", type: "blob", sha: "d".repeat(40) });
  baseTree.set("module", { path: "module", mode: "160000", type: "commit", sha: "e".repeat(40) });
  const binding = { owner: "injected-owner", repo: "injected-repo" };
  const prefix = `/repos/${binding.owner}/${binding.repo}/`;
  const fetcher: FetchLike = async (input, init) => {
    assert.ok(new URL(String(input)).pathname.startsWith(prefix));
    return mock.fetcher(input, init);
  };
  const observation = new ObservationContext({});
  const client = new GitHubClient(GITHUB_TOKEN, fetcher, "test-version", observation, binding);
  const result = await callServiceTool(client, "test-version", "put_files_text", {
    files: [], deletions: ["dir", "link", "module"], message: "delete exact Git entries",
  }, observation);
  const receipt = JSON.parse(result.content[0].text);
  assert.deepEqual(receipt.deletions, ["dir", "link", "module"].map((path) => ({ path, verified: true })));
  assert.equal(mock.trees.get(mock.commits.get(mock.head)!.tree)!.size, 0);
  assert.equal(mock.calls.some((call) => call.method === "DELETE"), false);
});

test("put_file_text still rejects deletions and returns its original receipt shape", async () => {
  const mock = await createWriteMock();
  const args = { path: "single.txt", content: "", message: "single" };
  const invalid = await callTool(mock.fetcher, "put_file_text", { ...args, deletions: ["old.txt"] });
  assert.equal(errorCode(invalid.text), "UNEXPECTED_ARGUMENT");
  assert.equal(mock.calls.length, 0);
  const valid = await callTool(mock.fetcher, "put_file_text", args);
  assert.equal(valid.result.isError, undefined);
  assert.equal(Object.hasOwn(JSON.parse(valid.text), "deletions"), false);
});
