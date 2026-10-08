import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import {
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { readU128, readU64, u64le } from "@lattice/protocol/wire";

/** Client for programs/source-vault. Layouts: docs/BRIDGE_SPEC.md §6–§7. */

export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const VaultError = {
  NotAuthorizedInitializer: 2,
  WrongAccount: 4,
  UnsupportedTokenProgram: 5,
  InvalidMint: 6,
  FreezeAuthorityPresent: 7,
  DisallowedExtension: 8,
  UnsupportedDecimals: 9,
  InvalidGuardianSet: 10,
  InvalidLimits: 11,
  DepositsPaused: 12,
  WithdrawalsPaused: 13,
  ZeroAmount: 14,
  ZeroRecipient: 15,
  NothingCredited: 16,
  DepositCapExceeded: 17,
  RateLimitExceeded: 18,
  Overflow: 19,
  MissingEd25519Instruction: 20,
  MalformedEd25519Instruction: 21,
  SignatureNotForDigest: 22,
  UnknownGuardian: 23,
  StaleEpoch: 24,
  DigestMismatch: 25,
  BelowThreshold: 26,
  MalformedMessage: 27,
  WrongDomain: 28,
  WrongKind: 29,
  WrongVersion: 30,
  WrongScheme: 31,
  WrongDeployment: 32,
  WrongGenesis: 33,
  WrongProgram: 34,
  WrongMint: 35,
  WrongEventId: 36,
  AmountMismatch: 37,
  WrongRecipient: 38,
  AlreadyConsumed: 39,
  ExceedsLocked: 40,
  WrongGovernanceNonce: 41,
  UnknownGovernanceAction: 42,
  NotPauser: 43,
  AccountAlreadyInitialized: 44,
  WrongRentRecipient: 45,
  NoSignatures: 46,
} as const;

const SEEDS = {
  config: Buffer.from("config"),
  vaultAuthority: Buffer.from("vault-authority"),
  vault: Buffer.from("vault"),
  guardianSet: Buffer.from("guardian-set"),
  attestation: Buffer.from("attestation"),
  deposit: Buffer.from("deposit"),
  withdrawal: Buffer.from("withdrawal"),
};

const pda = (programId: PublicKey, ...seeds: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), programId)[0];

export function vaultAddresses(programId: PublicKey) {
  return {
    config: pda(programId, SEEDS.config),
    vaultAuthority: pda(programId, SEEDS.vaultAuthority),
    vault: pda(programId, SEEDS.vault),
    programData: pda(BPF_LOADER_UPGRADEABLE, programId.toBytes()),
    guardianSet: (epoch: bigint) => pda(programId, SEEDS.guardianSet, u64le(epoch)),
    attestation: (digest: Uint8Array) => pda(programId, SEEDS.attestation, digest),
    receipt: (sequence: bigint) => pda(programId, SEEDS.deposit, u64le(sequence)),
    consumed: (nonce: bigint) => pda(programId, SEEDS.withdrawal, u64le(nonce)),
  };
}

export interface InitializeParams {
  deploymentId: Uint8Array;
  solanaGenesisHash: Uint8Array;
  latticeGenesisHash: Uint8Array;
  pauser: PublicKey | null;
  depositCap: bigint;
  rateWindowSecs: bigint;
  maxDepositPerWindow: bigint;
  maxWithdrawalPerWindow: bigint;
  depositsPaused?: boolean;
  withdrawalsPaused?: boolean;
  threshold: number;
  guardians: Uint8Array[];
}

export function initializeIx(
  programId: PublicKey,
  authority: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  p: InitializeParams,
): TransactionInstruction {
  const a = vaultAddresses(programId);
  const flags = (p.depositsPaused ? 1 : 0) | (p.withdrawalsPaused ? 2 : 0);
  const data = Buffer.concat([
    Buffer.of(0),
    p.deploymentId,
    p.solanaGenesisHash,
    p.latticeGenesisHash,
    p.pauser ? p.pauser.toBuffer() : Buffer.alloc(32),
    u64le(p.depositCap),
    u64le(p.rateWindowSecs),
    u64le(p.maxDepositPerWindow),
    u64le(p.maxWithdrawalPerWindow),
    Buffer.of(flags, p.threshold, p.guardians.length),
    ...p.guardians,
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: a.config, isSigner: false, isWritable: true },
      { pubkey: a.guardianSet(1n), isSigner: false, isWritable: true },
      { pubkey: a.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: a.vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: a.programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function depositIx(
  programId: PublicKey,
  depositor: PublicKey,
  depositorToken: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  sequence: bigint,
  amount: bigint,
  latticeRecipient: Uint8Array,
): TransactionInstruction {
  const a = vaultAddresses(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: a.config, isSigner: false, isWritable: true },
      { pubkey: depositorToken, isSigner: false, isWritable: true },
      { pubkey: a.vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: a.receipt(sequence), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.of(1), u64le(amount), latticeRecipient]),
  });
}

