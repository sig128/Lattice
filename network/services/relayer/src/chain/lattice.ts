import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readU128, readU64, u64le } from "@lattice/protocol/wire";
import { InsufficientQuorum, type QuorumReader } from "../rpc/quorum.js";
import {
  Scheme,
  type BurnReceipt,
  type GuardianSetView,
  type IndexedSignature,
  type LatticeState,
  type LatticeSubmitter,
  type LatticeView,
  type MintRecord,
  type Observed,
} from "./types.js";

/**
 * Adapter for the `lattice-bridge` builtin as documented in
 * docs/NATIVE_ISSUANCE.md §3–§6 (state/mint/burn layouts are BRIDGE_SPEC §9.3).
 * Not yet exercised against a running fork validator.
 */

export const LATTICE_BRIDGE_PROGRAM_ID = new PublicKey("Geuc2RbbzoWXSNYRyVDcjM5fZx6raKgf45y1bQr6aSzN");

export const LatTag = {
  InitAttestation: 0,
  WriteAttestation: 1,
  VerifyAttestation: 2,
  CloseAttestation: 3,
  MintFromDeposit: 4,
  BurnForWithdrawal: 5,
  Govern: 6,
  Pause: 7,
} as const;

export const ED25519_KEY = 32;
export const MLDSA65_KEY = 1952;
export const ED25519_SIG = 64;
export const MLDSA65_SIG = 3309;
const GUARDIAN_SET_HEADER = 64;
const ATTESTATION_HEADER = 96;

const hasEd = (scheme: number) => scheme === Scheme.Ed25519 || scheme === Scheme.Hybrid;
const hasMl = (scheme: number) => scheme === Scheme.MlDsa65 || scheme === Scheme.Hybrid;

function checkScheme(scheme: number) {
  if (scheme !== Scheme.Ed25519 && scheme !== Scheme.MlDsa65 && scheme !== Scheme.Hybrid) {
    throw new Error(`unknown signature scheme ${scheme}`);
  }
}

export const keyEntryLen = (scheme: number) => (hasEd(scheme) ? ED25519_KEY : 0) + (hasMl(scheme) ? MLDSA65_KEY : 0);
export const signatureEntryLen = (scheme: number) => 1 + (hasEd(scheme) ? ED25519_SIG : 0) + (hasMl(scheme) ? MLDSA65_SIG : 0);
export const attestationSize = (scheme: number, messageLen: number, count: number) =>
  ATTESTATION_HEADER + messageLen + count * signatureEntryLen(scheme);

const magic = (d: Uint8Array, m: string) => Buffer.from(d.subarray(0, 8)).toString("latin1") === m;

export function decodeLatticeState(d: Uint8Array): LatticeState {
  if (d.length < 98 || !magic(d, "LATSTAT1") || d[8] !== 1) throw new Error("not a Lattice bridge state");
  return {
    deploymentId: d.slice(9, 41),
    nextBurnSequence: readU64(d, 41),
    mintedCount: readU64(d, 49),
    totalMintedNative: readU128(d, 57),
    totalBurnedNative: readU128(d, 73),
    guardianEpoch: readU64(d, 89),
    flags: d[97]!,
  };
}

export function decodeBurnReceipt(d: Uint8Array): BurnReceipt {
  if (d.length < 169 || !magic(d, "LATBURN1") || d[8] !== 1) throw new Error("not a Lattice burn receipt");
  return {
    deploymentId: d.slice(9, 41),
    burnSequence: readU64(d, 41),
    burner: d.slice(49, 81),
    nativeAmount: readU64(d, 81),
    sourceAmount: readU64(d, 89),
    solanaRecipient: d.slice(97, 129),
    slot: readU64(d, 129),
    eventId: d.slice(137, 169),
  };
}

