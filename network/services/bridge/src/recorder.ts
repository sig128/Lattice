import { Connection } from "@solana/web3.js";
import { COMMITMENT, RPC_URL, observe } from "./local.js";
import { readState } from "./state.js";

const state = await readState();
if (!state) throw new Error("Local bridge state missing. Run pnpm --filter @lattice/bridge setup:local first.");
const connection = new Connection(RPC_URL, COMMITMENT);
if (await connection.getGenesisHash() !== state.genesisHash) {
  throw new Error("Recorder refused a local validator with a different genesis");
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

do {
  const result = await observe(connection, state, "scheduled-observation");
  console.log(JSON.stringify({
    event: "bridge_reconciliation",
    observedAt: new Date().toISOString(),
    reserves: result.reserves.toString(),
    liabilities: result.liabilities.toString(),
    label: result.label,
  }));
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, 15_000));
} while (!stopping);
