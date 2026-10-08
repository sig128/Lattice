import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  encodeVaultTransfer,
  MLDSA65_PUBLIC_KEY_LEN,
  MLDSA65_SIGNATURE_LEN,
  PACKET_DATA_SIZE,
  PQ_VAULT_PROGRAM_ID,
  signVaultTransfer,
  transactionSize,
  transferPlan,
  vaultSetupPlan,
  type VaultTransfer,
} from "./pqVault.js";

const filled = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
const golden: VaultTransfer = {
  genesisHash: new Uint8Array(32).fill(1),
  programId: filled(2),
  vault: filled(3),
  recipient: filled(4),
  amount: 5n,
  nonce: 6n,
  expirySlot: 7n,
};
// Shared with chain/programs/pq-vault/src/state.rs `golden_vector_matches_ts_client`.
export const GOLDEN_HEX =
  "19" + Buffer.from("lattice-pq-vault-transfer").toString("hex") + "0101" +
  "01".repeat(32) + "02".repeat(32) + "03".repeat(32) + "04".repeat(32) +
  "0500000000000000" + "0600000000000000" + "0700000000000000";

describe("pq-vault client", () => {
  it("encodes the canonical message byte-identically to the on-chain program", () => {
    const m = encodeVaultTransfer(golden);
    expect(m.length).toBe(180);
    expect(Buffer.from(m).toString("hex")).toBe(GOLDEN_HEX);
  });

  it("signatures bind every field", () => {
    const { publicKey, secretKey } = ml_dsa65.keygen(new Uint8Array(32).fill(9));
    const sig = signVaultTransfer(secretKey, golden);
    expect(sig.length).toBe(MLDSA65_SIGNATURE_LEN);
    expect(ml_dsa65.verify(sig, encodeVaultTransfer(golden), publicKey)).toBe(true);
    const variants: VaultTransfer[] = [
      { ...golden, genesisHash: new Uint8Array(32).fill(8) },
      { ...golden, programId: filled(8) },
      { ...golden, vault: filled(8) },
      { ...golden, recipient: filled(8) },
      { ...golden, amount: 6n },
      { ...golden, nonce: 7n },
      { ...golden, expirySlot: 8n },
    ];
    for (const v of variants) expect(ml_dsa65.verify(sig, encodeVaultTransfer(v), publicKey)).toBe(false);
  });

  it("packs key and signature staging under the 1232-byte packet limit", () => {
    const payer = Keypair.generate().publicKey;
    const setup = vaultSetupPlan({
      programId: PQ_VAULT_PROGRAM_ID,
      payer,
      vault: Keypair.generate().publicKey,
      publicKey: new Uint8Array(MLDSA65_PUBLIC_KEY_LEN),
      genesisHash: new Uint8Array(32),
      lamports: 1,
    });
    const transfer = transferPlan({
      programId: PQ_VAULT_PROGRAM_ID,
      relayer: payer,
      buffer: Keypair.generate().publicKey,
      bufferLamports: 1,
      vault: Keypair.generate().publicKey,
      recipient: Keypair.generate().publicKey,
      signature: new Uint8Array(MLDSA65_SIGNATURE_LEN),
      amount: 1n,
      nonce: 0n,
      expirySlot: 1n,
    });
    for (const tx of [...setup, ...transfer]) expect(transactionSize(tx, payer)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(setup.length).toBe(3);
    expect(transfer.length).toBe(4);
  });
});
