import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import type pg from "pg";
import { deploymentId } from "@lattice/protocol/wire";
import { Attester } from "../src/attester/core.js";
import { SigningJournal } from "../src/attester/journal.js";
import { attesterServer } from "../src/attester/server.js";
import { ReferenceLattice } from "../src/chain/lattice-reference.js";
import { SolanaSource, SolanaSubmitter } from "../src/chain/solana.js";
import type { Binding } from "../src/chain/types.js";
import { Engine, type FaultPoint } from "../src/engine.js";
import { HttpAttester } from "../src/guardians.js";
import { silentLogger } from "../src/log.js";
import { computeStatus } from "../src/reconcile.js";
import { QuorumReader } from "../src/rpc/quorum.js";
import { depositIx, initializeIx, vaultAddresses } from "../src/vault/client.js";
import { TEST_DB, freshDb } from "./helpers/fixtures.js";
import { RPC_URL, connection, deployVault, fund, guardian, send, validatorReachable } from "./helpers/validator.js";

const enabled = process.env.RUN_VALIDATOR_TESTS === "1" && !!TEST_DB && (await validatorReachable());
const UNIT = 1_000_000n;

/** Two Connection objects to one local validator: exercises the quorum code path, NOT provider independence. */
function quorumReader(name: string, genesis: string) {
  return new QuorumReader(
    name,
    [
      { label: `${name}-a`, rpc: new Connection(RPC_URL, "finalized") },
      { label: `${name}-b`, rpc: new Connection(RPC_URL, "finalized") },
    ],
    2,
    genesis,
    silentLogger,
  );
}