export function decodeLatticeGuardianSet(d: Uint8Array, deploymentId: Uint8Array): GuardianSetView {
  if (d.length < GUARDIAN_SET_HEADER || !magic(d, "LATGSET1") || d[8] !== 1) throw new Error("not a Lattice guardian set");
  const scheme = d[9]!;
  checkScheme(scheme);
  const threshold = d[10]!;
  const count = d[11]!;
  if (!Buffer.from(d.subarray(32, 64)).equals(Buffer.from(deploymentId))) throw new Error("guardian set deployment mismatch");
  const entry = keyEntryLen(scheme);
  if (count === 0 || d.length < GUARDIAN_SET_HEADER + count * entry) throw new Error("truncated Lattice guardian set");
  const keys: Uint8Array[] = [];
  const mldsaKeys: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    let o = GUARDIAN_SET_HEADER + i * entry;
    if (hasEd(scheme)) {
      keys.push(d.slice(o, o + ED25519_KEY));
      o += ED25519_KEY;
    }
    if (hasMl(scheme)) mldsaKeys.push(d.slice(o, o + MLDSA65_KEY));
  }
  return { epoch: readU64(d, 16), threshold, keys, scheme, ...(hasMl(scheme) ? { mldsaKeys } : {}) };
}

/** Signature entry: `index u8 ‖ [ed25519 64] ‖ [ml-dsa-65 3309]`, parts present per scheme. */
export function encodeSignatureEntry(scheme: number, s: IndexedSignature): Buffer {
  const parts: Buffer[] = [Buffer.of(s.index)];
  if (hasEd(scheme)) {
    if (s.signature.length !== ED25519_SIG) throw new Error(`guardian ${s.index}: missing Ed25519 signature`);
    parts.push(Buffer.from(s.signature));
  }
  if (hasMl(scheme)) {
    if (s.mldsaSignature?.length !== MLDSA65_SIG) throw new Error(`guardian ${s.index}: missing ML-DSA-65 signature`);
    parts.push(Buffer.from(s.mldsaSignature));
  }
  return Buffer.concat(parts);
}

export const latIx = {
  initAttestation(programId: PublicKey, writer: PublicKey, attestation: PublicKey, scheme: number, count: number, messageLen: number) {
    const data = Buffer.alloc(7);
    data[0] = LatTag.InitAttestation;
    data[1] = scheme;
    data[2] = count;
    data.writeUInt32LE(messageLen, 3);
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: writer, isSigner: true, isWritable: false },
        { pubkey: attestation, isSigner: false, isWritable: true },
      ],
      data,
    });
  },
  writeAttestation(programId: PublicKey, writer: PublicKey, attestation: PublicKey, offset: number, bytes: Uint8Array) {
    const data = Buffer.alloc(5 + bytes.length);
    data[0] = LatTag.WriteAttestation;
    data.writeUInt32LE(offset, 1);
    data.set(bytes, 5);
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: writer, isSigner: true, isWritable: false },
        { pubkey: attestation, isSigner: false, isWritable: true },
      ],
      data,
    });
  },
  verifyAttestation(programId: PublicKey, attestation: PublicKey, state: PublicKey, guardianSet: PublicKey, first: number, count: number) {
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: attestation, isSigner: false, isWritable: true },
        { pubkey: state, isSigner: false, isWritable: false },
        { pubkey: guardianSet, isSigner: false, isWritable: false },
      ],
      data: Buffer.of(LatTag.VerifyAttestation, first, count),
    });
  },
  closeAttestation(programId: PublicKey, writer: PublicKey, attestation: PublicKey) {
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: writer, isSigner: true, isWritable: true },
        { pubkey: attestation, isSigner: false, isWritable: true },
      ],
      data: Buffer.of(LatTag.CloseAttestation),
    });
  },
  mintFromDeposit(
    programId: PublicKey,
    payer: PublicKey,
    state: PublicKey,
    guardianSet: PublicKey,
    attestation: PublicKey,
    mintRecord: PublicKey,
    recipient: PublicKey,
  ) {
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: guardianSet, isSigner: false, isWritable: false },
        { pubkey: attestation, isSigner: false, isWritable: true },
        { pubkey: mintRecord, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.of(LatTag.MintFromDeposit),
    });
  },
  burnForWithdrawal(programId: PublicKey, burner: PublicKey, state: PublicKey, burnReceipt: PublicKey, nativeAmount: bigint, solanaRecipient: Uint8Array) {
    if (solanaRecipient.length !== 32) throw new Error("solana recipient must be 32 bytes");
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: burner, isSigner: true, isWritable: true },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: burnReceipt, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.of(LatTag.BurnForWithdrawal), u64le(nativeAmount), Buffer.from(solanaRecipient)]),
    });
  },
};

