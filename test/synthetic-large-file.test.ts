import assert from "node:assert/strict";
import test from "node:test";
import { generateLargeFile } from "./synthetic-large-file.ts";

test("synthetic large-file bytes match a fixed cross-platform vector", () => {
  // Independently calculated with Python hashlib; the literal LF bytes also
  // pin record boundaries and the transition to the next counter.
  const expected = Buffer.from(
    "00000000,bad5b0a558d388e252d5f026fcdb5431866db2eb0e15ce639b5b8f24afb480c8\n" +
    "00000001,0a9d56ac061b0d833f8ab2c0124f2af40a046cc33e8a700c36f2da0c1b74eab3\n",
    "ascii",
  );
  const actual = generateLargeFile("readpath-large-file-v1", expected.byteLength);
  assert.deepEqual(actual, new Uint8Array(expected));
  assert.deepEqual(
    generateLargeFile("readpath-large-file-v1", expected.byteLength - 1),
    actual.subarray(0, actual.byteLength - 1),
  );
  assert.notDeepEqual(generateLargeFile("different-seed", expected.byteLength), actual);
});