describe.skipIf(!enabled)("end to end: real source vault, real attesters, PostgreSQL", () => {
  const authority = Keypair.generate();
  const depositor = Keypair.generate();
  const wallet = Keypair.generate();
  const g = [guardian(), guardian(), guardian()];
  const servers: Server[] = [];
  let pool: pg.Pool;
  let binding: Binding;
  let lattice: ReferenceLattice;
  let source: SolanaSource;
  let submitter: SolanaSubmitter;
  let attesterUrls: string[];
  let store: Awaited<ReturnType<typeof freshDb>>["store"];
  let mint: PublicKey;
  let depositorToken: PublicKey;
  const latAccount = randomBytes(32);

  const engine = (faults?: (p: FaultPoint) => void) =>
    new Engine({
      store,
      source,
      sourceSubmitter: submitter,
      lattice,
      latticeSubmitter: lattice,
      attesters: attesterUrls.map((u, i) => new HttpAttester(`g${i}`, u)),
      binding,
      log: silentLogger,
      options: { resubmitAfterMs: 5_000 },
      ...(faults ? { faults } : {}),
    });

  async function until(e: Engine, done: () => Promise<boolean>, timeoutMs = 90_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await e.tick();
      if (await done()) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error("timed out waiting for the bridge");
  }

  beforeAll(async () => {
    ({ pool, store } = await freshDb());
    await Promise.all([authority, depositor].map((k) => fund(k.publicKey, 50)));
    const genesis = await connection.getGenesisHash();
    const programId = await deployVault(authority);
    mint = await createMint(connection, authority, authority.publicKey, null, 6);
    depositorToken = await createAssociatedTokenAccountIdempotent(connection, depositor, mint, depositor.publicKey);
    await mintTo(connection, authority, mint, depositorToken, authority, 1_000n * UNIT);
    binding = {
      deploymentId: deploymentId(`e2e-${Date.now()}`),
      solanaGenesisHash: new PublicKey(genesis).toBytes(),
      latticeGenesisHash: randomBytes(32),
      sourceProgramId: programId,
      sourceMint: mint,
      sourceDecimals: 6,
    };
    await send(
      [
        initializeIx(programId, authority.publicKey, mint, TOKEN_PROGRAM_ID, {
          deploymentId: binding.deploymentId,
          solanaGenesisHash: binding.solanaGenesisHash,
          latticeGenesisHash: binding.latticeGenesisHash,
          pauser: null,
          depositCap: 500n * UNIT,
          rateWindowSecs: 86_400n,
          maxDepositPerWindow: 500n * UNIT,
          maxWithdrawalPerWindow: 500n * UNIT,
          threshold: 2,
          guardians: g.map((k) => k.publicKey),
        }),
      ],
      [authority],
    );
    lattice = new ReferenceLattice(binding, { epoch: 1n, threshold: 2, keys: g.map((k) => k.publicKey) });
    source = new SolanaSource(quorumReader("relayer-solana", genesis), programId);
    submitter = new SolanaSubmitter(new Connection(RPC_URL, "confirmed"), programId, authority, async () => (await source.config()).value);
    const dir = mkdtempSync(join(tmpdir(), "e2e-journals-"));
    attesterUrls = [];
    for (const [i, key] of g.entries()) {
      // Each guardian reads Solana through its own reader and keeps its own journal.
      const own = new SolanaSource(quorumReader(`guardian-${i}`, genesis), programId);
      const a = new Attester(key, binding, own, lattice, new SigningJournal(join(dir, `g${i}.jsonl`)), silentLogger);
      const server = attesterServer(a, silentLogger);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      servers.push(server);
      attesterUrls.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    }
  }, 300_000);

  afterAll(async () => {
    for (const s of servers) s.close();
    await pool?.end();
  });

  it("bridges a finalized Solana deposit to a Lattice mint", async () => {
    await send([depositIx(binding.sourceProgramId, depositor.publicKey, depositorToken, mint, TOKEN_PROGRAM_ID, 0n, 120n * UNIT, latAccount)], [depositor]);
    await until(engine(), async () => (await store.get(binding.deploymentId, "deposit", 0n))?.state === "completed");
    expect(lattice.balances.get(latAccount.toString("hex"))).toBe(120n * UNIT * 1000n);
    expect((await lattice.state()).value.mintedCount).toBe(1n);
  });

  it("releases a Lattice burn on Solana exactly once across a crash after submission", async () => {
    lattice.burnFor(latAccount, 45n * UNIT * 1000n, wallet.publicKey.toBytes());
    let crashed = false;
    const crashing = engine((p) => {
      if (p === "after-submit" && !crashed) {
        crashed = true;
        throw new Error("simulated crash");
      }
    });
    for (let i = 0; i < 6 && !crashed; i++) await crashing.tick();
    expect(crashed).toBe(true);
    await until(engine(), async () => (await store.get(binding.deploymentId, "withdrawal", 0n))?.state === "completed");
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    expect((await getAccount(connection, ata, "finalized")).amount).toBe(45n * UNIT);
    const consumed = await source.consumed(0n);
    expect(consumed.value!.amount).toBe(45n * UNIT);
    const claim = (await store.get(binding.deploymentId, "withdrawal", 0n))!;
    expect(claim.submitAttempts).toBeGreaterThanOrEqual(1);
  });

  it("reconciles R >= N + P + W from finalized reads, counting donations as surplus", async () => {
    await send([createTransferCheckedInstruction(depositorToken, mint, vaultAddresses(binding.sourceProgramId).vault, depositor.publicKey, 3n * UNIT, 6)], [depositor]);
    // The donation becomes visible to the reconciler only once finalized.
    let status = await computeStatus(source, lattice, binding).catch(() => null);
    for (let i = 0; i < 45 && status?.R !== (78n * UNIT).toString(); i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      status = await computeStatus(source, lattice, binding).catch(() => null);
    }
    expect(status).not.toBeNull();
    expect(status!.alarms).toEqual([]);
    expect([status!.R, status!.N, status!.P, status!.W]).toEqual([
      (78n * UNIT).toString(),
      (75n * UNIT).toString(),
      "0",
      "0",
    ]);
    expect(status!.surplus).toBe((3n * UNIT).toString());
    expect(status!.backed).toBe(true);
  });
});
