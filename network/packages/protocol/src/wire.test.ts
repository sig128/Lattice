import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Kind,
  burnEventId,
  decodeTransfer,
  depositEventId,
  deploymentId,
  encodeRotateGuardians,
  encodeSetPause,
  encodeTransfer,
  messageDigest,
  nativeScale,
  toHex,
  transferViolations,
  type TransferMessage,
} from "./wire.js";

const fill = (v: number) => new Uint8Array(32).fill(v);
const DEPLOYMENT = deploymentId("lattice-test-vector-1");

/** Same inputs as `vector()` in programs/source-vault/src/tests.rs. */
export const VECTOR: TransferMessage = {
  kind: Kind.Withdrawal,
  deploymentId: DEPLOYMENT,
  solanaGenesisHash: fill(1),
  latticeGenesisHash: fill(2),
  sourceProgramId: fill(3),
  sourceMint: fill(4),
  signerEpoch: 7n,
  nonce: 42n,
  sourceAmount: 1_500_000n,
  nativeAmount: 1_500_000_000n,
  recipient: fill(5),
  eventId: burnEventId(DEPLOYMENT, 42n),
};

const vectorDir = new URL("../../../programs/source-vault/tests/", import.meta.url);

describe("wire v1", () => {
  it("matches the Rust program's test vector", () => {
    const bytes = encodeTransfer(VECTOR);
    expect(bytes.length).toBe(276);
    expect(toHex(DEPLOYMENT)).toBe(readFileSync(new URL("vector-deployment-id.txt", vectorDir), "utf8").trim());
    expect(toHex(messageDigest(bytes))).toBe(readFileSync(new URL("vector-digest.txt", vectorDir), "utf8").trim());
  });

  it("round-trips", () => {
    const decoded = decodeTransfer(encodeTransfer(VECTOR));
    expect(toHex(encodeTransfer(decoded))).toBe(toHex(encodeTransfer(VECTOR)));
    expect(decoded.nonce).toBe(42n);
  });

  it("flags semantic violations", () => {
    const scale = nativeScale(6);
    expect(transferViolations(VECTOR, scale)).toEqual([]);
    expect(transferViolations({ ...VECTOR, nativeAmount: 1_500_000_001n }, scale)).toContain("amount relation");
    expect(transferViolations({ ...VECTOR, nonce: 43n }, scale)).toContain("event id");
    expect(transferViolations({ ...VECTOR, kind: Kind.Deposit }, scale)).toContain("event id");
  });

  it("separates directions, deployments and sequences", () => {
    expect(toHex(depositEventId(DEPLOYMENT, 0n))).not.toBe(toHex(burnEventId(DEPLOYMENT, 0n)));
    expect(toHex(depositEventId(DEPLOYMENT, 0n))).not.toBe(toHex(depositEventId(DEPLOYMENT, 1n)));
    expect(toHex(depositEventId(deploymentId("other"), 0n))).not.toBe(toHex(depositEventId(DEPLOYMENT, 0n)));
  });

  it("encodes governance with exact lengths", () => {
    const { kind: _k, ...h } = VECTOR;
    expect(encodeSetPause(h, true, false).length).toBe(199);
    expect(encodeRotateGuardians(h, 8n, 2, [fill(9), fill(10), fill(11)]).length).toBe(208 + 96);
  });

  it("rejects out-of-range amounts and bad decimals", () => {
    expect(() => encodeTransfer({ ...VECTOR, sourceAmount: 0n })).toThrow();
    expect(() => encodeTransfer({ ...VECTOR, nativeAmount: 1n << 64n })).toThrow();
    expect(() => nativeScale(10)).toThrow();
    expect(nativeScale(6)).toBe(1000n);
  });
});
