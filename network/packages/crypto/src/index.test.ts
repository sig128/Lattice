import { describe, expect, it } from "vitest";
import { createMlDsaKeyPair, signTransfer, verifyTransfer, type SignedTransfer } from "./index.js";

const transfer: SignedTransfer = {
  protocol: "lattice-pq-transaction",
  version: 1,
  algorithm: "ML-DSA-65",
  genesisHash: "local-genesis-a",
  purpose: "native-transfer",
  senderKeyId: "alice-ml-dsa-65-1",
  recipient: "bob",
  amountAtomic: "1000000000",
  nonce: "1",
  expiresAtSlot: "500",
};

describe("ML-DSA signing prototype", () => {
  it("verifies the canonical transfer and rejects altered fields and domains", () => {
    const pair = createMlDsaKeyPair();
    const signature = signTransfer(pair.secretKey, transfer);
    expect(verifyTransfer(pair.publicKey, transfer, signature)).toBe(true);
    expect(verifyTransfer(pair.publicKey, { ...transfer, amountAtomic: "1000000001" }, signature)).toBe(false);
    expect(verifyTransfer(pair.publicKey, { ...transfer, genesisHash: "other-genesis" }, signature)).toBe(false);
    expect(verifyTransfer(pair.publicKey, { ...transfer, nonce: "2" }, signature)).toBe(false);
  });

  it("rejects malformed and oversized fields before signing", () => {
    const pair = createMlDsaKeyPair();
    expect(() => signTransfer(pair.secretKey, { ...transfer, recipient: "x".repeat(129) })).toThrow();
  });
});
