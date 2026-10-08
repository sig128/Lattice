// Client for the pq-vault SBF program on the Lattice PQ fork. The ML-DSA-65
// signature is checked on-chain by the fork's `sol_mldsa65_verify` syscall;
// this module only builds messages, instructions and transactions.
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  type Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const PQ_VAULT_PROGRAM_ID = new PublicKey("FQn1rtLkx2wTqXQK4Ur96HATPdQhHeFyA5v2F1NSChBn");
export const MLDSA65_PUBLIC_KEY_LEN = 1952;
export const MLDSA65_SIGNATURE_LEN = 3309;
export const VAULT_LEN = 2048;
export const BUFFER_LEN = 3392;
export const MESSAGE_DOMAIN = "lattice-pq-vault-transfer";
export const MESSAGE_VERSION = 1;
export const ALGORITHM_MLDSA65_V1 = 1;
export const PACKET_DATA_SIZE = 1232;

export const VAULT_ERRORS: Record<number, string> = {
  1: "InvalidInstruction",
  2: "InvalidAccount",
  3: "MissingSignature",
  4: "AlreadyInitialized",
  5: "NotLoading",
  6: "NotSealed",
  7: "OutOfOrderWrite",
  8: "KeyIncomplete",
  9: "SignatureIncomplete",
  10: "BufferMismatch",
  11: "Expired",
  12: "NonceMismatch",
  13: "InsufficientFunds",
  14: "InvalidAmount",
  15: "UnsupportedAlgorithm",
  0x101: "SignatureRejected(InvalidSignature)",
  0x102: "SignatureRejected(InvalidPublicKey)",
  0x103: "SignatureRejected(UnsupportedVersion)",
  0x104: "SignatureRejected(MessageTooLong)",
};

export interface VaultTransfer {
  genesisHash: Uint8Array;
  programId: PublicKey;
  vault: PublicKey;
  recipient: PublicKey;
  amount: bigint;
  nonce: bigint;
  expirySlot: bigint;
}

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const u16 = (v: number) => Uint8Array.of(v & 0xff, v >> 8);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Byte-identical to `transfer_message` in chain/programs/pq-vault/src/state.rs. */
export function encodeVaultTransfer(t: VaultTransfer): Uint8Array {
  if (t.genesisHash.length !== 32) throw new Error("genesis hash must be 32 bytes");
  const domain = new TextEncoder().encode(MESSAGE_DOMAIN);
  return concat(
    Uint8Array.of(domain.length),
    domain,
    Uint8Array.of(MESSAGE_VERSION, ALGORITHM_MLDSA65_V1),
    t.genesisHash,
    t.programId.toBytes(),
    t.vault.toBytes(),
    t.recipient.toBytes(),
    u64(t.amount),
    u64(t.nonce),
    u64(t.expirySlot),
  );
}

export function signVaultTransfer(secretKey: Uint8Array, t: VaultTransfer): Uint8Array {
  return ml_dsa65.sign(encodeVaultTransfer(t), secretKey);
}

const ix = (programId: PublicKey, keys: TransactionInstruction["keys"], data: Uint8Array) =>
  new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

export const instructions = {
  initVault: (p: PublicKey, vault: PublicKey, authority: PublicKey, genesisHash: Uint8Array) =>
    ix(p, [w(vault, true), r(authority, true)], concat(Uint8Array.of(0), genesisHash)),
  writeVaultKey: (p: PublicKey, vault: PublicKey, authority: PublicKey, offset: number, bytes: Uint8Array) =>
    ix(p, [w(vault), r(authority, true)], concat(Uint8Array.of(1), u16(offset), bytes)),
  sealVault: (p: PublicKey, vault: PublicKey, authority: PublicKey) =>
    ix(p, [w(vault), r(authority, true)], Uint8Array.of(2)),
  initSigBuffer: (p: PublicKey, buffer: PublicKey, relayer: PublicKey, vault: PublicKey) =>
    ix(p, [w(buffer, true), r(relayer, true), r(vault)], Uint8Array.of(3)),
  writeSig: (p: PublicKey, buffer: PublicKey, relayer: PublicKey, offset: number, bytes: Uint8Array) =>
    ix(p, [w(buffer), r(relayer, true)], concat(Uint8Array.of(4), u16(offset), bytes)),
  execute: (
    p: PublicKey,
    a: { vault: PublicKey; buffer: PublicKey; recipient: PublicKey; relayer: PublicKey },
    amount: bigint,
    nonce: bigint,
    expirySlot: bigint,
  ) =>
    ix(
      p,
      [w(a.vault), w(a.buffer), w(a.recipient), w(a.relayer, true)],
      concat(Uint8Array.of(5), u64(amount), u64(nonce), u64(expirySlot)),
    ),
  closeSigBuffer: (p: PublicKey, buffer: PublicKey, relayer: PublicKey) =>
    ix(p, [w(buffer), w(relayer, true)], Uint8Array.of(6)),
};

const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

