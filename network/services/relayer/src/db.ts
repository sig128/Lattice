import type { IndexedSignature } from "./chain/types.js";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { transitionClaim, type ClaimState } from "@lattice/protocol";

export type Direction = "deposit" | "withdrawal";

export interface Claim {
  deploymentId: Uint8Array;
  direction: Direction;
  nonce: bigint;
  eventId: Uint8Array;
  state: ClaimState;
  sourceAmount: bigint | null;
  nativeAmount: bigint | null;
  recipient: Uint8Array | null;
  observedSlot: bigint | null;
  finalizedSlot: bigint | null;
  message: Uint8Array | null;
  digest: Uint8Array | null;
  signerEpoch: bigint | null;
  submitAttempts: number;
  lastSubmitTx: string | null;
  lastSubmitAt: Date | null;
  completedSlot: bigint | null;
  failureReason: string | null;
}

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const MIGRATION_LOCK = 0x1a77_1ce0;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5, application_name: "lattice-relayer" });
}

/** Applies pending migrations in order, serialized across processes by an advisory lock. */
export async function migrate(pool: pg.Pool): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const applied: number[] = [];
    for (const f of files) {
      const version = Number(f.slice(0, 3));
      if (done.has(version)) continue;
      const sql = await readFile(new URL(f, MIGRATIONS_DIR), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [version, f]);
        await client.query("COMMIT");
        applied.push(version);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

const big = (v: string | null) => (v === null ? null : BigInt(v));
const bytes = (v: Buffer | null) => (v === null ? null : new Uint8Array(v));

function row(r: Record<string, unknown>): Claim {
  return {
    deploymentId: new Uint8Array(r.deployment_id as Buffer),
    direction: r.direction as Direction,
    nonce: BigInt(r.nonce as string),
    eventId: new Uint8Array(r.event_id as Buffer),
    state: r.state as ClaimState,
    sourceAmount: big(r.source_amount as string | null),
    nativeAmount: big(r.native_amount as string | null),
    recipient: bytes(r.recipient as Buffer | null),
    observedSlot: big(r.observed_slot as string | null),
    finalizedSlot: big(r.finalized_slot as string | null),
    message: bytes(r.message as Buffer | null),
    digest: bytes(r.digest as Buffer | null),
    signerEpoch: big(r.signer_epoch as string | null),
    submitAttempts: r.submit_attempts as number,
    lastSubmitTx: r.last_submit_tx as string | null,
    lastSubmitAt: r.last_submit_at as Date | null,
    completedSlot: big(r.completed_slot as string | null),
    failureReason: r.failure_reason as string | null,
  };
}

export type ClaimPatch = Partial<
  Pick<
    Claim,
    | "sourceAmount"
    | "nativeAmount"
    | "recipient"
    | "finalizedSlot"
    | "message"
    | "digest"
    | "signerEpoch"
    | "completedSlot"
    | "failureReason"
  >
>;

const COLUMNS: Record<keyof ClaimPatch, string> = {
  sourceAmount: "source_amount",
  nativeAmount: "native_amount",
  recipient: "recipient",
  finalizedSlot: "finalized_slot",
  message: "message",
  digest: "digest",
  signerEpoch: "signer_epoch",
  completedSlot: "completed_slot",
  failureReason: "failure_reason",
};

function toParam(v: unknown) {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v);
  return v;
}

export class ConcurrentUpdate extends Error {}

export class ClaimStore {
  constructor(readonly pool: pg.Pool) {}

