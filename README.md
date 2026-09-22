# GitHub Text MCP Worker

[中文说明](README.zh-CN.md) · [Protocol and limits](docs/public/protocol.md) · [Security](SECURITY.md)

A self-hosted Cloudflare Worker that gives an MCP client explicit, verifiable access to GitHub text files. Read a file at a full commit SHA, continue through UTF-8-safe chunks, and compare the returned Git blob identity. When you enable write permissions, commit several file changes in one non-force branch update and inspect the readback receipts.

The deployment binds each endpoint to one repository. Tool arguments cannot redirect requests to a different owner or repository. Two independent endpoints are available; using only the primary endpoint is supported.

## What it provides

- Immutable reads, directory/tree listings, literal file search, and commit metadata.
- Text responses with file identity, byte counts, continuation offsets, and deployment diagnostics. Empty files return an explicit envelope rather than a missing response.
- Optional single-commit writes and deletions, plus branch creation and guarded deletion.
- Separate connector credentials, GitHub tokens, and rate-limit bindings for the two repositories.
- Local tests using fixtures and mocked GitHub responses. The project does not provide a public demo service.

This is a focused text bridge for GitHub.com. It does not execute repository code, extract PDFs, retrieve Git LFS objects, provide an OAuth server, or replace a full Git client. The original integration target was Perplexity. A different host must support Streamable HTTP requests with a configurable `Authorization: Bearer …` header; compatibility with an untested Claude or other client is not promised. Hosts that require OAuth and cannot accept a manual Bearer header need an additional authorization layer, which is outside this project.

## Quick start

You need Node.js 24 or later, npm, Git, a Cloudflare account with Workers enabled, and access to the GitHub repository you want to expose.

### 1. Install and configure

```sh
git clone https://github.com/LyuPeng-star/github-text-mcp-worker.git
cd github-text-mcp-worker
npm ci
npx wrangler login
```

Edit `wrangler.jsonc`:

- Set `name` to an available Worker name for your Cloudflare account.
- Set `vars.PRIMARY_REPOSITORY` to your actual `owner/repository`.
- Leave `vars.SECONDARY_REPOSITORY` as `""` if you need only one repository.
- Keep the endpoint rate-limit bindings and `WORKER_VERSION_METADATA` binding. If you deploy multiple Worker instances in the same account, give each endpoint's limiter a `namespace_id` that is unique within that account; reusing IDs can share counters across instances.

The shipped `example-owner/example-repository` value deliberately fails closed. A blank, malformed, or placeholder repository is unavailable; it never falls back to another repository. The default configuration uses `workers.dev`, disables preview URLs explicitly, and requires no custom domain.

### 2. Create credentials

Create a **fine-grained GitHub personal access token** for the correct resource owner and select **only the target repository**:

| Intended access | Repository permissions |
|---|---|
| Read files and metadata | Contents: **Read-only**; Metadata: **Read-only** |
| Write files or manage branches | Contents: **Read and write**; Metadata: **Read-only** |

