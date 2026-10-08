import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { encodeTransfer, fromHex, messageDigest, toHex, decodeTransfer } from "@lattice/protocol/wire";
import { BindingMismatch, NotAGuardian, NotFinalized, Attester } from "../src/attester/core.js";
import { Equivocation, SigningJournal } from "../src/attester/journal.js";
import { UnsafeKeyFile, loadGuardianKey } from "../src/attester/keyfile.js";
import { attesterServer } from "../src/attester/server.js";
import { HttpAttester, collectSignatures } from "../src/guardians.js";
import { silentLogger } from "../src/log.js";
import { ed25519Verify } from "../src/vault/client.js";
import { key, world } from "./helpers/fixtures.js";

const recipient = () => Keypair.generate().publicKey.toBytes();

describe("guardian attester", () => {
  it("signs only events it observed itself, over the canonical digest", async () => {
    const w = world();
    await expect(w.attesters[0]!.attest("deposit", 0n)).rejects.toBeInstanceOf(NotFinalized);
    w.source.deposit(5_000_000n, recipient());
    const a = await w.attesters[0]!.attest("deposit", 0n);
    const msg = fromHex(a.message);
    expect(a.digest).toBe(toHex(messageDigest(msg)));
    expect(ed25519Verify(w.guardians[0]!.publicKey, messageDigest(msg), fromHex(a.signature))).toBe(true);
    expect(decodeTransfer(msg).nativeAmount).toBe(5_000_000_000n);
  });

  it("refuses to sign a different digest for the same (kind, nonce, epoch), even after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-"));
    const path = join(dir, "j.jsonl");
    const j = new SigningJournal(path);
    j.record(2, 7n, 1n, "aa");
    j.record(2, 7n, 1n, "aa");
    expect(() => j.record(2, 7n, 1n, "bb")).toThrow(Equivocation);
    j.record(2, 7n, 2n, "cc");
    j.close();
    const reopened = new SigningJournal(path);
    expect(reopened.size()).toBe(2);
    expect(() => reopened.record(2, 7n, 1n, "bb")).toThrow(Equivocation);
    reopened.close();
  });

  it("will not equivocate when the observed event changes under it", async () => {
    const w = world();
    const r = w.source.deposit(5_000_000n, recipient());
    await w.attesters[0]!.attest("deposit", 0n);
    w.source.receipts.set(0n, { ...r, credited: 6_000_000n, native: 6_000_000_000n });
    await expect(w.attesters[0]!.attest("deposit", 0n)).rejects.toBeInstanceOf(Equivocation);
  });

  it("refuses when not in the verifying guardian set or when the binding differs", async () => {
    const w = world();
    w.source.deposit(1_000_000n, recipient());
    const outsider = new Attester(key(), w.binding, w.source, w.lattice, new SigningJournal(join(mkdtempSync(join(tmpdir(), "j-")), "j")), silentLogger);
    await expect(outsider.attest("deposit", 0n)).rejects.toBeInstanceOf(NotAGuardian);
    w.source.cfg = { ...w.source.cfg, latticeGenesisHash: new Uint8Array(32).fill(9) };
    await expect(w.attesters[0]!.attest("deposit", 0n)).rejects.toBeInstanceOf(BindingMismatch);
  });

  it("loads keys only from owner-only files outside any git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "key-"));
    const path = join(dir, "guardian.json");
    const kp = Keypair.generate();
    writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o644 });
    expect(() => loadGuardianKey(path)).toThrow(UnsafeKeyFile);
    chmodSync(path, 0o600);
    expect(Buffer.from(loadGuardianKey(path).publicKey).equals(kp.publicKey.toBuffer())).toBe(true);
    const inRepo = new URL("../package.json", import.meta.url).pathname;
    expect(() => loadGuardianKey(inRepo)).toThrow(UnsafeKeyFile);
    writeFileSync(path, JSON.stringify([...kp.secretKey.slice(0, 32), ...Keypair.generate().publicKey.toBytes()]));
    expect(() => loadGuardianKey(path)).toThrow();
  });

  it("serves attestations over HTTP with bearer auth and maps refusals to status codes", async () => {
    const w = world();
    w.source.deposit(2_000_000n, recipient());
    const server = attesterServer(w.attesters[1]!, silentLogger, "s3cret");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const ok = await new HttpAttester("g1", `http://127.0.0.1:${port}`, "s3cret").attest("deposit", 0n);
      expect(ok.guardian).toBe(toHex(w.guardians[1]!.publicKey));
      await expect(new HttpAttester("g1", `http://127.0.0.1:${port}`, "wrong").attest("deposit", 0n)).rejects.toThrow(/401/);
      await expect(new HttpAttester("g1", `http://127.0.0.1:${port}`, "s3cret").attest("deposit", 9n)).rejects.toThrow(/425/);
      const bad = await fetch(`http://127.0.0.1:${port}/v1/attest`, {
        method: "POST",
        headers: { authorization: "Bearer s3cret" },
        body: JSON.stringify({ direction: "deposit", nonce: "-1" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("relayer keeps only verified signatures over its own message", async () => {
    const w = world();
    w.source.deposit(3_000_000n, recipient());
    const mine = fromHex((await w.attesters[0]!.attest("deposit", 0n)).message);
    const liar = {
      label: "liar",
      attest: async () => {
        const real = await w.attesters[2]!.attest("deposit", 0n);
        const t = decodeTransfer(fromHex(real.message));
        return { ...real, message: toHex(encodeTransfer({ ...t, recipient: recipient() })) };
      },
    };
    const forger = { label: "forger", attest: async () => ({ ...(await w.attesters[1]!.attest("deposit", 0n)), signature: toHex(new Uint8Array(64)) }) };
    const set = { epoch: 1n, threshold: 2, keys: w.guardians.map((g) => g.publicKey) };
    const sigs = await collectSignatures([w.endpoints[0]!, liar, forger], "deposit", 0n, mine, set, silentLogger);
    expect(sigs.map((s) => s.index)).toEqual([0]);
  });
});