export interface GuardianSignature {
  publicKey: Uint8Array;
  signature: Uint8Array;
}

/** One Ed25519 precompile instruction carrying several signatures over the same 32-byte digest. */
export function ed25519MultiIx(digest: Uint8Array, sigs: GuardianSignature[]): TransactionInstruction {
  if (digest.length !== 32 || sigs.length === 0 || sigs.length > 255) throw new Error("bad ed25519 batch");
  const header = 2 + 14 * sigs.length;
  const msgOffset = header + 96 * sigs.length;
  const data = Buffer.alloc(msgOffset + 32);
  data[0] = sigs.length;
  sigs.forEach((s, i) => {
    const pkOffset = header + 96 * i;
    const sigOffset = pkOffset + 32;
    const o = 2 + 14 * i;
    data.writeUInt16LE(sigOffset, o);
    data.writeUInt16LE(0xffff, o + 2);
    data.writeUInt16LE(pkOffset, o + 4);
    data.writeUInt16LE(0xffff, o + 6);
    data.writeUInt16LE(msgOffset, o + 8);
    data.writeUInt16LE(32, o + 10);
    data.writeUInt16LE(0xffff, o + 12);
    data.set(s.publicKey, pkOffset);
    data.set(s.signature, sigOffset);
  });
  data.set(digest, msgOffset);
  return new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data });
}

export function postSignaturesIx(
  programId: PublicKey,
  payer: PublicKey,
  epoch: bigint,
  digest: Uint8Array,
): TransactionInstruction {
  const a = vaultAddresses(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: a.config, isSigner: false, isWritable: false },
      { pubkey: a.guardianSet(epoch), isSigner: false, isWritable: false },
      { pubkey: a.attestation(digest), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.of(2), digest]),
  });
}

export function releaseIx(
  programId: PublicKey,
  args: {
    payer: PublicKey;
    rentRecipient: PublicKey;
    epoch: bigint;
    digest: Uint8Array;
    nonce: bigint;
    recipientToken: PublicKey;
    mint: PublicKey;
    tokenProgram: PublicKey;
    message: Uint8Array;
  },
): TransactionInstruction {
  const a = vaultAddresses(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: a.config, isSigner: false, isWritable: true },
      { pubkey: a.guardianSet(args.epoch), isSigner: false, isWritable: false },
      { pubkey: a.attestation(args.digest), isSigner: false, isWritable: true },
      { pubkey: args.rentRecipient, isSigner: false, isWritable: true },
      { pubkey: a.consumed(args.nonce), isSigner: false, isWritable: true },
      { pubkey: a.vault, isSigner: false, isWritable: true },
      { pubkey: a.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: args.recipientToken, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.of(3), args.message]),
  });
}

export function governIx(
  programId: PublicKey,
  args: {
    payer: PublicKey;
    rentRecipient: PublicKey;
    epoch: bigint;
    digest: Uint8Array;
    message: Uint8Array;
    newGuardianSet?: PublicKey;
  },
): TransactionInstruction {
  const a = vaultAddresses(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: a.config, isSigner: false, isWritable: true },
      { pubkey: a.guardianSet(args.epoch), isSigner: false, isWritable: false },
      { pubkey: a.attestation(args.digest), isSigner: false, isWritable: true },
      { pubkey: args.rentRecipient, isSigner: false, isWritable: true },
      { pubkey: args.newGuardianSet ?? SystemProgram.programId, isSigner: false, isWritable: !!args.newGuardianSet },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.of(4), args.message]),
  });
}

export function pauseIx(programId: PublicKey, pauser: PublicKey, deposits: boolean, withdrawals: boolean) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: pauser, isSigner: true, isWritable: false },
      { pubkey: vaultAddresses(programId).config, isSigner: false, isWritable: true },
    ],
    data: Buffer.of(5, deposits ? 1 : 0, withdrawals ? 1 : 0),
  });
}

// ---------------------------------------------------------------- decoders

const magic = (d: Uint8Array, m: string) => Buffer.from(d.subarray(0, 8)).toString("latin1") === m;
const key = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));

export interface VaultConfig {
  decimals: number;
  depositsPaused: boolean;
  withdrawalsPaused: boolean;
  deploymentId: Uint8Array;
  solanaGenesisHash: Uint8Array;
  latticeGenesisHash: Uint8Array;
  mint: PublicKey;
  tokenProgram: PublicKey;
  vault: PublicKey;
  pauser: PublicKey | null;
  epoch: bigint;
  nextDepositSequence: bigint;
  governanceSequence: bigint;
  totalDeposited: bigint;
  totalReleased: bigint;
  depositCap: bigint;
  rateWindowSecs: bigint;
  maxDepositPerWindow: bigint;
  maxWithdrawalPerWindow: bigint;
  releasedCount: bigint;
}

