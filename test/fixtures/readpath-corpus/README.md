# Synthetic read-path corpus

These deterministic fixtures isolate byte size, ASCII/Chinese content, LF/CRLF,
BOM, short/extreme lines, ASCII/NFC/NFD paths, and extension differences. They
contain generated text, not research or production data.

`manifest.json` records byte counts, Git blob SHA, SHA-256, line metrics and a
canonical configuration hash. P11 has an NFC filename. P12 has no checked-in
file: explicit codepoints and an ASCII body recipe reconstruct its NFD filename
and content only inside a temporary acceptance repository. Tests compare its
bytes with independent Git objects and reject a normalized path substitution.

```sh
python3 test/fixtures/readpath-corpus/generate_probes.py
python3 test/fixtures/readpath-corpus/generate_probes.py --check
npm run test:acceptance
```

Generation uses Python; normal acceptance only needs Node.js and Git. It reads
the distributed fixtures and builds a temporary Git tree locally, so neither
repository history nor a remote, account credential, or production endpoint is
needed. The shared constructor cleans up its temporary repository.