  /** Inserts a newly observed event. Returns false if it was already known (idempotent). */
  async insertObserved(c: {
    deploymentId: Uint8Array;
    direction: Direction;
    nonce: bigint;
    eventId: Uint8Array;
    observedSlot: bigint;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO bridge_claims (deployment_id, direction, nonce, event_id, state, observed_slot)
         VALUES ($1, $2, $3, $4, 'observed', $5)
         ON CONFLICT (deployment_id, direction, nonce) DO NOTHING`,
        [Buffer.from(c.deploymentId), c.direction, c.nonce.toString(), Buffer.from(c.eventId), c.observedSlot.toString()],
      );
      if (res.rowCount === 1) {
        await client.query(
          `INSERT INTO claim_transitions (deployment_id, direction, nonce, from_state, to_state) VALUES ($1, $2, $3, NULL, 'observed')`,
          [Buffer.from(c.deploymentId), c.direction, c.nonce.toString()],
        );
      }
      await client.query("COMMIT");
      return res.rowCount === 1;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async get(deploymentId: Uint8Array, direction: Direction, nonce: bigint): Promise<Claim | null> {
    const r = await this.pool.query(
      "SELECT * FROM bridge_claims WHERE deployment_id = $1 AND direction = $2 AND nonce = $3",
      [Buffer.from(deploymentId), direction, nonce.toString()],
    );
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  async active(deploymentId: Uint8Array, direction: Direction, limit = 100): Promise<Claim[]> {
    const r = await this.pool.query(
      `SELECT * FROM bridge_claims WHERE deployment_id = $1 AND direction = $2 AND state NOT IN ('completed', 'failed')
       ORDER BY nonce LIMIT $3`,
      [Buffer.from(deploymentId), direction, limit],
    );
    return r.rows.map(row);
  }

  async nextUnseen(deploymentId: Uint8Array, direction: Direction): Promise<bigint> {
    const r = await this.pool.query<{ n: string | null }>(
      "SELECT max(nonce)::text AS n FROM bridge_claims WHERE deployment_id = $1 AND direction = $2",
      [Buffer.from(deploymentId), direction],
    );
    return r.rows[0]?.n === null || r.rows[0]?.n === undefined ? 0n : BigInt(r.rows[0].n) + 1n;
  }

  /**
   * Compare-and-set transition. Validates the edge with the protocol state
   * machine, updates only if the row is still in `from`, and logs the edge in
   * the same transaction. Throws ConcurrentUpdate if another worker moved it.
   */
  async transition(c: Claim, to: ClaimState, patch: ClaimPatch = {}, detail: Record<string, unknown> = {}): Promise<Claim> {
    transitionClaim(c.state, to);
    return this.update(c, to, patch, detail);
  }

  /** Patches fields without changing state (e.g. re-signing after rotation). */
  async patch(c: Claim, patch: ClaimPatch, detail: Record<string, unknown> = {}): Promise<Claim> {
    return this.update(c, c.state, patch, detail, false);
  }

  private async update(c: Claim, to: ClaimState, patch: ClaimPatch, detail: Record<string, unknown>, log = true): Promise<Claim> {
    const sets = ["state = $4", "updated_at = now()"];
    const params: unknown[] = [Buffer.from(c.deploymentId), c.direction, c.nonce.toString(), to, c.state];
    for (const [k, v] of Object.entries(patch)) {
      params.push(toParam(v));
      sets.push(`${COLUMNS[k as keyof ClaimPatch]} = $${params.length}`);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `UPDATE bridge_claims SET ${sets.join(", ")}
         WHERE deployment_id = $1 AND direction = $2 AND nonce = $3 AND state = $5 RETURNING *`,
        params,
      );
      if (r.rowCount !== 1) throw new ConcurrentUpdate(`claim ${c.direction}/${c.nonce} is no longer ${c.state}`);
      if (log || Object.keys(detail).length) {
        await client.query(
          `INSERT INTO claim_transitions (deployment_id, direction, nonce, from_state, to_state, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
          [Buffer.from(c.deploymentId), c.direction, c.nonce.toString(), c.state, to, JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
        );
      }
      await client.query("COMMIT");
      return row(r.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Write-ahead record of a submission attempt, committed before the transaction is sent. */
  async recordAttempt(c: Claim): Promise<Claim> {
    const r = await this.pool.query(
      `UPDATE bridge_claims SET submit_attempts = submit_attempts + 1, last_submit_at = now(), updated_at = now()
       WHERE deployment_id = $1 AND direction = $2 AND nonce = $3 AND state = $4 RETURNING *`,
      [Buffer.from(c.deploymentId), c.direction, c.nonce.toString(), c.state],
    );
    if (r.rowCount !== 1) throw new ConcurrentUpdate("claim moved during submission");
    return row(r.rows[0]);
  }

  async recordSubmitTx(c: Claim, tx: string): Promise<void> {
    await this.pool.query(
      "UPDATE bridge_claims SET last_submit_tx = $4, updated_at = now() WHERE deployment_id = $1 AND direction = $2 AND nonce = $3",
      [Buffer.from(c.deploymentId), c.direction, c.nonce.toString(), tx],
    );
  }

  async storeSignature(digest: Uint8Array, s: IndexedSignature): Promise<void> {
    await this.pool.query(
      `INSERT INTO claim_signatures (digest, guardian_index, guardian_key, signature, mldsa_signature) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (digest, guardian_index) DO NOTHING`,
      [Buffer.from(digest), s.index, Buffer.from(s.publicKey), Buffer.from(s.signature), s.mldsaSignature ? Buffer.from(s.mldsaSignature) : null],
    );
  }

  async signatures(digest: Uint8Array): Promise<IndexedSignature[]> {
    const r = await this.pool.query(
      "SELECT guardian_index, guardian_key, signature, mldsa_signature FROM claim_signatures WHERE digest = $1 ORDER BY guardian_index",
      [Buffer.from(digest)],
    );
    return r.rows.map((x) => ({
      index: x.guardian_index as number,
      publicKey: new Uint8Array(x.guardian_key as Buffer),
      signature: new Uint8Array(x.signature as Buffer),
      ...(x.mldsa_signature ? { mldsaSignature: new Uint8Array(x.mldsa_signature as Buffer) } : {}),
    }));
  }

  async transitions(deploymentId: Uint8Array, direction: Direction, nonce: bigint): Promise<string[]> {
    const r = await this.pool.query(
      "SELECT from_state, to_state FROM claim_transitions WHERE deployment_id = $1 AND direction = $2 AND nonce = $3 ORDER BY id",
      [Buffer.from(deploymentId), direction, nonce.toString()],
    );
    return r.rows.filter((x) => x.from_state !== x.to_state).map((x) => `${x.from_state ?? "∅"}->${x.to_state}`);
  }
}

/** Holds a session-level advisory lock so only one relayer instance drives claims. */
export async function acquireLeadership(pool: pg.Pool, deploymentId: Uint8Array): Promise<pg.PoolClient | null> {
  const client = await pool.connect();
  const key = Buffer.from(deploymentId).readInt32LE(0);
  const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(42, $1) AS ok", [key]);
  if (r.rows[0]?.ok) return client;
  client.release();
  return null;
}
