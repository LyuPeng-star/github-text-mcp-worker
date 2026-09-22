import assert from "node:assert/strict";
import { encodeBase64, encodeUtf8, gitBlobSha } from "../src/encoding.ts";
import { handleRequest } from "../src/index.ts";
import type { Env, FetchLike } from "../src/types.ts";

export const CONNECTOR_TOKEN = "local-test-connector-token";
export const GITHUB_TOKEN = "local-test-github-token";
export const FULL_COMMIT = "a".repeat(40);
export const SOURCE_COMMIT = "b".repeat(40);
export const OBSERVATION_ENV: Partial<Env> = {
  SERVICE_VERSION: "0.1.3-test",
  SOURCE_COMMIT,
  WORKER_VERSION_METADATA: {
    id: "11111111-2222-3333-4444-555555555555",
    tag: "source-bbbbbbbbbbbb",
    timestamp: "2026-08-31T12:00:00.000Z",
  },
};
export const ALLOW_RATE_LIMITER = {
  async limit(): Promise<{ success: boolean }> {
    return { success: true };
  },
};

export interface FixtureFile {
  path: string;
  bytes: Uint8Array;
  forceBlobFallback?: boolean;
}

export interface ReadMockOptions {
  tamperShaFor?: string;
  tamperBytesFor?: string;
  directories?: string[];
  symlinks?: string[];
  submodules?: string[];
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function decodeContentPath(url: URL): string | null {
  const prefix = "/repos/fixture-owner/secondary-repository/contents/";
  if (!url.pathname.startsWith(prefix)) return null;
  return url.pathname
    .slice(prefix.length)
    .split("/")
    .map(decodeURIComponent)
    .join("/");
}

export async function createReadMock(
  fixtures: FixtureFile[],
  options: ReadMockOptions = {},
): Promise<{
  fetcher: FetchLike;
  byPath: Map<string, FixtureFile & { sha: string }>;
  calls: Array<{ method: string; url: string }>;
}> {
  const enriched = await Promise.all(
    fixtures.map(async (fixture) => ({ ...fixture, sha: await gitBlobSha(fixture.bytes) })),
  );
  const byPath = new Map(enriched.map((fixture) => [fixture.path, fixture]));
  const bySha = new Map(enriched.map((fixture) => [fixture.sha, fixture]));
  const calls: Array<{ method: string; url: string }> = [];
  const treeSha = "e".repeat(40);

  const fetcher: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ method, url: url.toString() });

    if (/\/repos\/fixture-owner\/secondary-repository\/git\/commits\/[0-9a-f]{40}$/.test(url.pathname)) {
      return json({ sha: url.pathname.split("/").at(-1), tree: { sha: treeSha } });
    }
    if (url.pathname === `/repos/fixture-owner/secondary-repository/git/trees/${treeSha}`) {
      return json({
        sha: treeSha,
        truncated: false,
        tree: [
          ...enriched.map((fixture) => ({
            path: fixture.path,
            mode: "100644",
            type: "blob",
            sha: fixture.sha,
          })),
          ...(options.directories ?? []).map((path) => ({
            path,
            mode: "040000",
            type: "tree",
            sha: "d".repeat(40),
          })),
          ...(options.symlinks ?? []).map((path) => ({
            path,
            mode: "120000",
            type: "blob",
            sha: "b".repeat(40),
          })),
          ...(options.submodules ?? []).map((path) => ({
            path,
            mode: "160000",
            type: "commit",
            sha: "c".repeat(40),
          })),
        ],
      });
    }
    const path = decodeContentPath(url);
    if (path !== null) {
      if (options.directories?.includes(path)) return json([{ type: "file" }]);
      if (options.symlinks?.includes(path)) {
        return json({ type: "symlink", path, sha: "b".repeat(40), target: "README.md" });
      }
      if (options.submodules?.includes(path)) {
        return json({
          type: "submodule",
          path,
          sha: "c".repeat(40),
          submodule_git_url: "https://example.invalid/repo.git",
        });
      }
      const fixture = byPath.get(path);
      if (!fixture) return json({ message: "Not Found" }, 404);
      const reportedSha =
        options.tamperShaFor === path ? "f".repeat(40) : fixture.sha;
      const deliveredBytes = options.tamperBytesFor === path
        ? Uint8Array.from(fixture.bytes, (byte, index) =>
          index === fixture.bytes.byteLength - 1 ? byte ^ 1 : byte)
        : fixture.bytes;
      return json({
        type: "file",
        path,
        sha: reportedSha,
        size: fixture.bytes.byteLength,
        encoding: fixture.forceBlobFallback ? "none" : "base64",
        content: fixture.forceBlobFallback ? "" : encodeBase64(deliveredBytes),
      });
    }

    const blobPrefix = "/repos/fixture-owner/secondary-repository/git/blobs/";
    if (url.pathname.startsWith(blobPrefix)) {
      const sha = url.pathname.slice(blobPrefix.length).toLowerCase();
      const fixture = bySha.get(sha);
      if (!fixture) return json({ message: "Not Found" }, 404);
      return json({
        sha,
        size: fixture.bytes.byteLength,
        encoding: "base64",
        content: encodeBase64(fixture.bytes),
        truncated: false,
      });
    }
    return json({ message: "Unhandled mock endpoint" }, 500);
  };

  return { fetcher, byPath, calls };
}

