# Changelog

## 0.1.1

- Upgrade Wrangler to 4.136.2, which brings the patched sharp 0.35.4 through Miniflare. This removes the known libheif advisory from the development dependency tree. The Worker runtime itself does not decode images or import sharp.
- Refuse all GitHub API redirects, keeping authenticated requests on their explicitly configured destination.
- Pin GitHub Actions to complete commit IDs, avoid persisted checkout credentials, and run npm audit in CI.
- Disable optional Wrangler usage metrics and dependency instrumentation in the sample configuration.
- Replace a remaining historical short-SHA test literal with a synthetic value.

## 0.1.0

Initial public source release with 13 tools, two repository bindings, synthetic fixtures, and English/Chinese documentation.
