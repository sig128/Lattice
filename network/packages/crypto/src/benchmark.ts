import { performance } from "node:perf_hooks";
import { createMlDsaKeyPair, encodeTransfer, signTransfer, verifyTransfer, type SignedTransfer } from "./index.js";

const transfer: SignedTransfer = {
  protocol: "lattice-pq-transaction", version: 1, algorithm: "ML-DSA-65",
  genesisHash: "benchmark-development-genesis", purpose: "native-transfer",
  senderKeyId: "benchmark-key", recipient: "benchmark-recipient",
  amountAtomic: "1000000000", nonce: "1", expiresAtSlot: "1000",
};
const iterations = 50;

const keyStart = performance.now();
const pair = createMlDsaKeyPair();
const keygenMs = performance.now() - keyStart;
const signatures: Uint8Array[] = [];
const signStart = performance.now();
for (let i = 0; i < iterations; i++) signatures.push(signTransfer(pair.secretKey, { ...transfer, nonce: `${i}` }));
const signMs = (performance.now() - signStart) / iterations;
const verifyStart = performance.now();
for (let i = 0; i < iterations; i++) verifyTransfer(pair.publicKey, { ...transfer, nonce: `${i}` }, signatures[i]!);
const verifyMs = (performance.now() - verifyStart) / iterations;

console.log(JSON.stringify({
  algorithm: "ML-DSA-65",
  library: "@noble/post-quantum",
  runtime: process.version,
  iterations,
  sizes: {
    publicKeyBytes: pair.publicKey.length,
    secretKeyBytes: pair.secretKey.length,
    signatureBytes: signatures[0]!.length,
    canonicalMessageBytes: encodeTransfer(transfer).length,
  },
  timingsMs: { keygen: keygenMs, signMean: signMs, verifyMean: verifyMs },
  scope: "Off-chain prototype only; not integrated with native transactions or consensus",
}, null, 2));
