import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeUtf8 } from "../src/encoding.ts";
import {
  callTool,
  createReadMock,
  errorCode,
  FULL_COMMIT,
  parseEnvelope,
} from "./helpers.ts";
import { createCorpusRepository, type ManifestEntry } from "./corpus-repository.ts";
import { generateLargeFile } from "./synthetic-large-file.ts";

const { directory: CORPUS_REPO, commit: CORPUS_COMMIT } = createCorpusRepository();
after(() => rmSync(CORPUS_REPO, { recursive: true, force: true }));

function gitText(...args: string[]): string {
  return execFileSync("git", args, { cwd: CORPUS_REPO, encoding: "utf8" });
}

function corpusGitBuffer(...args: string[]): Uint8Array {
  return new Uint8Array(
    execFileSync("git", args, { cwd: CORPUS_REPO, maxBuffer: 16 * 1024 * 1024 }),
  );
}

function treeBlobSha(commit: string, path: string): string {
  // Do not pass a decomposed Unicode path as a macOS argv pathspec: Git may
  // precompose it. Read the whole tree with -z and compare the raw path bytes.
  const listing = corpusGitBuffer("ls-tree", "-rz", commit);
  const expectedPath = encodeUtf8(path);
  let cursor = 0;
  while (cursor < listing.byteLength) {
    const nul = listing.indexOf(0, cursor);
    assert.ok(nul >= 0, "git ls-tree -z returned an unterminated record");
    const record = listing.subarray(cursor, nul);
    const tab = record.indexOf(0x09);
    assert.ok(tab > 0, "git ls-tree returned a malformed record");
    const rawPath = record.subarray(tab + 1);
    if (
      rawPath.byteLength === expectedPath.byteLength &&
      rawPath.every((byte, index) => byte === expectedPath[index])
    ) {
      const metadata = new TextDecoder("ascii", { fatal: true }).decode(
        record.subarray(0, tab),
      );
      const match = metadata.match(/^100(?:644|755) blob ([0-9a-f]{40})$/);
      assert.ok(match, `path is not an ordinary blob at ${commit}: ${path}`);
      return match[1];
    }
    cursor = nul + 1;
  }
  assert.fail(`path is not anchored by raw bytes at ${commit}: ${path}`);
}

function lineCount(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let lf = 0;
  for (const byte of bytes) if (byte === 0x0a) lf += 1;
  return lf + (bytes.at(-1) === 0x0a ? 0 : 1);
}

function fingerprints(bytes: Uint8Array): { first: string; last: string } {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const clean = lines.map((line) => line.replace(/\r$/, ""));
  const first = (clean[0] ?? "").replace(/^\uFEFF/, "");
  return {
    first: Array.from(first).slice(0, 48).join(""),
    last: Array.from(clean.at(-1) ?? "").slice(0, 48).join(""),
  };
}

const manifest = JSON.parse(
  gitText("show", `${CORPUS_COMMIT}:probes/synthetic-readpath-v1/manifest.json`),
) as { entries: ManifestEntry[] };

const selectedIds = new Set(["P01", "P06", "P07", "P08", "P09", "P10", "P11", "P12"]);
const selected = manifest.entries.filter((entry) => selectedIds.has(entry.probe_id));
const fixtures = selected.map((entry) => ({
  path: entry.path,
  bytes: corpusGitBuffer("cat-file", "blob", entry.git_blob_sha),
}));

test("seven-class corpus (eight objects) is byte-exact through text-only MCP", async () => {
  const gitBuffer = corpusGitBuffer;
  assert.equal(selected.length, 8);
  const mock = await createReadMock(fixtures);
  for (const entry of selected) {
    assert.equal(treeBlobSha(CORPUS_COMMIT, entry.path), entry.git_blob_sha);
    const oracle = gitBuffer("cat-file", "blob", entry.git_blob_sha);
    assert.equal(oracle.byteLength, entry.bytes);
    assert.equal(
      createHash("sha256").update(oracle).digest("hex"),
      entry.sha256,
    );

    const result = await callTool(mock.fetcher, "get_file_text", {
      path: entry.path,
      commit_sha: CORPUS_COMMIT,
      include_sha256: true,
    });
    assert.equal(result.result.content.length, 1);
    assert.equal(result.result.content[0].type, "text");
    const parsed = parseEnvelope(result.text);
    const actual = encodeUtf8(parsed.body);
    assert.deepEqual(actual, oracle, entry.probe_id);
    assert.equal(parsed.fields.path, entry.path);
    assert.equal(parsed.fields.commit, CORPUS_COMMIT);
    assert.equal(parsed.fields.blob_sha, entry.git_blob_sha);
    assert.equal(Number(parsed.fields.byte_length), oracle.byteLength);
    assert.equal(Number(parsed.fields.line_count), lineCount(oracle));
    assert.equal(parsed.fields.sha256, entry.sha256);
    const expectedFingerprint = fingerprints(oracle);
    assert.equal(parsed.fields.first_line_fingerprint, expectedFingerprint.first);
    assert.equal(parsed.fields.last_line_fingerprint, expectedFingerprint.last);
  }
});

