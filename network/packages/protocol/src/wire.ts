import { createHash } from "node:crypto";

/** Binary bridge message, wire version 1. Normative: docs/BRIDGE_SPEC.md §3. */

export const DOMAIN = new TextEncoder().encode("lattice-bridge/1");
export const PROTOCOL_VERSION = 1;
export const SCHEME_ED25519 = 1;
export const HEADER_LEN = 196;
export const TRANSFER_LEN = 276;
export const NATIVE_DECIMALS = 9;

export const Kind = {
  Deposit: 1,
  Withdrawal: 2,
  SourceGovernance: 3,
  DestinationGovernance: 4,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export const GovernanceAction = {
  RotateGuardians: 1,
  SetPause: 2,
  SetLimits: 3,
  SetPauser: 4,
} as const;

const U64_MAX = (1n << 64n) - 1n;
const enc = new TextEncoder();

export type Bytes32 = Uint8Array;

export interface Header {
  kind: Kind;
  scheme?: number;
  deploymentId: Bytes32;
  solanaGenesisHash: Bytes32;
  latticeGenesisHash: Bytes32;
  sourceProgramId: Bytes32;
  sourceMint: Bytes32;
  signerEpoch: bigint;
  nonce: bigint;
}

export interface TransferMessage extends Header {
  kind: typeof Kind.Deposit | typeof Kind.Withdrawal;
  sourceAmount: bigint;
  nativeAmount: bigint;
  recipient: Bytes32;
  eventId: Bytes32;
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) throw new RangeError(`u64 out of range: ${value}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function readU64(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}

export function readU128(d: Uint8Array, o: number): bigint {
  return readU64(d, o) | (readU64(d, o + 8) << 64n);
}

function b32(name: string, v: Uint8Array): Uint8Array {
  if (v.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return v;
}

export function deploymentId(label: string): Bytes32 {
  if (!label) throw new Error("deployment label required");
  return sha256(enc.encode("lattice-bridge/1:deployment"), enc.encode(label));
}

export function depositEventId(deployment: Bytes32, sequence: bigint): Bytes32 {
  return sha256(enc.encode("lattice-bridge/1:deposit-event"), b32("deploymentId", deployment), u64le(sequence));
}

export function burnEventId(deployment: Bytes32, sequence: bigint): Bytes32 {
  return sha256(enc.encode("lattice-bridge/1:burn-event"), b32("deploymentId", deployment), u64le(sequence));
}

export function nativeScale(sourceDecimals: number): bigint {
  if (!Number.isInteger(sourceDecimals) || sourceDecimals < 0 || sourceDecimals > NATIVE_DECIMALS) {
    throw new Error("source decimals must be an integer in 0..=9");
  }
  return 10n ** BigInt(NATIVE_DECIMALS - sourceDecimals);
}

export function encodeHeader(h: Header): Uint8Array {
  const out = new Uint8Array(HEADER_LEN);
  out.set(DOMAIN, 0);
  out[16] = h.kind;
  out[17] = PROTOCOL_VERSION;
  out[18] = h.scheme ?? SCHEME_ED25519;
  out[19] = 0;
  out.set(b32("deploymentId", h.deploymentId), 20);
  out.set(b32("solanaGenesisHash", h.solanaGenesisHash), 52);
  out.set(b32("latticeGenesisHash", h.latticeGenesisHash), 84);
  out.set(b32("sourceProgramId", h.sourceProgramId), 116);
  out.set(b32("sourceMint", h.sourceMint), 148);
  out.set(u64le(h.signerEpoch), 180);
  out.set(u64le(h.nonce), 188);
  return out;
}

export function encodeTransfer(m: TransferMessage): Uint8Array {
  if (m.sourceAmount <= 0n || m.nativeAmount <= 0n) throw new Error("amounts must be positive");
  if (b32("recipient", m.recipient).every((b) => b === 0)) throw new Error("zero recipient");
  const out = new Uint8Array(TRANSFER_LEN);
  out.set(encodeHeader(m), 0);
  out.set(u64le(m.sourceAmount), 196);
  out.set(u64le(m.nativeAmount), 204);
  out.set(m.recipient, 212);
  out.set(b32("eventId", m.eventId), 244);
  return out;
}

export function decodeHeader(d: Uint8Array): Header & { protocolVersion: number } {
  if (d.length < HEADER_LEN) throw new Error("message too short");
  if (!DOMAIN.every((b, i) => d[i] === b) || d[19] !== 0) throw new Error("wrong domain");
  return {
    kind: d[16] as Kind,
    protocolVersion: d[17]!,
    scheme: d[18]!,
    deploymentId: d.slice(20, 52),
    solanaGenesisHash: d.slice(52, 84),
    latticeGenesisHash: d.slice(84, 116),
    sourceProgramId: d.slice(116, 148),
    sourceMint: d.slice(148, 180),
    signerEpoch: readU64(d, 180),
    nonce: readU64(d, 188),
  };
}

export function decodeTransfer(d: Uint8Array): TransferMessage {
  if (d.length !== TRANSFER_LEN) throw new Error("transfer message must be 276 bytes");
  const h = decodeHeader(d);
  if (h.kind !== Kind.Deposit && h.kind !== Kind.Withdrawal) throw new Error("not a transfer kind");
  return {
    ...h,
    kind: h.kind,
    sourceAmount: readU64(d, 196),
    nativeAmount: readU64(d, 204),
    recipient: d.slice(212, 244),
    eventId: d.slice(244, 276),
  };
}

export function messageDigest(message: Uint8Array): Uint8Array {
  return sha256(message);
}

/**
 * Checks the semantic rules every verifier applies (spec §3.1), given the
 * scale. Returns a list of violations; empty means valid.
 */
export function transferViolations(m: TransferMessage, scale: bigint): string[] {
  const v: string[] = [];
  if (m.sourceAmount <= 0n || m.nativeAmount <= 0n) v.push("zero amount");
  if (m.sourceAmount * scale !== m.nativeAmount) v.push("amount relation");
  if (m.nativeAmount > U64_MAX) v.push("native overflow");
  const expected =
    m.kind === Kind.Deposit ? depositEventId(m.deploymentId, m.nonce) : burnEventId(m.deploymentId, m.nonce);
  if (!equalBytes(expected, m.eventId)) v.push("event id");
  if (m.recipient.every((b) => b === 0)) v.push("zero recipient");
  return v;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function governance(h: Omit<Header, "kind">, action: number, payload: Uint8Array): Uint8Array {
  const header = encodeHeader({ ...h, kind: Kind.SourceGovernance });
  const out = new Uint8Array(HEADER_LEN + 1 + payload.length);
  out.set(header, 0);
  out[HEADER_LEN] = action;
  out.set(payload, HEADER_LEN + 1);
  return out;
}

export function encodeRotateGuardians(
  h: Omit<Header, "kind">,
  newEpoch: bigint,
  threshold: number,
  keys: Bytes32[],
): Uint8Array {
  const p = new Uint8Array(11 + 32 * keys.length);
  p.set(u64le(newEpoch), 0);
  p[8] = threshold;
  p[9] = keys.length;
  p[10] = SCHEME_ED25519;
  keys.forEach((k, i) => p.set(b32("guardian key", k), 11 + 32 * i));
  return governance(h, GovernanceAction.RotateGuardians, p);
}

export function encodeSetPause(h: Omit<Header, "kind">, deposits: boolean, withdrawals: boolean): Uint8Array {
  return governance(h, GovernanceAction.SetPause, Uint8Array.of(deposits ? 1 : 0, withdrawals ? 1 : 0));
}

export interface Limits {
  depositCap: bigint;
  rateWindowSecs: bigint;
  maxDepositPerWindow: bigint;
  maxWithdrawalPerWindow: bigint;
}

export function encodeSetLimits(h: Omit<Header, "kind">, l: Limits): Uint8Array {
  const p = new Uint8Array(32);
  p.set(u64le(l.depositCap), 0);
  p.set(u64le(l.rateWindowSecs), 8);
  p.set(u64le(l.maxDepositPerWindow), 16);
  p.set(u64le(l.maxWithdrawalPerWindow), 24);
  return governance(h, GovernanceAction.SetLimits, p);
}

export function encodeSetPauser(h: Omit<Header, "kind">, pauser: Bytes32): Uint8Array {
  return governance(h, GovernanceAction.SetPauser, b32("pauser", pauser));
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error("invalid hex");
  return new Uint8Array(Buffer.from(s, "hex"));
}
