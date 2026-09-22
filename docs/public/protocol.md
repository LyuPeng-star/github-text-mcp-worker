# Protocol and behavior

This document describes the implementation in this repository. The runtime schemas from `tools/list`, backed by [`src/service.ts`](../../src/service.ts), define the accepted arguments. It is not a compatibility certificate for every MCP client.

## Endpoint and authentication

| URL path | Repository variable | Connector secret | GitHub secret | Limiter binding |
|---|---|---|---|---|
| `/primary/mcp` | `PRIMARY_REPOSITORY` | `CONNECTOR_TOKEN_PRIMARY` | `GITHUB_TOKEN_PRIMARY` | `MCP_RATE_LIMITER_PRIMARY` |
| `/secondary/mcp` | `SECONDARY_REPOSITORY` | `CONNECTOR_TOKEN_SECONDARY` | `GITHUB_TOKEN_SECONDARY` | `MCP_RATE_LIMITER_SECONDARY` |

Repository variables contain exactly `owner/repository`, without a URL. An empty, invalid, or example binding is unavailable. Missing credentials or a missing/failing limiter also fail closed. Primary configuration does not depend on secondary credentials. Requests cannot select a repository through tool arguments, and unknown arguments are rejected.

The HTTP endpoint accepts `POST` JSON-RPC 2.0 objects, not request batches. Send `Content-Type: application/json` and the exact `Authorization: Bearer <connector-token>` header. Protocol negotiation supports `2025-03-26` and `2025-06-18`, with `2025-06-18` as the fallback. Supported methods are:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`

Notifications without an `id` receive HTTP 202. There are no resources/prompts APIs, OAuth endpoints, MCP session IDs, GET event streams, DELETE-session endpoints, or legacy `/sse` route. Non-POST requests receive 405. JSON responses are the normal form; an `Accept` requesting only `text/event-stream` receives a single SSE message carrying the same JSON-RPC response, not a persistent stream.

When supplied, `MCP-Protocol-Version` is checked on requests other than `initialize`. Origins are checked when an `Origin` header exists. The default allowlist contains the two Perplexity origins in the README; `ALLOWED_ORIGINS` replaces it with exact comma-separated origins. Wildcards and suffix matching are not supported. No-Origin server requests are allowed through this check, but still need credentials. Browser preflight/CORS support is not implemented.

## Tool arguments

Required arguments are bold. Optional arguments and their defaults follow. All paths are repository-relative and preserve Unicode normalization; use the exact path returned by a listing. Full commit IDs are 40 hexadecimal characters. Absolute paths, traversal, control characters, and unsupported revision syntax are rejected.

| Tool | Arguments |
|---|---|
| `resolve_ref` | `ref="main"`; a bare single-segment branch/tag name or explicit `refs/heads/…` / `refs/tags/…` |
| `stat_file` | **`path`, `commit_sha`** |
| `get_file_text` | **`path`, `commit_sha`**; `start_line`, `end_line` **or** `byte_offset`, `byte_limit`; `max_bytes=65536`, `include_sha256=false` |
| `search_in_file` | **`path`, `commit_sha`, `pattern`**; `max_matches=50`, `context_lines=0` |
| `search_repo_index` | **`query`**; `max_results=30` |
| `list_directory` | **`commit_sha`**; `path=""` |
| `list_tree` | **`commit_sha`**; `path=""`, `max_depth` (unlimited when omitted) |
| `get_commit_metadata` | **`commit_sha`** |
| `put_file_text` | **`path`, `content`, `message`**; `branch="main"`, `expected_parent_sha` |
| `put_files_text` | **`files`, `message`**; `deletions=[]`, `branch="main"`, `expected_parent_sha`; each file has `path` and complete `content` |
| `verify_write` | **`path`, `commit_sha`, `expected_blob_sha`** |
| `create_branch` | **`branch`, `from_commit_sha`** |
| `delete_branch` | **`branch`, `expected_head_sha`** |

Use explicit `refs/heads/feature/example` for slash-containing branch names when resolving a ref. The default name `main` is not automatically changed to match a repository's default branch.

## Reading a file

1. Call `resolve_ref` for the desired branch or tag. Save the returned full `commit_sha`.
2. Use `list_directory` / `list_tree` to discover exact paths, and `stat_file` to inspect a chosen file's metadata.
3. Call `get_file_text` with that path and SHA. For a whole-file read, omit range arguments.
4. When `has_more` is true, continue with the same path and SHA and `byte_offset=next_byte_offset`.
5. For a complete file, account for all bytes from offset zero through `byte_length`, without gaps or duplicate ranges. Use the expected Git blob SHA to validate the assembled bytes when independent integrity verification is needed.

The file response contains exactly one MCP `text` content block. Its envelope starts with `GITHUB_FILE_TEXT_V1`, followed by identity and selection fields, deployment diagnostics, and a marked body. Fields include:

| Field | Meaning |
|---|---|
| `commit`, `path`, `blob_sha` | Identity of the selected file version |
| `byte_length`, `line_count` | Whole-file shape |
| `first_line_fingerprint`, `last_line_fingerprint` | Short descriptive excerpts from the whole file, not cryptographic hashes |
| `sha256` | Optional whole-file SHA-256, only when requested within its size limit |
| `range` | Delivered selection; byte ranges are half-open `[start,end)` |
| `selection_end_byte_offset` | Requested selection's effective UTF-8-safe exclusive end |
| `chunk_bytes`, `chunk_lines` | Delivered bytes and line fragments |
| `truncated` | The output budget shortened the requested selection |
| `has_more`, `next_byte_offset` | Whether later file bytes exist, and their continuation position |

The ordinary markers are `---BEGIN FILE---` and `---END FILE---`. If the file body contains the closing marker, nonce-specific markers are used and `delimiter_nonce` is reported. The body is not trimmed or normalized. A closing marker can immediately follow a file with no terminal newline; parse the envelope/byte count rather than adding or deleting a newline.

An empty file is a successful response with zero body bytes. Invalid UTF-8 or binary content cannot be returned as file text. `stat_file` can report binary classification. Git LFS pointer text can be identified, but the Worker does not fetch the referenced LFS object. Symlinks and submodules are not followed as ordinary files.

### Range semantics

- Lines are 1-based, inclusive ranges. Existing LF or CRLF terminators are included.
- Byte offsets are zero-based. `byte_limit` is a maximum count and must be positive when present.
- Line and byte selectors cannot be combined in one call.
- A byte offset inside a multibyte UTF-8 character fails with `BYTE_OFFSET_SPLITS_UTF8` and a preceding `safe_offset`. The end is moved back to a valid boundary; a budget too small for one character fails explicitly.
- Offset equal to `byte_length` is a valid empty EOF read. A larger offset fails.
- `has_more` refers to the remaining **file**, not just the requested range. A fully delivered line range can have `truncated=false` and `has_more=true`. When reading only a bounded selection, stop at `selection_end_byte_offset` instead of continuing through the rest of the file.
- `chunk_lines` counts fragments; it need not equal the number of complete source lines.

## Listings, metadata, and search

Directory and tree entries are sorted by UTF-8 path bytes without Unicode normalization. Types distinguish ordinary files, directories, symlinks, and submodules; only ordinary file entries include `blob_sha` and `byte_length`. Tree depth is relative to the selected path. A truncated upstream tree or an exceeded local listing budget returns an error, not a partial successful listing.

`get_commit_metadata` returns the commit SHA, parents, author/committer dates, and changed paths with status and line counts. Renames include `previous_path`. The diff is against the first parent, including merge commits; a root commit uses the empty tree. Commit messages and diff patches are not returned. Pagination and a complete file list are required, including checks before accepting an empty file list.

`search_in_file` is a case-sensitive **literal substring** search, not a regular expression. Matching lines have 1-based numbers. It reports truncation when its match or output budget is reached.

`search_repo_index` makes one request to GitHub's code-search index and returns only paths and indexed blob SHAs. It adds the bound repository scope itself; caller-supplied `repo:`, `user:`, and `org:` scopes are rejected. This API is eventually consistent, operates on GitHub's default-branch index, and cannot be pinned to a commit. The result explicitly has `anchored=false` and `verification_required=true`.

For an index hit, inspect the same path with `stat_file` or `list_tree` at the desired commit and compare its blob SHA. Equality confirms that hit's file bytes match the indexed version, not that the entire search is complete. If the SHA differs, use `search_in_file` at your anchor with an appropriate literal pattern. Observe `has_more` and `incomplete_results`; zero hits cannot establish absence at an immutable commit. Unsupported upstream search access and search rate limits are separate errors and are not automatically retried.

## Writes and branches

Writes use Git Data API blobs, a tree based on the existing tree, one commit whose parent is the observed branch head, and a single ref update with `force=false`. Provide `expected_parent_sha` to reject a stale initial head before creating write objects. The non-force update also rejects competing branch histories. This is not a merge or patch service.

`put_files_text` requires the `files` array even for deletion-only calls. An empty string writes an empty file; paths omitted from both arrays remain unchanged. Deleting a directory removes its subtree. Missing deletion targets, duplicate paths, write/delete overlap, and ancestor/descendant collisions in the requested paths are rejected. Existing symlinks, submodules, and directories cannot be overwritten as ordinary text files.

Atomicity applies to publishing the commit through the branch ref. It does not mean every GitHub API request is transactional: a failed operation can leave unreferenced Git objects. A successful commit can also be followed by a readback failure. A result with `committed=true` records the published commit and includes per-file and per-deletion `verified` receipts; do not interpret an unsuccessful receipt as “nothing was written.”

If the ref-update response is ambiguous, the service reads the ref to reconcile it rather than blindly repeating the mutation. `REF_UPDATE_OUTCOME_UNKNOWN` includes the candidate commit when the state cannot be resolved. Check the actual branch and candidate before deciding whether another write is appropriate. `verify_write` separately compares a file's expected blob SHA at an immutable commit.

`create_branch` creates a new ref at `from_commit_sha`; an existing branch is not overwritten. `delete_branch`:

1. Refuses the repository's actual default branch.
2. Requires the observed head to match `expected_head_sha` exactly, including case.
3. Requires that head to be an ancestor of the default branch, using GitHub's comparison result and merge base.
4. Rechecks the head immediately before deletion, and never retries the deletion.

GitHub does not provide an atomic expected-SHA condition for delete-ref. Another actor can change the branch after the final check. These safeguards reduce accidental deletion but do **not** eliminate that race. GitHub permissions and repository rules remain in force.

## Limits

Byte limits use UTF-8 bytes, not characters or model tokens.

| Operation | Limit |
|---|---:|
| HTTP request body | 2,097,152 bytes |
| File loaded for ordinary reads | 1,310,720 bytes |
| `get_file_text.max_bytes` | Default 65,536; maximum 1,048,576 |
| Whole-file `include_sha256` | Files up to 262,144 bytes |
| `search_in_file` input | 262,144 bytes |
| File search matches/context | Up to 500 matching lines; 0–20 context lines |
| File search output | 131,072 bytes |
| One directory | 1,000 entries and 131,072 serialized output bytes |
| Recursive tree | 5,000 selected entries and 131,072 serialized output bytes |
| Code-index query/results | Up to 256 Unicode characters; 1–100 results, default 30, one page |
| Code-index output | 131,072 serialized bytes |
| Commit metadata | 1,000 changed files and 131,072 serialized output bytes |
| Combined writes and deletions | 1–20 paths |
| Combined new write content | 262,144 bytes |
| Commit message | Nonblank, up to 500 characters |

Keep ordinary read chunks near the default; the larger accepted maximum does not guarantee adequate CPU or memory budget under every Cloudflare plan or workload. Output limits for structured listings include their diagnostic fields.

The checked-in limiter configuration is 60 requests per 60 seconds per endpoint binding. The rate-limit key is shared by that endpoint's authenticated callers, not a per-user identity. When deploying multiple Worker instances in one account, assign a distinct account-unique `namespace_id` to every endpoint limiter so instances do not unintentionally share counters. Cloudflare and GitHub may impose additional limits.

## Errors and diagnostics

Common HTTP responses include 401 for incorrect authentication, 403 for a disallowed Origin, 404 for an unknown path, 405 for unsupported methods, 413 for an oversized request, 415 for incorrect content type, 429 for the configured limiter, and 503 for unavailable configuration or limiter. Validation order may produce an unavailable-configuration response before checking credentials.

Malformed JSON and JSON-RPC envelopes receive JSON-RPC errors. Tool failures normally arrive in a successful JSON-RPC envelope containing `isError=true` and a nonempty text block beginning `ERROR <code>` and `result: null`. Check the tool result, not only HTTP status. Error text does not include a partial successful file body.

Tool results expose `service_version`, `source_commit`, Worker version metadata where available, and explicit GitHub fetch-attempt/outcome diagnostics. Missing source or deployment identity is reported as `unavailable`, never inferred from the selected data repository's commit. `observed_elapsed_ms` is a Worker-clock diagnostic measured after schema validation; it is not a reliable wall-clock duration, performance guarantee, or independent proof that a network request occurred.
