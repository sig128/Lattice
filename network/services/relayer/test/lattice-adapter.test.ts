import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { decodeTransfer, fromHex, messageDigest, toHex, u64le } from "@lattice/protocol/wire";
import { NotAGuardian } from "../src/attester/core.js";
import { SigningJournal } from "../src/attester/journal.js";
import { Attester } from "../src/attester/core.js";
import {
  LATTICE_BRIDGE_PROGRAM_ID,
  LatTag,
  attestationSize,
  buildStagedMint,
  decodeLatticeGuardianSet,
  encodeSignatureEntry,
  keyEntryLen,
  signatureEntryLen,
} from "../src/chain/lattice.js";
import { DestinationRejected } from "../src/chain/lattice-reference.js";
import { Scheme, type IndexedSignature } from "../src/chain/types.js";
import { collectSignatures } from "../src/guardians.js";
import { silentLogger } from "../src/log.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { world } from "./helpers/fixtures.js";

const deployment = new Uint8Array(32).fill(7);

/** LATGSET1 per NATIVE_ISSUANCE §4. */
function guardianSetBytes(scheme: number, threshold: number, epoch: bigint, ed: Uint8Array[], ml: Uint8Array[]) {
  const count = Math.max(ed.length, ml.length);
  const d = Buffer.alloc(64 + count * keyEntryLen(scheme));
  d.write("LATGSET1", 0, "latin1");
  d[8] = 1;
  d[9] = scheme;
  d[10] = threshold;
  d[11] = count;
  d[12] = 254;
  d.set(u64le(epoch), 16);
  d.set(u64le(1234n), 24);
  d.set(deployment, 32);
  for (let i = 0; i < count; i++) {
    let o = 64 + i * keyEntryLen(scheme);
    if (ed[i]) {
      d.set(ed[i]!, o);
      o += 32;
    }
    if (ml[i]) d.set(ml[i]!, o);
  }
  return new Uint8Array(d);
}

describe("Lattice guardian set (LATGSET1)", () => {
  const ed = [1, 2, 3].map((i) => new Uint8Array(32).fill(i));
  const ml = [1, 2, 3].map((i) => new Uint8Array(1952).fill(0x10 + i));

  it("decodes Ed25519 and hybrid sets", () => {
    const one = decodeLatticeGuardianSet(guardianSetBytes(1, 2, 4n, ed, []), deployment);
    expect(one).toMatchObject({ epoch: 4n, threshold: 2, scheme: 1 });
    expect(one.keys.map(toHex)).toEqual(ed.map(toHex));
    expect(one.mldsaKeys).toBeUndefined();

    const hy = decodeLatticeGuardianSet(guardianSetBytes(3, 2, 5n, ed, ml), deployment);
    expect(hy).toMatchObject({ epoch: 5n, threshold: 2, scheme: 3 });
    expect(hy.keys.map(toHex)).toEqual(ed.map(toHex));
    expect(hy.mldsaKeys!.map(toHex)).toEqual(ml.map(toHex));
  });

  it("rejects wrong magic, foreign deployment, truncation and unknown schemes", () => {
    const good = guardianSetBytes(3, 2, 1n, ed, ml);
    const bad = Uint8Array.from(good);
    bad[0] = 0x58;
    expect(() => decodeLatticeGuardianSet(bad, deployment)).toThrow(/not a Lattice guardian set/);
    expect(() => decodeLatticeGuardianSet(good, new Uint8Array(32))).toThrow(/deployment/);
    expect(() => decodeLatticeGuardianSet(good.subarray(0, good.length - 1), deployment)).toThrow(/truncated/);
    const unknown = Uint8Array.from(good);
    unknown[9] = 9;
    expect(() => decodeLatticeGuardianSet(unknown, deployment)).toThrow(/scheme/);
  });
});