export async function rpc(
  fetcher: FetchLike,
  method: string,
  params?: unknown,
  options: {
    authorization?: string | null;
    env?: Partial<Env>;
    accept?: string;
    id?: number;
    pathname?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorization !== null) {
    headers.set(
      "authorization",
      options.authorization ?? `Bearer ${CONNECTOR_TOKEN}`,
    );
  }
  if (options.accept) headers.set("accept", options.accept);
  return handleRequest(
    new Request(`https://worker.example${options.pathname ?? "/secondary/mcp"}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: options.id ?? 1, method, params }),
    }),
    {
      SECONDARY_REPOSITORY: "fixture-owner/secondary-repository", CONNECTOR_TOKEN_SECONDARY: CONNECTOR_TOKEN,
      GITHUB_TOKEN_SECONDARY: GITHUB_TOKEN,
      SERVICE_VERSION: "test-version",
      MCP_RATE_LIMITER_SECONDARY: ALLOW_RATE_LIMITER,
      ...options.env,
    },
    fetcher,
  );
}

export async function callTool(
  fetcher: FetchLike,
  name: string,
  args: Record<string, unknown>,
  options: { env?: Partial<Env> } = {},
): Promise<{ rpc: any; result: any; text: string }> {
  const response = await rpc(
    fetcher,
    "tools/call",
    { name, arguments: args },
    options.env ? { env: options.env } : {},
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  const result = payload.result;
  const text = result.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return { rpc: payload, result, text };
}

export interface ParsedEnvelope {
  fields: Record<string, string>;
  body: string;
  begin: string;
  end: string;
}

export function parseEnvelope(text: string): ParsedEnvelope {
  assert.ok(text.startsWith("GITHUB_FILE_TEXT_V1\n"), "missing envelope version");
  const beginMatch = /^---BEGIN FILE(?: ([0-9a-f]{12}))?---$/m.exec(text);
  assert.ok(beginMatch, "missing begin delimiter");
  const nonce = beginMatch[1];
  const begin = beginMatch[0];
  const end = nonce ? `---END FILE ${nonce}---` : "---END FILE---";
  const beginIndex = beginMatch.index;
  const bodyStart = beginIndex + begin.length + 1;
  const endIndex = text.indexOf(end, bodyStart);
  assert.ok(endIndex >= bodyStart, "missing end delimiter");
  assert.equal(text.slice(endIndex + end.length), "", "unexpected bytes after delimiter");
  const header = text.slice(0, beginIndex).replace(/\n$/, "");
  const fields: Record<string, string> = {};
  for (const line of header.split("\n").slice(1)) {
    const separator = line.indexOf(": ");
    assert.ok(separator > 0, `invalid header line: ${line}`);
    fields[line.slice(0, separator)] = line.slice(separator + 2);
  }
  return { fields, body: text.slice(bodyStart, endIndex), begin, end };
}

export function assertTextOnly(result: any): void {
  assert.ok(Array.isArray(result.content));
  assert.ok(result.content.length >= 1);
  for (const block of result.content) assert.equal(block.type, "text");
}

export function independentEnvelopeCheck(
  text: string,
  expectedBytes: Uint8Array,
): ParsedEnvelope {
  const parsed = parseEnvelope(text);
  const actualBytes = encodeUtf8(parsed.body);
  assert.equal(Number(parsed.fields.chunk_bytes), actualBytes.byteLength);
  assert.equal(Number(parsed.fields.byte_length), expectedBytes.byteLength);
  assert.equal(
    Number(parsed.fields.selection_end_byte_offset),
    expectedBytes.byteLength,
  );
  assert.deepEqual(actualBytes, expectedBytes);
  assert.equal(parsed.fields.truncated, "false");
  assert.equal(parsed.fields.has_more, "false");
  return parsed;
}

export function errorCode(text: string): string {
  const match = text.match(/^ERROR ([A-Z0-9_]+)/);
  assert.ok(match, `not an explicit tool error: ${text}`);
  return match[1];
}

export function parseToolErrorFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n").slice(1)) {
    const separator = line.indexOf(": ");
    if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 2);
  }
  return fields;
}

export function utf8(value: string): Uint8Array {
  return encodeUtf8(value);
}

export { json };