/** Wire size of a legacy transaction (signatures + message). */
export function transactionSize(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const tx = new Transaction({ feePayer, recentBlockhash: DUMMY_BLOCKHASH }).add(...ixs);
  const message = tx.compileMessage();
  const sigs = message.header.numRequiredSignatures;
  try {
    return 1 + 64 * sigs + message.serialize().length;
  } catch {
    // web3.js refuses to serialize messages larger than PACKET_DATA_SIZE.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Split `data` into sequential write instructions packed into as few
 * transactions as possible. `prefix` instructions ride in the first
 * transaction, `suffix` instructions in the last.
 */
export function packWrites(
  data: Uint8Array,
  feePayer: PublicKey,
  write: (offset: number, bytes: Uint8Array) => TransactionInstruction,
  prefix: TransactionInstruction[] = [],
  suffix: TransactionInstruction[] = [],
): TransactionInstruction[][] {
  const txs: TransactionInstruction[][] = [];
  let offset = 0;
  let head = prefix;
  while (offset < data.length) {
    const fits = (n: number, extra: TransactionInstruction[]) =>
      transactionSize([...head, write(offset, data.subarray(offset, offset + n)), ...extra], feePayer) <=
      PACKET_DATA_SIZE;
    let lo = 0;
    let hi = data.length - offset;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid, [])) lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) throw new Error("instruction prefix leaves no room for data");
    const last = offset + lo >= data.length;
    if (last && suffix.length && !fits(lo, suffix)) {
      // Keep the suffix in its own final transaction.
      txs.push([...head, write(offset, data.subarray(offset, offset + lo))]);
      txs.push([...suffix]);
      return txs;
    }
    txs.push([...head, write(offset, data.subarray(offset, offset + lo)), ...(last ? suffix : [])]);
    offset += lo;
    head = [];
  }
  return txs;
}

export function vaultSetupPlan(args: {
  programId: PublicKey;
  payer: PublicKey;
  vault: PublicKey;
  publicKey: Uint8Array;
  genesisHash: Uint8Array;
  lamports: number;
}): TransactionInstruction[][] {
  if (args.publicKey.length !== MLDSA65_PUBLIC_KEY_LEN) throw new Error("bad ML-DSA-65 public key length");
  const { programId: p, payer, vault } = args;
  return packWrites(
    args.publicKey,
    payer,
    (offset, bytes) => instructions.writeVaultKey(p, vault, payer, offset, bytes),
    [
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: vault,
        lamports: args.lamports,
        space: VAULT_LEN,
        programId: p,
      }),
      instructions.initVault(p, vault, payer, args.genesisHash),
    ],
    [instructions.sealVault(p, vault, payer)],
  );
}

export function transferPlan(args: {
  programId: PublicKey;
  relayer: PublicKey;
  buffer: PublicKey;
  bufferLamports: number;
  vault: PublicKey;
  recipient: PublicKey;
  signature: Uint8Array;
  amount: bigint;
  nonce: bigint;
  expirySlot: bigint;
}): TransactionInstruction[][] {
  if (args.signature.length !== MLDSA65_SIGNATURE_LEN) throw new Error("bad ML-DSA-65 signature length");
  const { programId: p, relayer, buffer, vault } = args;
  return packWrites(
    args.signature,
    relayer,
    (offset, bytes) => instructions.writeSig(p, buffer, relayer, offset, bytes),
    [
      SystemProgram.createAccount({
        fromPubkey: relayer,
        newAccountPubkey: buffer,
        lamports: args.bufferLamports,
        space: BUFFER_LEN,
        programId: p,
      }),
      instructions.initSigBuffer(p, buffer, relayer, vault),
    ],
    [
      instructions.execute(
        p,
        { vault, buffer, recipient: args.recipient, relayer },
        args.amount,
        args.nonce,
        args.expirySlot,
      ),
    ],
  );
}

export interface SentTransaction {
  signature: string;
  sizeBytes: number;
  err: unknown;
  computeUnits: number | null;
  logs: string[];
}

export async function sendPlan(
  connection: Connection,
  plan: TransactionInstruction[][],
  payer: Keypair,
  signersFor: (index: number) => Keypair[],
): Promise<SentTransaction[]> {
  const sent: SentTransaction[] = [];
  for (const [i, ixs] of plan.entries()) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(payer, ...signersFor(i));
    const raw = tx.serialize();
    // skipPreflight so rejected transactions land on-chain and the runtime,
    // not RPC simulation, produces the error.
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true });
    const status = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    const info = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    sent.push({
      signature,
      sizeBytes: raw.length,
      err: status.value.err,
      computeUnits: info?.meta?.computeUnitsConsumed ?? null,
      logs: info?.meta?.logMessages ?? [],
    });
    if (status.value.err) break;
  }
  return sent;
}

/** Extract the custom program error code from a transaction error, if any. */
export function customErrorCode(err: unknown): number | null {
  const e = err as { InstructionError?: [number, { Custom?: number } | string] } | null;
  const inner = e?.InstructionError?.[1];
  return typeof inner === "object" && inner && typeof inner.Custom === "number" ? inner.Custom : null;
}