Set an expiration date and plan to replace the deployed token before it expires. Organization approval, repository rules, and protected branches can still limit access. Updating workflow files can require additional GitHub permissions; do not grant them unless that operation is intended. GitHub code-index search also depends on the upstream search API's support for your credential and repository. See [GitHub's token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) and [endpoint permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

Create a separate, long random **connector token** in your password manager. This is the credential your MCP host sends to the Worker. It is not your GitHub token.

Store both values through Wrangler's interactive prompts:

```sh
npx wrangler secret put CONNECTOR_TOKEN_PRIMARY
npx wrangler secret put GITHUB_TOKEN_PRIMARY
```

Do not put real credentials in `wrangler.jsonc`, source files, client screenshots, or command-line arguments. Wrangler secrets are described in [Cloudflare's documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

A read-only GitHub token is the way to restrict upstream mutations. The Worker advertises its write tools even with a read-only token; it does not implement separate per-tool roles or a write-enable switch.

### 3. Check and deploy

```sh
npm run check
npm test
npm run test:acceptance
npx wrangler deploy --dry-run
```

For a Git checkout, commit your nonsecret configuration before using the deployment guard:

```sh
git add wrangler.jsonc
git commit -m "Configure repository binding"
npm run deploy
```

`npm run deploy` requires a clean tracked and untracked working tree, obtains the actual 40-character `HEAD`, and injects `SOURCE_COMMIT` and a source tag. It supports local forks, other branch names, and detached `HEAD`; it does not require this repository's upstream remote.

If you downloaded a source archive without `.git`, use `WRANGLER_SEND_METRICS=false npx wrangler deploy` in a POSIX shell instead (or set the same environment variable in your shell). The service still works, but `source_commit` is `unavailable` unless you supply a genuine source identity. Do not invent one. The [Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/) covers account-specific deployment settings.

### 4. Connect an MCP host

Use the URL printed by Wrangler, with this path:

```text
https://<worker-name>.<account-subdomain>.workers.dev/primary/mcp
```

Configure a custom request header:

```text
Authorization: Bearer <your-primary-connector-token>
```

Choose Streamable HTTP if your host asks for a transport. Requests use `POST` and `Content-Type: application/json`. This endpoint has no separate legacy `/sse` route, OAuth discovery flow, or persistent server-to-client stream. A host requiring those features is not compatible without an adapter.

If the host supplies an `Origin` header, the default allowed origins are `https://perplexity.ai` and `https://www.perplexity.ai`. For another origin, set the optional `ALLOWED_ORIGINS` variable to a comma-separated list of exact origins and redeploy. This replaces the defaults; it does not configure browser CORS or prove client compatibility. Server-to-server requests without `Origin` are accepted subject to authentication and other checks.

Start with `resolve_ref`, then call `stat_file` and `get_file_text` using its complete `commit_sha`. Keep that same SHA for all chunks of a file. See the [protocol guide](docs/public/protocol.md#reading-a-file) for continuation and verification details.

### Optional second repository

Set `SECONDARY_REPOSITORY` to another actual `owner/repository`, then add:

```sh
npx wrangler secret put CONNECTOR_TOKEN_SECONDARY
npx wrangler secret put GITHUB_TOKEN_SECONDARY
```

Use a separate connector token and a separate fine-grained GitHub token scoped to that repository. Redeploy your updated, committed configuration. The second endpoint is `/secondary/mcp`; it uses `MCP_RATE_LIMITER_SECONDARY`. Its credentials and repository binding do not fall back to the primary endpoint. A primary-only deployment does **not** require either secondary secret.

## Tools

All tools operate within the endpoint's configured repository. The schemas returned by `tools/list` are authoritative.

| Tool | Purpose |
|---|---|
| `resolve_ref` | Resolve a supported branch or tag name to a full commit SHA. |
| `stat_file` | Inspect an ordinary file's blob identity, size, text shape, and encoding. |
| `get_file_text` | Read strict UTF-8 text at a commit, with optional line/byte ranges and continuation. |
| `search_in_file` | Search literal, case-sensitive text in one immutable file. |
| `search_repo_index` | Find paths in GitHub's eventually consistent default-branch code index; verify hits at your chosen SHA. |
| `list_directory` | List one directory at a commit. |
| `list_tree` | List a bounded subtree at a commit without following symlinks or submodules. |
| `get_commit_metadata` | Read parents, dates, and changed-file metadata; no diff patches or commit message. |
| `put_file_text` | Commit the complete content of one UTF-8 file. |
| `put_files_text` | Commit multiple complete files and/or deletions together. |
| `verify_write` | Compare a file's blob SHA with the expected identity at a commit. |
| `create_branch` | Create a branch at a full commit SHA without overwriting an existing branch. |
| `delete_branch` | Delete a non-default branch only after expected-head and merged-ancestry checks. |

File reads require complete **40-hex commit SHAs**; branch names, tags, short SHAs, and revision expressions are not interchangeable with them. `resolve_ref` and write operations default to the branch name `main`, not the repository's detected default; specify another name when needed.

## Operational boundaries

- A file read is limited to **1,310,720 bytes**. Text chunks default to **65,536 bytes**; use continuation rather than assuming a large file was returned in full.
- A write call accepts **1–20 combined write/delete paths** and at most **262,144 bytes** of new UTF-8 content. It is a complete-file API, not a patch API.
- Atomic writes publish one commit by a non-force ref update. A committed change can still have an unsuccessful readback receipt; inspect `committed`, `commit_sha`, and each `verified` field before deciding what happened. Do not blindly retry an uncertain write.
- Branch deletion has an unavoidable final-read-to-delete race because GitHub's delete-ref API has no atomic expected-SHA condition. Its checks do not make deletion race-free.
- Both endpoint limiters are configured at **60 requests per 60 seconds**. This is a Cloudflare binding limit, not a promise of globally exact throttling or a substitute for GitHub quotas.
- Code-index search is not commit-pinned and is not proof of repository-wide absence. Large listings fail explicitly instead of silently returning a complete-looking partial list.

See [protocol details](docs/public/protocol.md) for exact ranges, budgets, errors, and integrity fields. Test results describe the tested implementation and fixtures; they do not establish an uptime or compatibility guarantee for a hosted deployment.

## Development and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and [SECURITY.md](SECURITY.md) for deployment boundaries and reporting guidance. Licensed under the [MIT License](LICENSE).
