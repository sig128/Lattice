import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import pg from "pg";
import {
  burnEventId,
  deploymentId,
  depositEventId,
  nativeScale,
} from "@lattice/protocol/wire";
import { Attester } from "../../src/attester/core.js";
import { SigningJournal } from "../../src/attester/journal.js";
import { ReferenceLattice } from "../../src/chain/lattice-reference.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import type { MlDsaKey } from "../../src/attester/keyfile.js";
import { Scheme, type Binding, type GuardianSetView, type IndexedSignature, type Observed, type SourceSubmitter, type SourceView } from "../../src/chain/types.js";
import { ClaimStore, createPool, migrate } from "../../src/db.js";
import type { AttesterEndpoint } from "../../src/guardians.js";
import { silentLogger } from "../../src/log.js";
import {
  decodeTransfer,
  equalBytes,
  messageDigest,
} from "@lattice/protocol/wire";
import {
  ed25519FromSecret,
  ed25519Verify,
  type ConsumedWithdrawal,
  type DepositReceipt,
  type Ed25519Key,
  type VaultConfig,
} from "../../src/vault/client.js";

export const TEST_DB = process.env.TEST_DATABASE_URL;

export async function freshDb(): Promise<{ pool: pg.Pool; store: ClaimStore }> {
  const pool = createPool(TEST_DB!);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  return { pool, store: new ClaimStore(pool) };
}

export function key(): Ed25519Key {
  return ed25519FromSecret(Keypair.generate().secretKey);
}

export function makeBinding(): Binding {
  return {
    deploymentId: deploymentId(`unit-${Math.random()}`),
    solanaGenesisHash: new Uint8Array(32).fill(1),
    latticeGenesisHash: new Uint8Array(32).fill(2),
    sourceProgramId: Keypair.generate().publicKey,
    sourceMint: Keypair.generate().publicKey,
    sourceDecimals: 6,
  };
}

/**
 * In-memory model of the Solana source vault with the program's release
 * semantics (threshold, epoch, exactly-once by nonce). Program behaviour on a
 * real validator is covered by program.validator.test.ts.
 */
export class FakeSource implements SourceView, SourceSubmitter {
  slot = 100;
  cfg: VaultConfig;
  receipts = new Map<bigint, DepositReceipt>();
  consumedMap = new Map<bigint, ConsumedWithdrawal>();
  sets = new Map<bigint, { scheme: number; threshold: number; epoch: bigint; keys: Uint8Array[] }>();
  vault = 0n;
  releaseCalls = 0;
  payouts = new Map<string, bigint>();

  constructor(readonly binding: Binding, guardians: Uint8Array[], threshold: number) {
    this.sets.set(1n, { scheme: 1, threshold, epoch: 1n, keys: guardians });
    this.cfg = {
      decimals: binding.sourceDecimals,
      depositsPaused: false,
      withdrawalsPaused: false,
      deploymentId: binding.deploymentId,
      solanaGenesisHash: binding.solanaGenesisHash,
      latticeGenesisHash: binding.latticeGenesisHash,
      mint: binding.sourceMint,
      tokenProgram: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      pauser: null,
      epoch: 1n,
      nextDepositSequence: 0n,
      governanceSequence: 0n,
      totalDeposited: 0n,
      totalReleased: 0n,
      depositCap: 1n << 60n,
      rateWindowSecs: 86_400n,
      maxDepositPerWindow: 1n << 60n,
      maxWithdrawalPerWindow: 1n << 60n,
      releasedCount: 0n,
    };
  }

  deposit(amount: bigint, latticeRecipient: Uint8Array): DepositReceipt {
    const seq = this.cfg.nextDepositSequence;
    const r: DepositReceipt = {
      sequence: seq,
      eventId: depositEventId(this.binding.deploymentId, seq),
      depositor: Keypair.generate().publicKey,
      depositorToken: Keypair.generate().publicKey,
      latticeRecipient,
      requested: amount,
      credited: amount,
      native: amount * nativeScale(this.binding.sourceDecimals),
      slot: BigInt(++this.slot),
      timestamp: 0n,
      deploymentId: this.binding.deploymentId,
    };
    this.receipts.set(seq, r);
    this.vault += amount;
    this.cfg = { ...this.cfg, nextDepositSequence: seq + 1n, totalDeposited: this.cfg.totalDeposited + amount };
    return r;
  }

