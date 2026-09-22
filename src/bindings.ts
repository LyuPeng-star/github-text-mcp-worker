import type { RepositoryBinding } from "./github.ts";
import type { Env } from "./types.ts";

interface RequestBinding {
  readonly repositoryVariable: "PRIMARY_REPOSITORY" | "SECONDARY_REPOSITORY";
  readonly connectorToken: "CONNECTOR_TOKEN_PRIMARY" | "CONNECTOR_TOKEN_SECONDARY";
  readonly githubToken: "GITHUB_TOKEN_PRIMARY" | "GITHUB_TOKEN_SECONDARY";
  readonly rateLimiter: "MCP_RATE_LIMITER_PRIMARY" | "MCP_RATE_LIMITER_SECONDARY";
}

const REQUEST_BINDINGS: Readonly<Record<string, RequestBinding>> = {
  primary: {
    repositoryVariable: "PRIMARY_REPOSITORY",
    connectorToken: "CONNECTOR_TOKEN_PRIMARY",
    githubToken: "GITHUB_TOKEN_PRIMARY",
    rateLimiter: "MCP_RATE_LIMITER_PRIMARY",
  },
  secondary: {
    repositoryVariable: "SECONDARY_REPOSITORY",
    connectorToken: "CONNECTOR_TOKEN_SECONDARY",
    githubToken: "GITHUB_TOKEN_SECONDARY",
    rateLimiter: "MCP_RATE_LIMITER_SECONDARY",
  },
};

export function resolveRequestBinding(pathname: string): RequestBinding | undefined {
  const prefix = pathname.split("/")[1];
  if (pathname !== `/${prefix}/mcp` || !Object.hasOwn(REQUEST_BINDINGS, prefix)) {
    return undefined;
  }
  return REQUEST_BINDINGS[prefix];
}

// Only the deployment configuration selects a repository; tool arguments never do.
export function resolveRepositoryBinding(env: Env, binding: RequestBinding): RepositoryBinding | undefined {
  const value = env[binding.repositoryVariable];
  if (typeof value !== "string") return undefined;
  const parts = value.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === ".." ||
      owner.toLowerCase() === "example-owner" || repo.toLowerCase() === "example-repository") {
    return undefined;
  }
  return { owner, repo };
}
