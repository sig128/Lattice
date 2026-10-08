import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type pg from "pg";
import { Engine, type FaultPoint } from "../src/engine.js";
import type { ClaimStore } from "../src/db.js";
import { silentLogger } from "../src/log.js";
import { TEST_DB, freshDb, key, world, type World } from "./helpers/fixtures.js";

class SimulatedCrash extends Error {}

let pool: pg.Pool | null = null;
afterEach(async () => {
  await pool?.end();
  pool = null;
});

function engine(w: World, store: ClaimStore, faults?: (p: FaultPoint) => void, resubmitAfterMs = 0) {
  return new Engine({
    store,
    source: w.source,
    sourceSubmitter: w.source,
    lattice: w.lattice,
    latticeSubmitter: w.lattice,
    attesters: w.endpoints,
    binding: w.binding,
    log: silentLogger,
    options: { resubmitAfterMs },
    ...(faults ? { faults } : {}),
  });
}

async function runUntilQuiet(e: Engine, max = 12) {
  for (let i = 0; i < max; i++) {
    const r = await e.tick();
    if (r.advanced === 0 && r.discovered === 0) return;
  }
}

/** Drives an engine until its injected fault fires; the engine is then abandoned (process death). */
async function tickUntilCrash(e: Engine, crashes: () => number, max = 10) {
  for (let i = 0; i < max && crashes() === 0; i++) await e.tick().catch(() => {});
}

/** Mints LAT on the reference Lattice by bridging a deposit, then burns it for a Solana wallet. */
async function fundedBurn(w: World, store: ClaimStore, amountSource: bigint) {
  const latAccount = Keypair.generate().publicKey.toBytes();
  w.source.deposit(amountSource, latAccount);
  await runUntilQuiet(engine(w, store));
  const wallet = Keypair.generate().publicKey;
  w.lattice.burnFor(latAccount, amountSource * 1000n, wallet.toBytes());
  return wallet;
}

