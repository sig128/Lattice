import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { z } from "zod";

export const signedTransferSchema = z.object({
  protocol: z.literal("lattice-pq-transaction"),
  version: z.literal(1),
  algorithm: z.literal("ML-DSA-65"),
  genesisHash: z.string().min(1).max(96),
  purpose: z.literal("native-transfer"),
  senderKeyId: z.string().min(1).max(128),
  recipient: z.string().min(1).max(128),
  amountAtomic: z.string().regex(/^[1-9][0-9]*$/),
  nonce: z.string().regex(/^[0-9]+$/),
  expiresAtSlot: z.string().regex(/^[1-9][0-9]*$/),
});
export type SignedTransfer = z.infer<typeof signedTransferSchema>;

export function encodeTransfer(input: SignedTransfer): Uint8Array {
  const message = signedTransferSchema.parse(input);
  const fields = [
    message.protocol, `${message.version}`, message.algorithm, message.genesisHash,
    message.purpose, message.senderKeyId, message.recipient, message.amountAtomic,
    message.nonce, message.expiresAtSlot,
  ];
  return new TextEncoder().encode(fields.map((field) => `${field.length}:${field}`).join("|"));
}

export function createMlDsaKeyPair() {
  return ml_dsa65.keygen();
}

export function signTransfer(secretKey: Uint8Array, transfer: SignedTransfer): Uint8Array {
  return ml_dsa65.sign(encodeTransfer(transfer), secretKey);
}

export function verifyTransfer(
  publicKey: Uint8Array,
  transfer: SignedTransfer,
  signature: Uint8Array,
): boolean {
  return ml_dsa65.verify(signature, encodeTransfer(transfer), publicKey);
}