describe("staged mint transactions (NATIVE_ISSUANCE §3)", () => {
  function fakeMessage(scheme: number) {
    const m = new Uint8Array(276);
    m[18] = scheme;
    m.set(u64le(2n), 180);
    m.set(u64le(41n), 188);
    m.set(Keypair.generate().publicKey.toBytes(), 212);
    return m;
  }
  const sig = (index: number, ml: boolean): IndexedSignature => ({
    index,
    publicKey: new Uint8Array(32),
    signature: new Uint8Array(64).fill(index + 1),
    ...(ml ? { mldsaSignature: new Uint8Array(3309).fill(index + 1) } : {}),
  });

  for (const [scheme, n] of [
    [Scheme.Ed25519, 13],
    [Scheme.Hybrid, 13],
  ] as const) {
    it(`scheme ${scheme}, ${n} signatures: layout, offsets, PDAs and packet sizes`, () => {
      const programId = LATTICE_BRIDGE_PROGRAM_ID;
      const payer = Keypair.generate();
      const attestation = Keypair.generate();
      const message = fakeMessage(scheme);
      const signatures = Array.from({ length: n }, (_, i) => sig(i, scheme === Scheme.Hybrid));
      const txs = buildStagedMint({ programId, payer: payer.publicKey, attestation, attestationRent: 1, deploymentId: deployment, scheme, message, signatures });

      const [create, init] = txs[0]!.instructions;
      expect(create!.programId.equals(SystemProgram.programId)).toBe(true);
      const space = Buffer.from(create!.data).readBigUInt64LE(12);
      expect(Number(space)).toBe(96 + 276 + n * signatureEntryLen(scheme));
      expect(attestationSize(scheme, 276, n)).toBe(Number(space));
      expect([...init!.data]).toEqual([LatTag.InitAttestation, scheme, n, 20, 1, 0, 0]);

      const body = Buffer.concat([Buffer.from(message), ...signatures.map((s) => encodeSignatureEntry(scheme, s))]);
      const writes = txs.filter((t) => t.label.startsWith("write")).map((t) => t.instructions[0]!);
      let expected = 0;
      for (const w of writes) {
        expect(w.data[0]).toBe(LatTag.WriteAttestation);
        expect(w.data.readUInt32LE(1)).toBe(expected);
        expect(Buffer.from(w.data.subarray(5)).equals(body.subarray(expected, expected + w.data.length - 5))).toBe(true);
        expected += w.data.length - 5;
      }
      expect(expected).toBe(body.length);

      const verifies = txs.filter((t) => t.label.startsWith("verify")).map((t) => t.instructions[1]!);
      let covered = 0;
      for (const v of verifies) {
        expect(v.data[0]).toBe(LatTag.VerifyAttestation);
        expect(v.data[1]).toBe(covered);
        covered += v.data[2]!;
      }
      expect(covered).toBe(n);

      const mint = txs.at(-1)!.instructions[1]!;
      expect([...mint.data]).toEqual([LatTag.MintFromDeposit]);
      const pda = (...s: Uint8Array[]) => PublicKey.findProgramAddressSync(s.map((x) => Buffer.from(x)), programId)[0];
      const expectedKeys = [
        payer.publicKey,
        pda(Buffer.from("state"), deployment),
        pda(Buffer.from("guardian-set"), deployment, u64le(2n)),
        attestation.publicKey,
        pda(Buffer.from("minted"), deployment, u64le(41n)),
        new PublicKey(message.subarray(212, 244)),
        SystemProgram.programId,
      ];
      expect(mint.keys.map((k) => k.pubkey.toBase58())).toEqual(expectedKeys.map((k) => k.toBase58()));

      for (const t of txs) {
        const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(...t.instructions);
        tx.sign(payer, ...t.signers);
        expect(tx.serialize().length).toBeLessThanOrEqual(1232);
      }
    });
  }

  it("refuses a message whose scheme differs from the set, and hybrid entries without ML-DSA", () => {
    const base = { programId: LATTICE_BRIDGE_PROGRAM_ID, payer: Keypair.generate().publicKey, attestation: Keypair.generate(), attestationRent: 1, deploymentId: deployment };
    expect(() => buildStagedMint({ ...base, scheme: Scheme.Hybrid, message: fakeMessage(1), signatures: [sig(0, true)] })).toThrow(/scheme/);
    expect(() => buildStagedMint({ ...base, scheme: Scheme.Hybrid, message: fakeMessage(3), signatures: [sig(0, false)] })).toThrow(/ML-DSA/);
  });
});

