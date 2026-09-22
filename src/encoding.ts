import { ServiceError } from "./errors.ts";

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export interface TextAnalysis {
  byteLength: number;
  lineCount: number;
  firstLineFingerprint: string;
  lastLineFingerprint: string;
  isBinary: boolean;
  isLfsPointer: boolean;
  encoding: "utf-8" | "binary";
  text?: string;
}

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function encodeUtf8Strict(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  if (strictDecoder.decode(bytes) !== text) {
    throw new ServiceError(
      "INVALID_UNICODE_STRING",
      "content contains an unpaired UTF-16 surrogate and cannot be encoded losslessly as UTF-8.",
    );
  }
  return bytes;
}

export function decodeBase64(value: string): Uint8Array {
  try {
    const compact = value.replace(/\s/g, "");
    const decoded = atob(compact);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new ServiceError(
      "UPSTREAM_INVALID_BASE64",
      "GitHub returned content that is not valid base64.",
      502,
    );
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;
  for (let start = 0; start < bytes.length; start += stride) {
    binary += String.fromCharCode(...bytes.subarray(start, start + stride));
  }
  return btoa(binary);
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestHex(
  algorithm: "SHA-1" | "SHA-256",
  bytes: Uint8Array,
): Promise<string> {
  const copy = Uint8Array.from(bytes);
  return bytesToHex(await crypto.subtle.digest(algorithm, copy));
}

export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const framed = new Uint8Array(header.byteLength + bytes.byteLength);
  framed.set(header, 0);
  framed.set(bytes, header.byteLength);
  return digestHex("SHA-1", framed);
}

function stripLineEnding(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function fingerprint(line: string): string {
  let value = "";
  let count = 0;
  for (const character of line) {
    if (count >= 48) break;
    count += 1;
    if (character === "\r") value += "\\r";
    else if (character === "\n") value += "\\n";
    else if (character === "\u0085") value += "\\u0085";
    else if (character === "\u2028") value += "\\u2028";
    else if (character === "\u2029") value += "\\u2029";
    else value += character;
  }
  return value;
}

export function analyzeBytes(bytes: Uint8Array): TextAnalysis {
  let lfCount = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0) {
      return {
        byteLength: bytes.byteLength,
        lineCount: 0,
        firstLineFingerprint: "",
        lastLineFingerprint: "",
        isBinary: true,
        isLfsPointer: false,
        encoding: "binary",
      };
    }
    if (bytes[index] === 0x0a) lfCount += 1;
  }

  let text: string;
  try {
    text = strictDecoder.decode(bytes);
  } catch {
    return {
      byteLength: bytes.byteLength,
      lineCount: 0,
      firstLineFingerprint: "",
      lastLineFingerprint: "",
      isBinary: true,
      isLfsPointer: false,
      encoding: "binary",
    };
  }

  const lineCount = bytes.byteLength === 0
    ? 0
    : lfCount + (bytes.at(-1) === 0x0a ? 0 : 1);

  const firstLf = text.indexOf("\n");
  const firstRaw = text.length === 0
    ? ""
    : text.slice(0, firstLf < 0 ? text.length : firstLf);
  const first = stripLineEnding(firstRaw).replace(/^\uFEFF/, "");
  let last = "";
  if (lineCount === 1) {
    last = first;
  } else if (lineCount > 1) {
    const lastEnd = text.endsWith("\n") ? text.length - 1 : text.length;
    const previousLf = text.lastIndexOf("\n", lastEnd - 1);
    last = stripLineEnding(text.slice(previousLf + 1, lastEnd));
  }
  return {
    byteLength: bytes.byteLength,
    lineCount,
    firstLineFingerprint: fingerprint(first),
    lastLineFingerprint: fingerprint(last),
    isBinary: false,
    isLfsPointer:
      bytes.byteLength <= 4096 &&
      text.replace(/^\uFEFF/, "").startsWith(
        "version https://git-lfs.github.com/spec/v1\n",
      ),
    encoding: "utf-8",
    text,
  };
}

export function requireUtf8(analysis: TextAnalysis): string {
  if (analysis.isBinary || analysis.text === undefined) {
    throw new ServiceError(
      "BINARY_FILE",
      "The requested object is binary or is not strict UTF-8 text.",
      415,
    );
  }
  return analysis.text;
}

export function lineByteRange(
  bytes: Uint8Array,
  startLine: number,
  endLine: number,
  lineCount: number,
): { start: number; end: number } {
  if (
    lineCount === 0 ||
    startLine < 1 ||
    endLine < startLine ||
    startLine > lineCount ||
    endLine > lineCount
  ) {
    throw new ServiceError(
      "LINE_RANGE_OUT_OF_BOUNDS",
      `Line range ${startLine}-${endLine} is outside 1-${lineCount}.`,
    );
  }

  let currentLine = 1;
  let start = startLine === 1 ? 0 : -1;
  let end = bytes.byteLength;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (currentLine === endLine) {
      end = index + 1;
      break;
    }
    currentLine += 1;
    if (currentLine === startLine) start = index + 1;
  }
  if (start < 0) {
    throw new ServiceError(
      "LINE_RANGE_OUT_OF_BOUNDS",
      `Line range ${startLine}-${endLine} could not be resolved.`,
    );
  }
  return { start, end };
}

export function safeUtf8End(
  bytes: Uint8Array,
  start: number,
  requestedEnd: number,
): number {
  let end = Math.min(requestedEnd, bytes.byteLength);
  while (end > start && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end === start && requestedEnd > start && start < bytes.byteLength) {
    throw new ServiceError(
      "MAX_BYTES_SPLITS_UTF8",
      "max_bytes is too small to include the next complete UTF-8 character.",
    );
  }
  return end;
}

export function lineCountForChunk(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count + (bytes.at(-1) === 0x0a ? 0 : 1);
}

export function randomNonce(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
