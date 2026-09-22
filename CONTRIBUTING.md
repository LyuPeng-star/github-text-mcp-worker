# Contributing

Contributions that improve precise file reads, bounded outputs, credential isolation, and understandable failure handling are welcome. Open an issue to discuss broad interface changes before implementing them. Keep examples and tests independent of real repositories, user data, and deployed credentials.

## Local setup

Use Node.js 24 or later, npm, and Git:

```sh
npm ci
npm run check
npm test
npm run test:acceptance
npx wrangler deploy --dry-run
```

`npm run test:all` runs all TypeScript test files in one command. The tests use local fixtures and mocked GitHub responses; acceptance tests create a temporary Git repository to compare bytes against Git objects. They do not require a GitHub token, an existing production deployment, or the project's original Git history. Python is needed only if you choose to regenerate the relevant fixtures, not for the normal commands above.

A local Worker can be started with `npm run dev`. Any live requests still need a configured repository and your own credentials. Do not make live mutations part of ordinary tests. A successful local check or dry run does not establish compatibility with every remote MCP host.

## Change expectations

- Treat `tools/list` schemas and documented envelopes as public interfaces. Update the English and Chinese READMEs and [protocol guide](docs/public/protocol.md) when behavior changes.
- Preserve exact UTF-8 bytes, LF/CRLF and BOM behavior, and distinct NFC/NFD paths. Keep byte offsets separate from character offsets and line numbers.
- Preserve endpoint-specific repository, credential, and limiter boundaries. Never let arbitrary tool arguments select an owner, repository, API host, or download URL.
- Test meaningful boundary behavior: split multibyte characters, empty files, incomplete upstream trees, over-budget results, stale parent commits, permission failures, and ambiguous mutation responses.
- Keep writes non-force and their readback outcomes explicit. Document any remaining races rather than describing guarded operations as unconditionally safe.
- Use synthetic token sentinels and fixtures. Do not add real paths, account identifiers, operational logs, private conversation archives, or credentials.

Keep pull requests focused. Explain the trigger, changed behavior, relevant checks, and any limits that remain. Generated or copied files should identify how to reproduce them. Do not claim that tests were run if they were not.

## Deployment and release work

`npm run deploy` is an optional clean-Git deployment guard that injects the actual source commit and a source tag. It accepts forks and arbitrary branch names. `npx wrangler deploy` also supports source archives, with source identity unavailable when it is not supplied. Neither command should be run against a production account as part of an ordinary contribution.

Cloudflare configuration, permissions, deployment URLs, and secrets belong to each operator. A contribution does not authorize changes to someone else's Worker or repository. For security reports, follow [SECURITY.md](SECURITY.md).

This project is distributed under the [MIT License](LICENSE). Submit only material you have the right to contribute under that license.