export function decodeConfig(d: Uint8Array): VaultConfig {
  if (d.length !== 392 || !magic(d, "LBSCFG01") || d[8] !== 1) throw new Error("not a source-vault config");
  const pauser = d.subarray(208, 240);
  return {
    decimals: d[12]!,
    depositsPaused: (d[13]! & 1) !== 0,
    withdrawalsPaused: (d[13]! & 2) !== 0,
    deploymentId: d.slice(16, 48),
    solanaGenesisHash: d.slice(48, 80),
    latticeGenesisHash: d.slice(80, 112),
    mint: key(d, 112),
    tokenProgram: key(d, 144),
    vault: key(d, 176),
    pauser: pauser.every((b) => b === 0) ? null : new PublicKey(pauser),
    epoch: readU64(d, 240),
    nextDepositSequence: readU64(d, 248),
    governanceSequence: readU64(d, 256),
    totalDeposited: readU128(d, 264),
    totalReleased: readU128(d, 280),
    depositCap: readU64(d, 296),
    rateWindowSecs: readU64(d, 304),
    maxDepositPerWindow: readU64(d, 312),
    maxWithdrawalPerWindow: readU64(d, 320),
    releasedCount: readU64(d, 352),
  };
}

export interface DepositReceipt {
  sequence: bigint;
  eventId: Uint8Array;
  depositor: PublicKey;
  depositorToken: PublicKey;
  latticeRecipient: Uint8Array;
  requested: bigint;
  credited: bigint;
  native: bigint;
  slot: bigint;
  timestamp: bigint;
  deploymentId: Uint8Array;
}

export function decodeReceipt(d: Uint8Array): DepositReceipt {
  if (d.length !== 224 || !magic(d, "LBSDEPO1") || d[8] !== 1) throw new Error("not a deposit receipt");
  return {
    sequence: readU64(d, 16),
    eventId: d.slice(24, 56),
    depositor: key(d, 56),
    depositorToken: key(d, 88),
    latticeRecipient: d.slice(120, 152),
    requested: readU64(d, 152),
    credited: readU64(d, 160),
    native: readU64(d, 168),
    slot: readU64(d, 176),
    timestamp: readU64(d, 184),
    deploymentId: d.slice(192, 224),
  };
}

export interface ConsumedWithdrawal {
  nonce: bigint;
  eventId: Uint8Array;
  recipient: PublicKey;
  recipientToken: PublicKey;
  amount: bigint;
  slot: bigint;
  digest: Uint8Array;
}

export function decodeConsumed(d: Uint8Array): ConsumedWithdrawal {
  if (d.length !== 176 || !magic(d, "LBSWDRL1")) throw new Error("not a consumed-withdrawal record");
  return {
    nonce: readU64(d, 16),
    eventId: d.slice(24, 56),
    recipient: key(d, 56),
    recipientToken: key(d, 88),
    amount: readU64(d, 120),
    slot: readU64(d, 128),
    digest: d.slice(144, 176),
  };
}

export interface GuardianSetAccount {
  scheme: number;
  threshold: number;
  epoch: bigint;
  keys: Uint8Array[];
}

export function decodeGuardianSet(d: Uint8Array): GuardianSetAccount {
  if (d.length !== 648 || !magic(d, "LBSGSET1")) throw new Error("not a guardian set");
  const count = d[12]!;
  return {
    scheme: d[10]!,
    threshold: d[11]!,
    epoch: readU64(d, 16),
    keys: Array.from({ length: count }, (_, i) => d.slice(40 + 32 * i, 72 + 32 * i)),
  };
}

export function decodeAttestationBitmap(d: Uint8Array): { bitmap: number; epoch: bigint } {
  if (d.length !== 88 || !magic(d, "LBSATST1")) throw new Error("not an attestation");
  return { bitmap: new DataView(d.buffer, d.byteOffset).getUint32(12, true), epoch: readU64(d, 16) };
}

// ----------------------------------------------------------- ed25519 keys

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface Ed25519Key {
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

/** Accepts a 32-byte seed or a 64-byte Solana keypair (seed ‖ public key). */
export function ed25519FromSecret(secret: Uint8Array): Ed25519Key {
  if (secret.length !== 32 && secret.length !== 64) throw new Error("ed25519 secret must be 32 or 64 bytes");
  const seed = secret.subarray(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(spki.subarray(spki.length - 32));
  if (secret.length === 64 && !Buffer.from(secret.subarray(32)).equals(Buffer.from(publicKey))) {
    throw new Error("keypair public half does not match its seed");
  }
  return { publicKey, privateKey };
}

export function ed25519Sign(key: Ed25519Key, message: Uint8Array): Uint8Array {
  return new Uint8Array(nodeSign(null, message, key.privateKey));
}

export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]);
  return nodeVerify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
}