describe.skipIf(!TEST_DB)("relayer state machine (PostgreSQL)", () => {
  it("completes a deposit and a withdrawal through every state exactly once", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world();
    const wallet = await fundedBurn(w, db.store, 7_000_000n);
    await runUntilQuiet(engine(w, db.store));
    const dep = await db.store.get(w.binding.deploymentId, "deposit", 0n);
    const wd = await db.store.get(w.binding.deploymentId, "withdrawal", 0n);
    expect(dep!.state).toBe("completed");
    expect(wd!.state).toBe("completed");
    const path = ["∅->observed", "observed->finalized", "finalized->authorized", "authorized->submitted", "submitted->completed"];
    expect(await db.store.transitions(w.binding.deploymentId, "deposit", 0n)).toEqual(path);
    expect(await db.store.transitions(w.binding.deploymentId, "withdrawal", 0n)).toEqual(path);
    expect(w.lattice.mintCalls).toBe(1);
    expect(w.source.releaseCalls).toBe(1);
    expect(w.source.payouts.get(wallet.toBase58())).toBe(7_000_000n);
  });

  const points: FaultPoint[] = ["after-finalize", "after-signatures", "after-attempt-recorded", "after-submit", "before-complete"];
  for (const point of points) {
    it(`recovers from a crash at ${point} without double minting or double release`, async () => {
      const db = await freshDb();
      pool = db.pool;
      const w = world();
      const latAccount = Keypair.generate().publicKey.toBytes();
      w.source.deposit(4_000_000n, latAccount);
      let crashes = 0;
      const crashing = engine(w, db.store, (p) => {
        if (p === point && crashes === 0) {
          crashes++;
          throw new SimulatedCrash(point);
        }
      });
      await tickUntilCrash(crashing, () => crashes);
      expect(crashes).toBe(1);
      // "Restart": a brand-new engine with only the database and chains.
      await runUntilQuiet(engine(w, db.store));
      expect((await db.store.get(w.binding.deploymentId, "deposit", 0n))!.state).toBe("completed");
      expect(w.lattice.balances.get(Buffer.from(latAccount).toString("hex"))).toBe(4_000_000_000n);
      expect((await w.lattice.state()).value.mintedCount).toBe(1n);

      const wallet = Keypair.generate().publicKey;
      w.lattice.burnFor(latAccount, 4_000_000_000n, wallet.toBytes());
      crashes = 0;
      const crashing2 = engine(w, db.store, (p) => {
        if (p === point && crashes === 0) {
          crashes++;
          throw new SimulatedCrash(point);
        }
      });
      await tickUntilCrash(crashing2, () => crashes);
      expect(crashes).toBe(1);
      await runUntilQuiet(engine(w, db.store));
      expect((await db.store.get(w.binding.deploymentId, "withdrawal", 0n))!.state).toBe("completed");
      expect(w.source.payouts.get(wallet.toBase58())).toBe(4_000_000n);
      expect(w.source.consumedMap.size).toBe(1);
    });
  }

  it("completes a deposit to a hybrid (Ed25519 + ML-DSA-65) Lattice guardian set, surviving a crash after signatures", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world(3, 2, 0, { hybrid: true });
    const lat = Keypair.generate().publicKey.toBytes();
    w.source.deposit(4_000_000n, lat);
    let crashes = 0;
    await tickUntilCrash(
      engine(w, db.store, (p) => {
        if (p === "after-signatures" && crashes++ === 0) throw new SimulatedCrash();
      }),
      () => crashes,
    );
    expect(w.lattice.mintCalls).toBe(0);
    await runUntilQuiet(engine(w, db.store));
    const claim = await db.store.get(w.binding.deploymentId, "deposit", 0n);
    expect(claim?.state).toBe("completed");
    const stored = await db.store.signatures(claim!.digest!);
    expect(stored.length).toBe(3);
    expect(stored.every((s) => s.mldsaSignature?.length === 3309)).toBe(true);
    expect(w.lattice.balances.get(Buffer.from(lat).toString("hex"))).toBe(4_000_000_000n);
  });

  it("resubmits while the destination is not yet finalized, and the destination dedupes", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world(3, 2, 3);
    const lat = Keypair.generate().publicKey.toBytes();
    w.source.deposit(9_000_000n, lat);
    let crashes = 0;
    const crashing = engine(w, db.store, (p) => {
      if (p === "after-submit" && crashes === 0) {
        crashes++;
        throw new SimulatedCrash(p);
      }
    });
    await tickUntilCrash(crashing, () => crashes);
    const restarted = engine(w, db.store);
    for (let i = 0; i < 10; i++) {
      await restarted.tick();
      w.lattice.advance();
    }
    expect((await db.store.get(w.binding.deploymentId, "deposit", 0n))!.state).toBe("completed");
    expect(w.lattice.mintCalls).toBeGreaterThan(1);
    expect((await w.lattice.state()).value.mintedCount).toBe(1n);
    expect(w.lattice.balances.get(Buffer.from(lat).toString("hex"))).toBe(9_000_000_000n);
  });

  it("enforces unique event ids and digests in the database", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world();
    const eventId = new Uint8Array(32).fill(7);
    expect(await db.store.insertObserved({ deploymentId: w.binding.deploymentId, direction: "deposit", nonce: 0n, eventId, observedSlot: 1n })).toBe(true);
    expect(await db.store.insertObserved({ deploymentId: w.binding.deploymentId, direction: "deposit", nonce: 0n, eventId, observedSlot: 1n })).toBe(false);
    await expect(db.store.insertObserved({ deploymentId: w.binding.deploymentId, direction: "deposit", nonce: 1n, eventId, observedSlot: 1n })).rejects.toThrow(/unique/i);
    const c = (await db.store.get(w.binding.deploymentId, "deposit", 0n))!;
    await expect(db.store.transition(c, "completed")).rejects.toThrow(/Invalid claim transition/);
    await expect(db.store.transition(c, "finalized")).rejects.toThrow(/check constraint/i);
  });

  it("two engines on the same database never double-submit beyond on-chain dedupe", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world();
    for (let i = 0; i < 5; i++) w.source.deposit(BigInt(i + 1) * 1_000_000n, Keypair.generate().publicKey.toBytes());
    const a = engine(w, db.store, undefined, 60_000);
    const b = engine(w, db.store, undefined, 60_000);
    for (let i = 0; i < 8; i++) await Promise.all([a.tick(), b.tick()]);
    const st = (await w.lattice.state()).value;
    expect(st.mintedCount).toBe(5n);
    expect(st.totalMintedNative).toBe(15_000_000_000n);
    const rows = await db.pool.query("SELECT state, count(*)::int AS n FROM bridge_claims GROUP BY state");
    expect(rows.rows).toEqual([{ state: "completed", n: 5 }]);
  });

  it("re-targets an unfinished withdrawal to the new guardian epoch after rotation", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world();
    const wallet = await fundedBurn(w, db.store, 2_000_000n);
    w.source.cfg = { ...w.source.cfg, withdrawalsPaused: true };
    await runUntilQuiet(engine(w, db.store));
    const held = (await db.store.get(w.binding.deploymentId, "withdrawal", 0n))!;
    expect(held.state).toBe("authorized");
    expect(held.signerEpoch).toBe(1n);
    // Rotate to a set that keeps two of the three guardians.
    const fresh = key();
    w.source.rotate(2n, [w.guardians[0]!.publicKey, w.guardians[1]!.publicKey, fresh.publicKey], 2);
    w.source.cfg = { ...w.source.cfg, withdrawalsPaused: false };
    await runUntilQuiet(engine(w, db.store));
    const done = (await db.store.get(w.binding.deploymentId, "withdrawal", 0n))!;
    expect(done.state).toBe("completed");
    expect(done.signerEpoch).toBe(2n);
    expect(w.source.payouts.get(wallet.toBase58())).toBe(2_000_000n);
  });

  it("marks an invalid event failed and keeps processing others", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world();
    const r = w.source.deposit(1_000_000n, Keypair.generate().publicKey.toBytes());
    w.source.receipts.set(0n, { ...r, native: r.native + 1n });
    w.source.deposit(2_000_000n, Keypair.generate().publicKey.toBytes());
    await runUntilQuiet(engine(w, db.store));
    expect((await db.store.get(w.binding.deploymentId, "deposit", 0n))!.state).toBe("failed");
    expect((await db.store.get(w.binding.deploymentId, "deposit", 1n))!.state).toBe("completed");
  });

  it("waits below threshold and resumes when guardians return", async () => {
    const db = await freshDb();
    pool = db.pool;
    const w = world();
    w.source.deposit(1_000_000n, Keypair.generate().publicKey.toBytes());
    const down = { label: "down", attest: async () => Promise.reject(new Error("offline")) };
    const partial = new Engine({
      store: db.store, source: w.source, sourceSubmitter: w.source, lattice: w.lattice, latticeSubmitter: w.lattice,
      attesters: [w.endpoints[0]!, down, down], binding: w.binding, log: silentLogger,
    });
    await runUntilQuiet(partial);
    expect((await db.store.get(w.binding.deploymentId, "deposit", 0n))!.state).toBe("finalized");
    expect((await db.store.signatures((await db.store.get(w.binding.deploymentId, "deposit", 0n))!.digest!)).length).toBe(1);
    await runUntilQuiet(engine(w, db.store));
    expect((await db.store.get(w.binding.deploymentId, "deposit", 0n))!.state).toBe("completed");
  });
});
