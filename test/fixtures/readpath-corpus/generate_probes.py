#!/usr/bin/env python3
"""Generate and validate the deterministic CORPUS-V1-001 probe corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FILES = ROOT / "files"
BASELINE_BYTES = 12_288


PROBES = [
    {"id": "P00", "name": "P00_baseline.txt", "dimension": "baseline", "value": "ascii-lf-no-bom-short-ascii-name-txt", "bytes": BASELINE_BYTES},
    {"id": "P01", "name": "P01_size_512.txt", "dimension": "size_bytes", "value": 512, "bytes": 512},
    {"id": "P02", "name": "P02_size_10240.txt", "dimension": "size_bytes", "value": 10_240, "bytes": 10_240},
    {"id": "P03", "name": "P03_size_23552.txt", "dimension": "size_bytes", "value": 23_552, "bytes": 23_552},
    {"id": "P04", "name": "P04_size_24576.txt", "dimension": "size_bytes", "value": 24_576, "bytes": 24_576},
    {"id": "P05", "name": "P05_size_25600.txt", "dimension": "size_bytes", "value": 25_600, "bytes": 25_600},
    {"id": "P06", "name": "P06_size_43008.txt", "dimension": "size_bytes", "value": 43_008, "bytes": 43_008},
    {"id": "P07", "name": "P07_unicode_content.txt", "dimension": "content_charset", "value": "utf8-chinese", "bytes": BASELINE_BYTES, "unicode": True},
    {"id": "P08", "name": "P08_crlf.txt", "dimension": "newline", "value": "CRLF", "bytes": BASELINE_BYTES, "newline": "CRLF"},
    {"id": "P09", "name": "P09_bom.txt", "dimension": "bom", "value": "UTF-8-BOM", "bytes": BASELINE_BYTES, "bom": True},
    {"id": "P10", "name": "P10_long_line.txt", "dimension": "line_shape", "value": "one-extreme-middle-line", "bytes": BASELINE_BYTES, "long_line": True},
    {"id": "P11", "name": "P11_探针_é_nfc.txt", "dimension": "path_unicode_form", "value": "NFC-non-ASCII", "bytes": BASELINE_BYTES},
    {"id": "P12", "runtime": {"filename_codepoints": [80, 49, 50, 95, 25506, 38024, 95, 101, 769, 95, 110, 102, 100, 46, 116, 120, 116], "content_format": "ascii-short-lines-v1"}, "dimension": "path_unicode_form", "value": "NFD-non-ASCII", "bytes": BASELINE_BYTES},
    {"id": "P13", "name": "P13_extension.md", "dimension": "extension", "value": ".md", "bytes": BASELINE_BYTES},
    {"id": "P14", "name": "P14_extension.yaml", "dimension": "extension", "value": ".yaml", "bytes": BASELINE_BYTES},
    {"id": "P15", "name": "P15_extension.py", "dimension": "extension", "value": ".py", "bytes": BASELINE_BYTES},
    {"id": "P16", "name": "P16_no_extension", "dimension": "extension", "value": "none", "bytes": BASELINE_BYTES},
]


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def payload_text(byte_count: int, use_unicode: bool) -> bytes:
    if byte_count < 0:
        raise ValueError("negative payload size")
    if not use_unicode:
        return b"X" * byte_count
    unit = "中文内容".encode("utf-8")
    return unit * (byte_count // len(unit)) + b"X" * (byte_count % len(unit))


def short_lines(byte_count: int, newline: bytes, use_unicode: bool) -> bytes:
    if byte_count == 0:
        return b""
    if byte_count < len(newline):
        raise ValueError("body is too small for the requested newline")
    sizes: list[int] = []
    remaining = byte_count
    max_total = 72 if newline == b"\r\n" else 71
    while remaining > max_total:
        sizes.append(max_total)
        remaining -= max_total
    if remaining < len(newline):
        borrowed = len(newline) - remaining
        sizes[-1] -= borrowed
        remaining += borrowed
    sizes.append(remaining)
    chunks = []
    for total in sizes:
        chunks.append(payload_text(total - len(newline), use_unicode) + newline)
    return b"".join(chunks)


def make_probe(spec: dict[str, object]) -> bytes:
    probe_id = str(spec["id"])
    dimension = str(spec["dimension"])
    value = str(spec["value"])
    newline = b"\r\n" if spec.get("newline") == "CRLF" else b"\n"
    begin = f"BEGIN|CORPUS-V1-001|{probe_id}|{dimension}|{value}".encode("utf-8") + newline
    end = f"END|CORPUS-V1-001|{probe_id}|{dimension}|{value}".encode("utf-8") + newline
    bom = b"\xef\xbb\xbf" if spec.get("bom") else b""
    target = int(spec["bytes"])
    body_size = target - len(bom) - len(begin) - len(end)
    if body_size <= 1:
        raise ValueError(f"{probe_id}: target too small")
    if spec.get("long_line"):
        body = b"L" * (body_size - len(newline)) + newline
    else:
        body = short_lines(body_size, newline, bool(spec.get("unicode")))
    data = bom + begin + body + end
    if len(data) != target:
        raise AssertionError(f"{probe_id}: {len(data)} != {target}")
    data.decode("utf-8-sig", errors="strict")
    return data


def line_metrics(data: bytes) -> tuple[int, int]:
    plain = data[3:] if data.startswith(b"\xef\xbb\xbf") else data
    lines = plain.splitlines()
    return len(lines), max((len(line) for line in lines), default=0)


def render() -> tuple[dict[str, object], dict[str, object], dict[str, bytes]]:
    config = {
        "schema_version": 2,
        "task": "CORPUS-V1-001",
        "baseline": {
            "bytes": BASELINE_BYTES,
            "content_charset": "ASCII",
            "newline": "LF",
            "bom": False,
            "line_shape": "short",
            "path_charset": "ASCII",
            "extension": ".txt",
        },
        "probes": PROBES,
        "instrumentation_note": "Probe id in first/last fingerprint is measurement instrumentation; each controlled factor otherwise changes one declared dimension from baseline.",
    }
    config_hash = hashlib.sha256(canonical_json(config)).hexdigest()
    rendered: dict[str, bytes] = {}
    entries = []
    for spec in PROBES:
        data = make_probe(spec)
        runtime = spec.get("runtime")
        name = "".join(chr(codepoint) for codepoint in runtime["filename_codepoints"]) if runtime else str(spec["name"])
        # Runtime probes retain their byte oracle but have no checked-in path.
        path = None if runtime else f"probes/synthetic-readpath-v1/files/{name}"
        line_count, longest_line = line_metrics(data)
        path_form = "NFC" if unicodedata.normalize("NFC", name) == name else "NFD" if unicodedata.normalize("NFD", name) == name else "mixed"
        entry = {
            "probe_id": spec["id"],
            "path": path,
            **({"runtime": runtime} if runtime else {}),
            "controlled_dimension": spec["dimension"],
            "value": spec["value"],
            "baseline_value": config["baseline"].get(str(spec["dimension"]), "baseline"),
            "bytes": len(data),
            "git_blob_sha": git_blob_sha(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "first_fingerprint": data.decode("utf-8-sig").splitlines()[0],
            "last_fingerprint": data.decode("utf-8-sig").splitlines()[-1],
            "line_count": line_count,
            "longest_line_bytes": longest_line,
            "strict_utf8": True,
            "bom": data.startswith(b"\xef\xbb\xbf"),
            "newline": "CRLF" if b"\r\n" in data and b"\n" not in data.replace(b"\r\n", b"") else "LF",
            "path_has_non_ascii": any(ord(ch) > 127 for ch in name),
            "path_unicode_form": path_form,
            "extension": Path(name).suffix or "none",
        }
        if not runtime:
            rendered[name] = data
        entries.append(entry)
    manifest = {
        "schema_version": 2,
        "task": "CORPUS-V1-001",
        "config_hash": config_hash,
        "probe_count": len(entries),
        "total_probe_bytes": sum(int(entry["bytes"]) for entry in entries),
        "entries": entries,
    }
    return config, manifest, rendered


def write_all() -> None:
    config, manifest, rendered = render()
    FILES.mkdir(parents=True, exist_ok=True)
    expected_names = set(rendered)
    for old in FILES.iterdir():
        if old.is_file() and old.name not in expected_names:
            old.unlink()
    for name, data in rendered.items():
        (FILES / name).write_bytes(data)
    (ROOT / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def check_all() -> None:
    config, manifest, rendered = render()
    expected = {
        "config.json": json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        "manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    }
    for name, text in expected.items():
        if (ROOT / name).read_text(encoding="utf-8") != text:
            raise SystemExit(f"mismatch: {name}")
    for name, data in rendered.items():
        if (FILES / name).read_bytes() != data:
            raise SystemExit(f"mismatch: files/{name}")
    actual_names = {p.name for p in FILES.iterdir() if p.is_file()}
    if actual_names != set(rendered):
        raise SystemExit(f"unexpected file set: {sorted(actual_names ^ set(rendered))}")
    print(f"probe-corpus-ok count={manifest['probe_count']} bytes={manifest['total_probe_bytes']} config_hash={manifest['config_hash']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check_all()
    else:
        write_all()
        check_all()


if __name__ == "__main__":
    main()
