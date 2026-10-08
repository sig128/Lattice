import { publicConfig } from "@lattice/config";
import pg from "pg";
import { probeEndpoint, type RpcObservation } from "./probe.js";

const intervalMs = Number(process.env.MONITOR_INTERVAL_MS ?? 15_000);
const timeoutMs = Number(process.env.MONITOR_TIMEOUT_MS ?? 5_000);
const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new pg.Pool({ connectionString, max: 3 }) : null;
let stopping = false;

if (pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rpc_observations (
      id bigserial PRIMARY KEY,
      endpoint_label text NOT NULL,
      checked_at timestamptz NOT NULL,
      observation jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rpc_observations_endpoint_time
      ON rpc_observations(endpoint_label, checked_at DESC);
  `);
}

async function persist(label: string, observation: RpcObservation) {
  if (!pool) return;
  await pool.query(
    "INSERT INTO rpc_observations(endpoint_label, checked_at, observation) VALUES ($1, $2, $3)",
    [label, observation.checkedAt, observation],
  );
}

async function checkAll() {
  for (const endpoint of publicConfig.rpc) {
    const observation = await probeEndpoint(
      endpoint.httpUrl,
      endpoint.websocketUrl,
      endpoint.expectedGenesisHash,
      timeoutMs,
    );
    await persist(endpoint.label, observation);
    console.log(JSON.stringify({
      level: observation.httpStatus === "operational" ? "info" : "warn",
      event: "rpc_observation",
      endpoint: endpoint.label,
      ...observation,
    }));
  }
}

function shutdown(signal: string) {
  stopping = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown", signal }));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

do {
  await checkAll();
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
} while (!stopping);

await pool?.end();