test("CRLF, BOM, and NFC/NFD filename bytes survive unchanged", async () => {
  const gitBuffer = corpusGitBuffer;
  const mock = await createReadMock(fixtures);
  for (const id of ["P08", "P09", "P11", "P12"]) {
    const entry = selected.find((candidate) => candidate.probe_id === id)!;
    const oracle = gitBuffer("cat-file", "blob", entry.git_blob_sha);
    const result = await callTool(mock.fetcher, "get_file_text", {
      path: entry.path,
      commit_sha: CORPUS_COMMIT,
    });
    assert.deepEqual(encodeUtf8(parseEnvelope(result.text).body), oracle);
  }
  const bom = selected.find((entry) => entry.probe_id === "P09")!;
  assert.deepEqual(
    Array.from(gitBuffer("cat-file", "blob", bom.git_blob_sha).slice(0, 3)),
    [0xef, 0xbb, 0xbf],
  );
  const nfc = selected.find((entry) => entry.probe_id === "P11")!.path;
  const nfd = selected.find((entry) => entry.probe_id === "P12")!.path;
  assert.notEqual(nfc, nfd);
  assert.ok(nfc.includes("é"));
  assert.ok(nfd.includes("e\u0301"));
  assert.equal(nfc.normalize("NFC"), nfc);
  assert.equal(nfd.normalize("NFD"), nfd);
  assert.notEqual(nfd.normalize("NFC"), nfd);
  assert.throws(
    () => treeBlobSha(CORPUS_COMMIT, nfd.normalize("NFC")),
    /path is not anchored by raw bytes/,
  );
  const nfdEntry = selected.find((entry) => entry.probe_id === "P12")!;
  assert.deepEqual(
    new Uint8Array(readFileSync(join(CORPUS_REPO, nfd))),
    gitBuffer("cat-file", "blob", nfdEntry.git_blob_sha),
  );
  // The distributed checkout keeps NFC names; only the temporary corpus has NFD.
  const fixturePaths = readdirSync(new URL("./fixtures/readpath-corpus/", import.meta.url), { recursive: true, encoding: "utf8" });
  for (const path of fixturePaths) {
    assert.equal(path.normalize("NFC"), path, `non-NFC distributed fixture path: ${path}`);
  }
});

test("line and byte range boundaries match independent git-object bytes", async () => {
  const mock = await createReadMock(fixtures);
  const longLine = selected.find((entry) => entry.probe_id === "P10")!;
  const first = await callTool(mock.fetcher, "get_file_text", {
    path: longLine.path,
    commit_sha: CORPUS_COMMIT,
    start_line: 1,
    end_line: 1,
  });
  const middle = await callTool(mock.fetcher, "get_file_text", {
    path: longLine.path,
    commit_sha: CORPUS_COMMIT,
    start_line: 2,
    end_line: 2,
  });
  const last = await callTool(mock.fetcher, "get_file_text", {
    path: longLine.path,
    commit_sha: CORPUS_COMMIT,
    start_line: 3,
    end_line: 3,
  });
  assert.equal(encodeUtf8(parseEnvelope(first.text).body).byteLength, 59);
  assert.equal(encodeUtf8(parseEnvelope(middle.text).body).byteLength, 12_172);
  assert.equal(encodeUtf8(parseEnvelope(last.text).body).byteLength, 57);

  const outside = await callTool(mock.fetcher, "get_file_text", {
    path: longLine.path,
    commit_sha: CORPUS_COMMIT,
    start_line: 4,
    end_line: 4,
  });
  assert.equal(errorCode(outside.text), "LINE_RANGE_OUT_OF_BOUNDS");

  const chinese = selected.find((entry) => entry.probe_id === "P07")!;
  const exact = await callTool(mock.fetcher, "get_file_text", {
    path: chinese.path,
    commit_sha: CORPUS_COMMIT,
    byte_offset: 53,
    byte_limit: 6,
  });
  assert.equal(parseEnvelope(exact.text).body, "中文");
  const split = await callTool(mock.fetcher, "get_file_text", {
    path: chinese.path,
    commit_sha: CORPUS_COMMIT,
    byte_offset: 54,
    byte_limit: 6,
  });
  assert.equal(errorCode(split.text), "BYTE_OFFSET_SPLITS_UTF8");
  assert.match(split.text, /\nsafe_offset: 53(?:\n|$)/);
  const recovered = await callTool(mock.fetcher, "get_file_text", {
    path: chinese.path,
    commit_sha: CORPUS_COMMIT,
    byte_offset: 53,
    byte_limit: 6,
  });
  assert.equal(recovered.result.isError, undefined);
  assert.equal(parseEnvelope(recovered.text).body, "中文");
});

