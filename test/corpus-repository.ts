import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ManifestEntry {
  probe_id: string;
  path: string;
  bytes: number;
  git_blob_sha: string;
  sha256: string;
  line_count: number;
  first_fingerprint: string;
  last_fingerprint: string;
  longest_line_bytes: number;
  runtime?: {
    filename_codepoints: number[];
    content_format: "ascii-short-lines-v1";
  };
}

export function createCorpusRepository(): { directory: string; commit: string } {
  const fixtureRoot = fileURLToPath(new URL("./fixtures/readpath-corpus/", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "readpath-corpus-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    // Build independent Git object oracles from distributed fixture bytes; no
    // parent checkout history, remote, or external repository is required.
    const prefix = "probes/synthetic-readpath-v1/";
    const manifest = JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")) as {
      entries: Array<Omit<ManifestEntry, "path"> & { path: string | null }>;
    };
    const addFile = (path: string, bytes: Buffer): string => {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), bytes);
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: directory, input: bytes, encoding: "utf8",
      }).trim();
      // NUL-delimited stdin preserves codepoints even with precomposeunicode=true;
      // passing the NFD path as a Git argv pathspec can normalize it on macOS.
      execFileSync("git", ["update-index", "-z", "--index-info"], {
        cwd: directory, input: Buffer.from(`100644 ${blob}\t${path}\0`, "utf8"),
      });
      return blob;
    };
    for (const entry of manifest.entries.filter((entry) => !entry.runtime)) {
      assert.ok(entry.path?.startsWith(`${prefix}files/`));
      const bytes = readFileSync(join(fixtureRoot, entry.path!.slice(prefix.length)));
      assert.equal(bytes.byteLength, entry.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
      assert.equal(addFile(entry.path!, bytes), entry.git_blob_sha);
    }
    const runtimeEntries = manifest.entries.filter((entry) => entry.runtime);
    assert.deepEqual(runtimeEntries.map((entry) => entry.probe_id), ["P12"]);
    for (const entry of runtimeEntries) {
      assert.equal(entry.path, null, "runtime probes must not have an in-repo path");
      assert.equal(entry.runtime!.content_format, "ascii-short-lines-v1");
      const name = String.fromCodePoint(...entry.runtime!.filename_codepoints);
      const begin = Buffer.from(`${entry.first_fingerprint}\n`, "utf8");
      const end = Buffer.from(`${entry.last_fingerprint}\n`, "utf8");
      let remaining = entry.bytes - begin.byteLength - end.byteLength;
      assert.ok(remaining > 1 && entry.longest_line_bytes > 0);
      const chunks = [begin];
      while (remaining > 0) {
        const length = Math.min(entry.longest_line_bytes + 1, remaining);
        const line = Buffer.alloc(length, "X");
        line[length - 1] = 0x0a;
        chunks.push(line);
        remaining -= length;
      }
      const bytes = Buffer.concat([...chunks, end]);
      assert.equal(bytes.byteLength, entry.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
      entry.path = `${prefix}files/${name}`;
      assert.equal(addFile(entry.path, bytes), entry.git_blob_sha);
    }
    assert.ok(manifest.entries.every((entry) => typeof entry.path === "string"));
    addFile(`${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
    const tree = git("write-tree");
    const commit = git(
      "-c", "user.name=Readpath corpus fixture",
      "-c", "user.email=readpath-fixture@example.invalid",
      "-c", "commit.gpgsign=false",
      "commit-tree", tree, "-m", "Build synthetic acceptance corpus",
    );
    return { directory, commit };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
