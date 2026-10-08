import { PublicKey } from "@solana/web3.js";
import { SpecLatticeAdapter } from "../chain/lattice.js";
import { SolanaSource } from "../chain/solana.js";
import { createPool } from "../db.js";
import { bindingFrom, loadEnv, readers } from "../env.js";
import { createLogger } from "../log.js";
import { computeStatus, logStatus, publishStatus, recordSample } from "../reconcile.js";

/** One-shot reconciliation: reads both chains, writes the status JSON, optionally records a sample. */
const log = createLogger({ service: "lattice-reconcile" });
const env = loadEnv();
const binding = bindingFrom(env);
const r = readers(env, log);
const status = await computeStatus(
  new SolanaSource(r.solana, binding.sourceProgramId),
  new SpecLatticeAdapter(r.lattice, new PublicKey(env.LATTICE_BRIDGE_PROGRAM_ID), binding.deploymentId),
  binding,
);
await publishStatus(process.env.STATUS_PATH ?? "./data/bridge-status.json", status);
if (process.env.DATABASE_URL) {
  const pool = createPool(process.env.DATABASE_URL);
  await recordSample(pool, status);
  await pool.end();
}
logStatus(log, status);
process.exitCode = status.alarms.length ? 3 : 0;