test("UTF-8-safe chunks reassemble to the exact probe blob", async () => {
  const gitBuffer = corpusGitBuffer;
  const mock = await createReadMock(fixtures);
  const entry = selected.find((candidate) => candidate.probe_id === "P07")!;
  const oracle = gitBuffer("cat-file", "blob", entry.git_blob_sha);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let count = 0; count < 1_000; count += 1) {
    const result = await callTool(mock.fetcher, "get_file_text", {
      path: entry.path,
      commit_sha: CORPUS_COMMIT,
      byte_offset: offset,
      max_bytes: 54,
    });
    const parsed = parseEnvelope(result.text);
    const bytes = encodeUtf8(parsed.body);
    chunks.push(bytes);
    if (count === 0) {
      assert.equal(bytes.byteLength, 53);
      assert.equal(parsed.fields.next_byte_offset, "53");
    }
    if (parsed.fields.has_more === "false") break;
    const next = Number(parsed.fields.next_byte_offset);
    assert.ok(next > offset);
    offset = next;
  }
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    joined.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  assert.deepEqual(joined, oracle);
});

test("literal search matches the independent probe line oracle", async () => {
  const mock = await createReadMock(fixtures);
  const entry = selected.find((candidate) => candidate.probe_id === "P07")!;
  const result = await callTool(mock.fetcher, "search_in_file", {
    path: entry.path,
    commit_sha: CORPUS_COMMIT,
    pattern: "中文内容",
    max_matches: 2,
  });
  const search = JSON.parse(result.text);
  assert.equal(search.total_matches, 172);
  assert.equal(search.truncated, true);
  assert.deepEqual(search.matches.map((match: any) => match.line_number), [2, 3]);
});

test("synthetic large-file Contents fallback reassembles in twenty default chunks", async (t) => {
  // 1,245,185 ASCII bytes is the minimum for twenty default chunks. Preserve
  // the 1,291,669-byte test length and all existing chunk-size assertions.
  const targetBytes = 1_291_669;
  const seed = "readpath-large-file-v1";
  const directory = mkdtempSync(join(tmpdir(), "readpath-large-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "large-file.txt");
  writeFileSync(file, generateLargeFile(seed, targetBytes));
  const oracle = new Uint8Array(readFileSync(file));
  const path = "synthetic/readpath-large-file.txt";
  const mock = await createReadMock([{ path, bytes: oracle, forceBlobFallback: true }]);
  const blobSha = createHash("sha1")
    .update(`blob ${oracle.byteLength}\0`, "ascii")
    .update(oracle)
    .digest("hex");
  assert.equal(mock.byPath.get(path)!.sha, blobSha);
  assert.equal(oracle.byteLength, targetBytes);
  assert.deepEqual(oracle, generateLargeFile(seed, targetBytes));
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const result = await callTool(mock.fetcher, "get_file_text", {
      path,
      commit_sha: FULL_COMMIT,
      byte_offset: offset,
    });
    const parsed = parseEnvelope(result.text);
    chunks.push(encodeUtf8(parsed.body));
    if (parsed.fields.has_more === "false") break;
    offset = Number(parsed.fields.next_byte_offset);
  }
  assert.equal(chunks.length, 20);
  assert.deepEqual(chunks.slice(0, 19).map((chunk) => chunk.byteLength), Array(19).fill(65_536));
  assert.equal(chunks[19].byteLength, 46_485);
  const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  assert.deepEqual(new Uint8Array(joined), oracle);
  assert.ok(mock.calls.some((call) => call.url.includes("/git/blobs/")));
});