/** Bytes per WriteAttestation; keeps each transaction under the 1,232-byte packet limit. */
const WRITE_CHUNK = 880;
const CU_BASE = 1_500;
const CU_ED25519 = 12_000;
const CU_MLDSA65 = 30_001;
const CU_PER_TX = 1_200_000;

export interface StagedTx {
  label: string;
  instructions: TransactionInstruction[];
  /** Extra signers besides the payer. */
  signers: Keypair[];
}

/**
 * Transactions that mint one DEPOSIT through a fresh attestation account, in
 * submission order. Pure, so the layout can be tested without a validator.
 */
export function buildStagedMint(args: {
  programId: PublicKey;
  payer: PublicKey;
  attestation: Keypair;
  attestationRent: number;
  deploymentId: Uint8Array;
  scheme: number;
  message: Uint8Array;
  signatures: IndexedSignature[];
}): StagedTx[] {
  const { programId, payer, attestation, scheme, message, signatures } = args;
  checkScheme(scheme);
  if (message[18] !== scheme) throw new Error("message scheme does not match the Lattice guardian set");
  if (signatures.length === 0 || signatures.length > 32) throw new Error("signature count out of range");
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds.map((x) => Buffer.from(x)), programId)[0];
  const state = pda(Buffer.from("state"), args.deploymentId);
  const epoch = message.subarray(180, 188);
  const nonce = message.subarray(188, 196);
  const guardianSet = pda(Buffer.from("guardian-set"), args.deploymentId, epoch);
  const mintRecord = pda(Buffer.from("minted"), args.deploymentId, nonce);
  const recipient = new PublicKey(message.subarray(212, 244));
  const att = attestation.publicKey;
  const size = attestationSize(scheme, message.length, signatures.length);

  const body = Buffer.concat([Buffer.from(message), ...signatures.map((s) => encodeSignatureEntry(scheme, s))]);
  const txs: StagedTx[] = [
    {
      label: "init",
      instructions: [
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: att, lamports: args.attestationRent, space: size, programId }),
        latIx.initAttestation(programId, payer, att, scheme, signatures.length, message.length),
      ],
      signers: [attestation],
    },
  ];
  for (let off = 0; off < body.length; off += WRITE_CHUNK) {
    txs.push({
      label: `write@${off}`,
      instructions: [latIx.writeAttestation(programId, payer, att, off, body.subarray(off, off + WRITE_CHUNK))],
      signers: [],
    });
  }
  const perSig = (hasEd(scheme) ? CU_ED25519 : 0) + (hasMl(scheme) ? CU_MLDSA65 : 0);
  const batch = Math.max(1, Math.floor((CU_PER_TX - 50_000) / perSig));
  for (let first = 0; first < signatures.length; first += batch) {
    const count = Math.min(batch, signatures.length - first);
    txs.push({
      label: `verify@${first}`,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_BASE + 1_000 + count * perSig + 20_000 }),
        latIx.verifyAttestation(programId, att, state, guardianSet, first, count),
      ],
      signers: [],
    });
  }
  txs.push({
    label: "mint",
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      latIx.mintFromDeposit(programId, payer, state, guardianSet, att, mintRecord, recipient),
    ],
    signers: [],
  });
  return txs;
}