  rotate(epoch: bigint, keys: Uint8Array[], threshold: number) {
    this.sets.set(epoch, { scheme: 1, threshold, epoch, keys });
    this.cfg = { ...this.cfg, epoch };
  }

  async config(): Promise<Observed<VaultConfig>> {
    return { value: { ...this.cfg }, slot: this.slot };
  }
  async receipt(seq: bigint) {
    return { value: this.receipts.get(seq) ?? null, slot: this.slot };
  }
  async consumed(nonce: bigint) {
    return { value: this.consumedMap.get(nonce) ?? null, slot: this.slot };
  }
  async guardianSet(epoch: bigint) {
    return this.sets.get(epoch) ?? null;
  }
  async vaultBalance(_v: PublicKey) {
    return { value: this.vault, slot: this.slot };
  }

  async release(message: Uint8Array, epoch: bigint, sigs: IndexedSignature[], owner: PublicKey): Promise<string> {
    this.releaseCalls += 1;
    const t = decodeTransfer(message);
    if (epoch !== this.cfg.epoch || t.signerEpoch !== epoch) throw new Error("StaleEpoch");
    const set = this.sets.get(epoch)!;
    const d = messageDigest(message);
    const valid = new Set(sigs.filter((s) => set.keys[s.index] && equalBytes(set.keys[s.index]!, s.publicKey) && ed25519Verify(s.publicKey, d, s.signature)).map((s) => s.index));
    if (valid.size < set.threshold) throw new Error("BelowThreshold");
    if (!equalBytes(t.eventId, burnEventId(this.binding.deploymentId, t.nonce))) throw new Error("WrongEventId");
    if (!equalBytes(owner.toBytes(), t.recipient)) throw new Error("WrongRecipient");
    if (this.consumedMap.has(t.nonce)) throw new Error("AlreadyConsumed");
    this.slot += 1;
    this.consumedMap.set(t.nonce, {
      nonce: t.nonce,
      eventId: t.eventId,
      recipient: owner,
      recipientToken: owner,
      amount: t.sourceAmount,
      slot: BigInt(this.slot),
      digest: d,
    });
    this.vault -= t.sourceAmount;
    this.cfg = { ...this.cfg, totalReleased: this.cfg.totalReleased + t.sourceAmount, releasedCount: this.cfg.releasedCount + 1n };
    const k = owner.toBase58();
    this.payouts.set(k, (this.payouts.get(k) ?? 0n) + t.sourceAmount);
    return `fake-release-${t.nonce}`;
  }
}

export interface World {
  binding: Binding;
  source: FakeSource;
  lattice: ReferenceLattice;
  guardians: Ed25519Key[];
  attesters: Attester[];
  endpoints: AttesterEndpoint[];
  journals: string[];
  mldsa: MlDsaKey[];
}

/** With `hybrid`, the Lattice guardian set is scheme 3 and every attester also holds an ML-DSA-65 key. */
export function world(n = 3, threshold = 2, latticeFinalityLag = 0, opts: { hybrid?: boolean } = {}): World {
  const binding = makeBinding();
  const guardians = Array.from({ length: n }, key);
  const mldsa = opts.hybrid ? guardians.map(() => ml_dsa65.keygen()) : [];
  const source = new FakeSource(binding, guardians.map((g) => g.publicKey), threshold);
  const latticeSet: GuardianSetView = opts.hybrid
    ? { epoch: 1n, threshold, keys: guardians.map((g) => g.publicKey), scheme: Scheme.Hybrid, mldsaKeys: mldsa.map((k) => k.publicKey) }
    : { epoch: 1n, threshold, keys: guardians.map((g) => g.publicKey) };
  const lattice = new ReferenceLattice(binding, latticeSet, latticeFinalityLag);
  const dir = mkdtempSync(join(tmpdir(), "lattice-journal-"));
  const journals = guardians.map((_, i) => join(dir, `g${i}.jsonl`));
  const attesters = guardians.map(
    (g, i) => new Attester(g, binding, source, lattice, new SigningJournal(journals[i]!), silentLogger, mldsa[i]),
  );
  const endpoints = attesters.map((a, i) => ({ label: `g${i}`, attest: a.attest.bind(a) }));
  return { binding, source, lattice, guardians, attesters, endpoints, journals, mldsa };
}
