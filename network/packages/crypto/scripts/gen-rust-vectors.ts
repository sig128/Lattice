// Generates deterministic ML-DSA-65 vectors with @noble/post-quantum so the
// fork's Rust verifier (fips204) is tested against an independent implementation.
import { writeFileSync } from "node:fs";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

const out = process.argv[2];
if (!out) throw new Error("usage: tsx scripts/gen-rust-vectors.ts <output.json>");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const cases = [];
for (let i = 0; i < 4; i++) {
  const seed = new Uint8Array(32).fill(i + 1);
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  const message = new TextEncoder().encode(`lattice cross-implementation vector ${i}`.repeat(i + 1));
  const signature = ml_dsa65.sign(message, secretKey, { extraEntropy: false });
  if (!ml_dsa65.verify(signature, message, publicKey)) throw new Error("noble self-check failed");
  cases.push({ seed: hex(seed), publicKey: hex(publicKey), message: hex(message), signature: hex(signature) });
}
writeFileSync(
  out,
  JSON.stringify({ generator: "@noble/post-quantum 0.7.1 ml_dsa65 (pure, empty context, deterministic)", cases }, null, 1),
);
console.log(`wrote ${cases.length} vectors to ${out}`);