export function decodeMintRecord(d: Uint8Array): MintRecord {
  if (d.length < 129 || !magic(d, "LATMINT1") || d[8] !== 1) throw new Error("not a Lattice mint record");
  return {
    deploymentId: d.slice(9, 41),
    depositSequence: readU64(d, 41),
    recipient: d.slice(49, 81),
    nativeAmount: readU64(d, 81),
    slot: readU64(d, 89),
    eventId: d.slice(97, 129),
  };
}

export class SpecLatticeAdapter implements LatticeView, LatticeSubmitter {
  constructor(
    private readonly reader: QuorumReader,
    private readonly programId: PublicKey,
    private readonly deploymentId: Uint8Array,
    private readonly submit?: { connection: Connection; payer: Keypair },
  ) {}

  private pda(...seeds: Uint8Array[]) {
    return PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), this.programId)[0];
  }

  private async owned(address: PublicKey, immutable: boolean) {
    const a = await this.reader.getAccount(address, { immutable });
    if (a.owner && !a.owner.equals(this.programId)) throw new Error("Lattice account has an unexpected owner");
    return a;
  }

  async state(): Promise<Observed<LatticeState>> {
    const a = await this.owned(this.pda(Buffer.from("state"), this.deploymentId), false);
    if (!a.exists) throw new InsufficientQuorum("Lattice bridge state not visible at finalized commitment");
    return { value: decodeLatticeState(a.data!), slot: a.slot };
  }

  async burn(sequence: bigint) {
    const a = await this.owned(this.pda(Buffer.from("burn"), this.deploymentId, u64le(sequence)), true);
    return { value: a.exists ? decodeBurnReceipt(a.data!) : null, slot: a.slot };
  }

  async mintRecord(sequence: bigint) {
    const a = await this.owned(this.pda(Buffer.from("minted"), this.deploymentId, u64le(sequence)), true);
    return { value: a.exists ? decodeMintRecord(a.data!) : null, slot: a.slot };
  }

  async guardianSet(epoch: bigint) {
    const a = await this.owned(this.pda(Buffer.from("guardian-set"), this.deploymentId, u64le(epoch)), true);
    if (!a.exists) return null;
    const gs = decodeLatticeGuardianSet(a.data!, this.deploymentId);
    if (gs.epoch !== epoch) throw new Error("guardian set epoch mismatch");
    return gs;
  }

  /**
   * Staged mint (NATIVE_ISSUANCE §3). Each retry uses a fresh attestation
   * account; the mint record PDA makes MintFromDeposit succeed at most once.
   * On failure the attestation is closed best-effort to recover its rent.
   */
  async mint(message: Uint8Array, signatures: IndexedSignature[]): Promise<string> {
    if (!this.submit) throw new Error("Lattice submission not configured");
    const { connection, payer } = this.submit;
    const scheme = message[18]!;
    const attestation = Keypair.generate();
    const rent = await connection.getMinimumBalanceForRentExemption(attestationSize(scheme, message.length, signatures.length));
    const txs = buildStagedMint({
      programId: this.programId,
      payer: payer.publicKey,
      attestation,
      attestationRent: rent,
      deploymentId: this.deploymentId,
      scheme,
      message,
      signatures,
    });
    let created = false;
    try {
      let last = "";
      for (const t of txs) {
        last = await sendAndConfirmTransaction(connection, new Transaction().add(...t.instructions), [payer, ...t.signers], {
          commitment: "confirmed",
        });
        if (t.label === "init") created = true;
      }
      return last;
    } catch (e) {
      if (created) {
        await sendAndConfirmTransaction(
          connection,
          new Transaction().add(latIx.closeAttestation(this.programId, payer.publicKey, attestation.publicKey)),
          [payer],
          { commitment: "confirmed" },
        ).catch(() => undefined);
      }
      throw e;
    }
  }
}