describe("hybrid Lattice guardians", () => {
  it("attesters sign DEPOSITs with Ed25519 and ML-DSA-65 over the same digest, scheme byte 3", async () => {
    const w = world(3, 2, 0, { hybrid: true });
    w.source.deposit(5_000_000n, Keypair.generate().publicKey.toBytes());
    const a = await w.attesters[1]!.attest("deposit", 0n);
    const message = fromHex(a.message);
    expect(decodeTransfer(message).scheme).toBe(Scheme.Hybrid);
    const digest = messageDigest(message);
    expect(ml_dsa65.verify(fromHex(a.mldsaSignature!), digest, w.mldsa[1]!.publicKey)).toBe(true);

    const set = (await w.lattice.guardianSet(1n))!;
    const sigs = await collectSignatures(w.endpoints, "deposit", 0n, message, set, silentLogger);
    expect(sigs.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(sigs.every((s) => s.mldsaSignature?.length === 3309)).toBe(true);
    await w.lattice.mint(message, sigs.slice(0, 2));
    expect((await w.lattice.mintRecord(0n)).value?.nativeAmount).toBe(5_000_000_000n);
  });

  it("withdrawals stay Ed25519-only (Solana verifies scheme 1)", async () => {
    const w = world(3, 2, 0, { hybrid: true });
    const lat = Keypair.generate().publicKey.toBytes();
    w.source.deposit(1_000n, lat);
    const set = (await w.lattice.guardianSet(1n))!;
    const dep = await w.attesters[0]!.attest("deposit", 0n);
    const sigs = await collectSignatures(w.endpoints, "deposit", 0n, fromHex(dep.message), set, silentLogger);
    await w.lattice.mint(fromHex(dep.message), sigs);
    w.lattice.burnFor(lat, 1_000_000n, Keypair.generate().publicKey.toBytes());
    const wd = await w.attesters[0]!.attest("withdrawal", 0n);
    expect(decodeTransfer(fromHex(wd.message)).scheme).toBe(Scheme.Ed25519);
    expect(wd.mldsaSignature).toBeUndefined();
  });

  it("drops missing or forged ML-DSA signatures; destination rejects Ed25519-only entries", async () => {
    const w = world(3, 2, 0, { hybrid: true });
    w.source.deposit(2_000n, Keypair.generate().publicKey.toBytes());
    const message = fromHex((await w.attesters[0]!.attest("deposit", 0n)).message);
    const set = (await w.lattice.guardianSet(1n))!;
    const stripped = {
      label: "stripped",
      attest: async () => {
        const { mldsaSignature: _m, ...rest } = await w.attesters[1]!.attest("deposit", 0n);
        return rest;
      },
    };
    const forged = {
      label: "forged",
      attest: async () => {
        const r = await w.attesters[2]!.attest("deposit", 0n);
        const bad = fromHex(r.mldsaSignature!);
        bad[100] = bad[100]! ^ 1;
        return { ...r, mldsaSignature: toHex(bad) };
      },
    };
    const sigs = await collectSignatures([w.endpoints[0]!, stripped, forged], "deposit", 0n, message, set, silentLogger);
    expect(sigs.map((s) => s.index)).toEqual([0]);

    const edOnly = await collectSignatures(w.endpoints, "deposit", 0n, message, set, silentLogger);
    await expect(w.lattice.mint(message, edOnly.map(({ mldsaSignature: _m, ...s }) => s))).rejects.toThrow(DestinationRejected);
  });

  it("an attester without the matching ML-DSA key refuses to sign for a hybrid set", async () => {
    const w = world(3, 2, 0, { hybrid: true });
    w.source.deposit(2_000n, Keypair.generate().publicKey.toBytes());
    const journal = () => new SigningJournal(join(mkdtempSync(join(tmpdir(), "j-")), "j"));
    const noKey = new Attester(w.guardians[0]!, w.binding, w.source, w.lattice, journal(), silentLogger);
    await expect(noKey.attest("deposit", 0n)).rejects.toThrow(NotAGuardian);
    const wrongKey = new Attester(w.guardians[0]!, w.binding, w.source, w.lattice, journal(), silentLogger, w.mldsa[1]);
    await expect(wrongKey.attest("deposit", 0n)).rejects.toThrow(/does not match/);
  });

  it("the relayer refuses ML-DSA-only (scheme 2) sets explicitly", async () => {
    const w = world();
    w.source.deposit(2_000n, Keypair.generate().publicKey.toBytes());
    const message = fromHex((await w.attesters[0]!.attest("deposit", 0n)).message);
    const set = { epoch: 1n, threshold: 2, keys: w.guardians.map((g) => g.publicKey), scheme: Scheme.MlDsa65 };
    await expect(collectSignatures(w.endpoints, "deposit", 0n, message, set, silentLogger)).rejects.toThrow(/scheme 2/);
  });
});
