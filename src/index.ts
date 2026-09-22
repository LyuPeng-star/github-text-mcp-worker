import { resolveRequestBinding, resolveRepositoryBinding } from "./bindings.ts";
import { asServiceError } from "./errors.ts";
import { GitHubClient } from "./github.ts";
import { ObservationContext, observationTextLines } from "./observation.ts";
import { callTool, isKnownToolName, toolsListPayload } from "./service.ts";
import type { Env, FetchLike, JsonRpcRequest, ToolResult } from "./types.ts";

const FALLBACK_SERVICE_VERSION = "0.1.1";
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-03-26", PROTOCOL_VERSION]);
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://perplexity.ai",
  "https://www.perplexity.ai",
]);
const MAX_REQUEST_BYTES = 2_097_152;

function isAllowedOrigin(origin: string, configured: string | undefined): boolean {
  if (configured === undefined) return DEFAULT_ALLOWED_ORIGINS.has(origin);
  // Match full origins only; no wildcard, suffix matching, or implicit CORS bypass.
  const origins = configured.split(",").map((value) => value.trim()).filter(Boolean);
  return origins.some((value) => {
    try {
      const url = new URL(value);
      return url.origin === value && (url.protocol === "https:" || url.protocol === "http:") && value === origin;
    } catch { return false; }
  });
}

class RequestBodyTooLarge extends Error {}

function secureStringEqual(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  let mismatch = actualBytes.byteLength ^ expectedBytes.byteLength;
  const length = Math.max(actualBytes.byteLength, expectedBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    mismatch |=
      (actualBytes[index] ?? 0) ^
      (expectedBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function rpcSuccess(id: JsonRpcRequest["id"], result: unknown): unknown {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolError(error: unknown, observation: ObservationContext): ToolResult {
  const known = asServiceError(error);
  const fields = observation.snapshot();
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          `ERROR ${known.code}`,
          `message: ${known.message}`,
          "result: null",
          ...observationTextLines(fields),
        ].join("\n"),
      },
    ],
  };
}

function rpcResponse(payload: unknown, request: Request, status = 200): Response {
  const serialized = JSON.stringify(payload);
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    return new Response(`event: message\ndata: ${serialized}\n\n`, {
      status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  return new Response(serialized, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<JsonRpcRequest>;
  const validId =
    request.id === undefined ||
    request.id === null ||
    typeof request.id === "string" ||
    (typeof request.id === "number" && Number.isFinite(request.id));
  const validParams = request.params === undefined || isPlainObject(request.params);
  return (
    request.jsonrpc === "2.0" &&
    typeof request.method === "string" &&
    validId &&
    validParams
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_REQUEST_BYTES
  ) {
    throw new RequestBodyTooLarge();
  }
  if (request.body === null) return JSON.parse("");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetcher: FetchLike = (input, init) => fetch(input, init),
): Promise<Response> {
  const url = new URL(request.url);
  const binding = resolveRequestBinding(url.pathname);
  if (!binding) {
    return new Response("Not Found", { status: 404 });
  }
  const origin = request.headers.get("origin");
  if (origin !== null && !isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const repository = resolveRepositoryBinding(env, binding);
  if (!repository) return new Response("Service unavailable", { status: 503 });

  const connectorToken = env[binding.connectorToken];
  const githubToken = env[binding.githubToken];
  if (!connectorToken || !githubToken) {
    return new Response("Service unavailable", { status: 503 });
  }
  const expectedAuthorization = `Bearer ${connectorToken}`;
  if (!secureStringEqual(request.headers.get("authorization"), expectedAuthorization)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const rateLimiter = env[binding.rateLimiter];
  if (!rateLimiter) {
    return new Response("Service unavailable", { status: 503 });
  }
  try {
    const limited = await rateLimiter.limit({ key: "mcp-connector" });
    if (!limited.success) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
  } catch {
    return new Response("Service unavailable", { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      return new Response("Payload Too Large", { status: 413 });
    }
    return rpcResponse(rpcError(null, -32700, "Parse error"), request);
  }
  if (!isRpcRequest(raw)) {
    return rpcResponse(rpcError(null, -32600, "Invalid Request"), request);
  }

  const rpc = raw;
  const serviceVersion = env.SERVICE_VERSION || FALLBACK_SERVICE_VERSION;

  const protocolHeader = request.headers.get("mcp-protocol-version");
  if (
    rpc.method !== "initialize" &&
    protocolHeader !== null &&
    !SUPPORTED_PROTOCOL_VERSIONS.has(protocolHeader)
  ) {
    return rpcResponse(
      rpcError(rpc.id, -32600, "Unsupported MCP-Protocol-Version"),
      request,
      400,
    );
  }

  if (rpc.id === undefined) {
    return new Response(null, { status: 202 });
  }
  if (rpc.method === "ping") {
    return rpcResponse(rpcSuccess(rpc.id, {}), request);
  }
  if (rpc.method === "initialize") {
    const requestedVersion =
      rpc.params &&
      typeof rpc.params === "object" &&
      !Array.isArray(rpc.params) &&
      "protocolVersion" in rpc.params &&
      typeof (rpc.params as { protocolVersion?: unknown }).protocolVersion === "string"
        ? (rpc.params as { protocolVersion: string }).protocolVersion
        : undefined;
    const negotiatedVersion =
      requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : PROTOCOL_VERSION;
    return rpcResponse(
      rpcSuccess(rpc.id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "github-text-mcp-worker",
          version: serviceVersion,
        },
      }),
      request,
    );
  }
  if (rpc.method === "tools/list") {
    return rpcResponse(rpcSuccess(rpc.id, toolsListPayload()), request);
  }
  if (rpc.method === "tools/call") {
    if (!isPlainObject(rpc.params)) {
      return rpcResponse(rpcError(rpc.id, -32602, "Invalid tools/call params"), request);
    }
    const paramKeys = Object.keys(rpc.params);
    if (
      paramKeys.some((key) => key !== "name" && key !== "arguments") ||
      !isKnownToolName(rpc.params.name) ||
      (rpc.params.arguments !== undefined && !isPlainObject(rpc.params.arguments))
    ) {
      return rpcResponse(rpcError(rpc.id, -32602, "Invalid tools/call params"), request);
    }
    const params = rpc.params as { name: string; arguments?: Record<string, unknown> };
    const observation = new ObservationContext(env);
    let result: ToolResult;
    try {
      const client = new GitHubClient(
        githubToken,
        fetcher,
        serviceVersion,
        observation,
        repository,
      );
      result = await callTool(
        client,
        serviceVersion,
        params.name,
        params.arguments,
        observation,
      );
    } catch (error) {
      result = toolError(error, observation);
    }
    return rpcResponse(rpcSuccess(rpc.id, result), request);
  }

  return rpcResponse(rpcError(rpc.id, -32601, "Method not found"), request);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
