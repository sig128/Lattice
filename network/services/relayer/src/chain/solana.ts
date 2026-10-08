import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { decodeTransfer, messageDigest, readU64 } from "@lattice/protocol/wire";
import { InsufficientQuorum, type QuorumReader } from "../rpc/quorum.js";
import {
  decodeConfig,
  decodeConsumed,
  decodeGuardianSet,
  decodeReceipt,
  ed25519MultiIx,
  postSignaturesIx,
  releaseIx,
  vaultAddresses,
  type VaultConfig,
} from "../vault/client.js";
import type { IndexedSignature, Observed, SourceSubmitter, SourceView } from "./types.js";

export class WrongOwner extends Error {}

/** Reads the source vault through a finalized-commitment quorum. */
export class SolanaSource implements SourceView {
  readonly addresses: ReturnType<typeof vaultAddresses>;

  constructor(
    private readonly reader: QuorumReader,
    readonly programId: PublicKey,
  ) {
    this.addresses = vaultAddresses(programId);
  }

  private owned(owner: PublicKey | null) {
    if (owner && !owner.equals(this.programId)) throw new WrongOwner("account not owned by the source-vault program");
  }

  async config(): Promise<Observed<VaultConfig>> {
    const a = await this.reader.getAccount(this.addresses.config, { immutable: false });
    if (!a.exists) throw new InsufficientQuorum("source-vault config not visible at finalized commitment");
    this.owned(a.owner);
    return { value: decodeConfig(a.data!), slot: a.slot };
  }

  async receipt(sequence: bigint) {
    const a = await this.reader.getAccount(this.addresses.receipt(sequence));
    this.owned(a.owner);
    return { value: a.exists ? decodeReceipt(a.data!) : null, slot: a.slot };
  }

  async consumed(nonce: bigint) {
    const a = await this.reader.getAccount(this.addresses.consumed(nonce));
    this.owned(a.owner);
    return { value: a.exists ? decodeConsumed(a.data!) : null, slot: a.slot };
  }

  async guardianSet(epoch: bigint) {
    const a = await this.reader.getAccount(this.addresses.guardianSet(epoch));
    this.owned(a.owner);
    return a.exists ? decodeGuardianSet(a.data!) : null;
  }

  async vaultBalance(vault: PublicKey): Promise<Observed<bigint>> {
    const a = await this.reader.getAccount(vault, { immutable: false });
    if (!a.exists || a.data!.length < 165) throw new Error("vault token account missing");
    return { value: readU64(a.data!, 64), slot: a.slot };
  }
}

/** Submits releases with the relayer's fee-payer key. The fee payer has no authority over funds. */
export class SolanaSubmitter implements SourceSubmitter {
  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey,
    private readonly payer: Keypair,
    private readonly config: () => Promise<VaultConfig>,
    private readonly signaturesPerTx = 5,
  ) {}

  private async send(ixs: TransactionInstruction[]) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
    return sendAndConfirmTransaction(this.connection, tx, [this.payer], { commitment: "confirmed" });
  }

  async release(message: Uint8Array, epoch: bigint, signatures: IndexedSignature[], recipientOwner: PublicKey) {
    const t = decodeTransfer(message);
    // Skip re-posting (and stranding attestation rent) if a release already landed.
    const consumedKey = vaultAddresses(this.programId).consumed(t.nonce);
    const landed = await this.connection.getAccountInfo(consumedKey, "confirmed");
    if (landed?.owner.equals(this.programId)) return `already-consumed:${consumedKey.toBase58()}`;
    const cfg = await this.config();
    const digest = messageDigest(message);
    for (let i = 0; i < signatures.length; i += this.signaturesPerTx) {
      const batch = signatures.slice(i, i + this.signaturesPerTx);
      await this.send([ed25519MultiIx(digest, batch), postSignaturesIx(this.programId, this.payer.publicKey, epoch, digest)]);
    }
    const recipientToken = getAssociatedTokenAddressSync(cfg.mint, recipientOwner, true, cfg.tokenProgram);
    return this.send([
      createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, recipientToken, recipientOwner, cfg.mint, cfg.tokenProgram),
      releaseIx(this.programId, {
        payer: this.payer.publicKey,
        rentRecipient: this.payer.publicKey,
        epoch,
        digest,
        nonce: t.nonce,
        recipientToken,
        mint: cfg.mint,
        tokenProgram: cfg.tokenProgram,
        message,
      }),
    ]);
  }
}
