import { performance } from "node:perf_hooks";

const sizes = [49_152, 262_144, 1_291_669, 4_194_304];
const iterations = 30;

async function measure(algorithm, size) {
  const bytes = new Uint8Array(size);
  bytes.fill(0x61);
  await crypto.subtle.digest(algorithm, bytes);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await crypto.subtle.digest(algorithm, bytes);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    algorithm,
    bytes: size,
    iterations,
    median_ms: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    p95_ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
    max_ms: Number(samples.at(-1).toFixed(3)),
  };
}

const results = [];
for (const size of sizes) {
  results.push(await measure("SHA-1", size));
  results.push(await measure("SHA-256", size));
}
process.stdout.write(`${JSON.stringify({ runtime: process.version, results }, null, 2)}\n`);
