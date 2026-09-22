# Third-party software

The project's own source code is distributed under the MIT license in
`LICENSE`. That license does not replace the licenses of third-party tools or
their dependencies.

The development toolchain uses TypeScript, Node.js type definitions, Cloudflare
Workers type definitions, Wrangler, and Wrangler's dependencies, including
workerd. The exact package versions and integrity hashes are recorded in
`package-lock.json`. Inspect each installed package's license when distributing
that package or a binary that includes it; workerd, for example, has its own
LGPL license and accompanying notices.

This source distribution does not include `node_modules`, downloaded tool
binaries, credentials, or a hosted Worker service. Contributors should not add
those files to release archives.
