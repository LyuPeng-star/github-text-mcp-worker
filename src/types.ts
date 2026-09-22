export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  PRIMARY_REPOSITORY?: string;
  SECONDARY_REPOSITORY?: string;
  ALLOWED_ORIGINS?: string;
  CONNECTOR_TOKEN_PRIMARY?: string;
  CONNECTOR_TOKEN_SECONDARY?: string;
  GITHUB_TOKEN_PRIMARY?: string;
  GITHUB_TOKEN_SECONDARY?: string;
  SERVICE_VERSION?: string;
  SOURCE_COMMIT?: string;
  WORKER_VERSION_METADATA?: {
    id: string;
    tag: string;
    timestamp: string;
  };
  MCP_RATE_LIMITER_PRIMARY?: RateLimiter;
  MCP_RATE_LIMITER_SECONDARY?: RateLimiter;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}
