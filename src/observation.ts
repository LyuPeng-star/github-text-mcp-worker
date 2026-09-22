import type { Env } from "./types.ts";

export type GitHubFetchAttempted = boolean | "unknown";
export type GitHubFetchOutcome =
  | "not_attempted"
  | "succeeded"
  | "upstream_not_found"
  | "upstream_error"
  | "unknown";

export interface ObservationFields {
  deployment_version_id: string;
  deployment_identity_scope: "cloudflare_worker_version_metadata" | "unavailable";
  deployment_version_tag: string | null;
  deployment_version_created_at: string | null;
  source_commit: string;
  observed_elapsed_ms: number;
  observed_elapsed_scope: "worker_clock_after_schema_validation";
  observed_elapsed_clock_note: string;
  github_fetch_attempted: GitHubFetchAttempted;
  github_fetch_outcome: GitHubFetchOutcome;
}

export const OBSERVED_ELAPSED_SCOPE = "worker_clock_after_schema_validation" as const;
export const OBSERVED_ELAPSED_CLOCK_NOTE =
  "Production Workers clocks may advance only around I/O; this diagnostic is not reliable total elapsed time and cannot by itself prove whether GitHub fetch occurred.";

const OUTCOME_PRIORITY: Record<GitHubFetchOutcome, number> = {
  not_attempted: 0,
  unknown: 1,
  succeeded: 2,
  upstream_not_found: 3,
  upstream_error: 4,
};

function safeMetadataString(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function sourceCommit(value: unknown): string {
  return typeof value === "string" && /^[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : "unavailable";
}

export class ObservationContext {
  private readonly deploymentVersionId: string;
  private readonly deploymentIdentityScope:
    | "cloudflare_worker_version_metadata"
    | "unavailable";
  private readonly deploymentVersionTag: string | null;
  private readonly deploymentVersionCreatedAt: string | null;
  private readonly sourceCommit: string;
  private readonly now: () => number;
  private schemaValidatedAt: number | null = null;
  private githubFetchAttempted: GitHubFetchAttempted = false;
  private githubFetchOutcome: GitHubFetchOutcome = "not_attempted";
  private snapshotValue: ObservationFields | null = null;

  constructor(env: Env, now: () => number = () => performance.now()) {
    const metadata = env.WORKER_VERSION_METADATA;
    const id = safeMetadataString(metadata?.id);
    this.deploymentVersionId = id ?? "unavailable";
    this.deploymentIdentityScope = id
      ? "cloudflare_worker_version_metadata"
      : "unavailable";
    this.deploymentVersionTag = id ? safeMetadataString(metadata?.tag) : null;
    this.deploymentVersionCreatedAt = id
      ? safeMetadataString(metadata?.timestamp)
      : null;
    this.sourceCommit = sourceCommit(env.SOURCE_COMMIT);
    this.now = now;
  }

  markSchemaValidated(): void {
    if (this.schemaValidatedAt === null) this.schemaValidatedAt = this.now();
  }

  markGitHubFetchAttempted(): void {
    this.githubFetchAttempted = true;
    if (this.githubFetchOutcome === "not_attempted") {
      this.githubFetchOutcome = "unknown";
    }
  }

  markGitHubFetchOutcome(outcome: Exclude<GitHubFetchOutcome, "not_attempted">): void {
    if (OUTCOME_PRIORITY[outcome] >= OUTCOME_PRIORITY[this.githubFetchOutcome]) {
      this.githubFetchOutcome = outcome;
    }
  }

  snapshot(): ObservationFields {
    if (this.snapshotValue) return this.snapshotValue;
    const elapsed = this.schemaValidatedAt === null
      ? 0
      : Math.max(0, Math.floor(this.now() - this.schemaValidatedAt));
    this.snapshotValue = {
      deployment_version_id: this.deploymentVersionId,
      deployment_identity_scope: this.deploymentIdentityScope,
      deployment_version_tag: this.deploymentVersionTag,
      deployment_version_created_at: this.deploymentVersionCreatedAt,
      source_commit: this.sourceCommit,
      observed_elapsed_ms: elapsed,
      observed_elapsed_scope: OBSERVED_ELAPSED_SCOPE,
      observed_elapsed_clock_note: OBSERVED_ELAPSED_CLOCK_NOTE,
      github_fetch_attempted: this.githubFetchAttempted,
      github_fetch_outcome: this.githubFetchOutcome,
    };
    return this.snapshotValue;
  }
}

export function observationTextLines(fields: ObservationFields): string[] {
  return [
    `deployment_version_id: ${fields.deployment_version_id}`,
    `deployment_identity_scope: ${fields.deployment_identity_scope}`,
    `deployment_version_tag: ${fields.deployment_version_tag ?? "null"}`,
    `deployment_version_created_at: ${fields.deployment_version_created_at ?? "null"}`,
    `source_commit: ${fields.source_commit}`,
    `observed_elapsed_ms: ${fields.observed_elapsed_ms}`,
    `observed_elapsed_scope: ${fields.observed_elapsed_scope}`,
    `observed_elapsed_clock_note: ${fields.observed_elapsed_clock_note}`,
    `github_fetch_attempted: ${fields.github_fetch_attempted}`,
    `github_fetch_outcome: ${fields.github_fetch_outcome}`,
  ];
}
