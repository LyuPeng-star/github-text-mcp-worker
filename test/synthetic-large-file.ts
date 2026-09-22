import { createHash } from "node:crypto";

export function generateLargeFile(seed: string, targetBytes: number): Uint8Array {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
    throw new RangeError("targetBytes must be a non-negative safe integer");
  }
  const bytes = new Uint8Array(targetBytes);
  let offset = 0;
  for (let counter = 0; offset < targetBytes; counter += 1) {
    // Explicit UTF-8, ASCII, and LF keep the byte stream identical on every OS.
    // Each counter has distinct content, so reordered or repeated chunks cannot
    // pass the acceptance test's full byte-for-byte reassembly comparison.
    const digest = createHash("sha256")
      .update("readpath-large-file-v1\0", "ascii")
      .update(seed, "utf8")
      .update(`\0${counter}`, "ascii")
      .digest("hex");
    const line = Buffer.from(`${counter.toString(16).padStart(8, "0")},${digest}\n`, "ascii");
    const count = Math.min(line.byteLength, targetBytes - offset);
    bytes.set(line.subarray(0, count), offset);
    offset += count;
  }
  return bytes;
}
