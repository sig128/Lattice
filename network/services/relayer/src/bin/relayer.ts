import { Connection, PublicKey } from "@solana/web3.js";
import { SpecLatticeAdapter } from "../chain/lattice.js";
import { SolanaSource, SolanaSubmitter } from "../chain/solana.js";
import { ClaimStore, acquireLeadership, createPool, migrate } from "../db.js";
import { Engine } from "../engine.js";
import { bindingFrom, loadEnv, loadFeePayer, readers } from "../env.js";
import { HttpAttester } from "../guardians.js";
import { healthServer, onShutdown } from "../health.js";
import { createLogger } from "../log.js";
import { computeStatus, publishStatus, recordSample, type BridgeStatus } from "../reconcile.js";

const log = createLogger({ service: "lattice-relayer" });
const env = loadEnv();
const binding = bindingFrom(env);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const attesterUrls = (process.env.ATTESTER_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (attesterUrls.length === 0) throw new Error("ATTESTER_URLS is required");
const tickMs = Number(process.env.TICK_MS ?? 5_000);
const reconcileMs = Number(process.env.RECONCILE_MS ?? 30_000);
const statusPath = process.env.STATUS_PATH ?? "./data/bridge-status.json";

const pool = createPool(databaseUrl);
await migrate(pool);
const store = new ClaimStore(pool);
const r = readers(env, log);
const payer = loadFeePayer(process.env.RELAYER_FEE_PAYER_FILE);
const source = new SolanaSource(r.solana, binding.sourceProgramId);
const submitter = new SolanaSubmitter(new Connection(env.SOLANA_RPC_URLS[0]!, "confirmed"), binding.sourceProgramId, payer, async () => (await source.config()).value);
const lattice = new SpecLatticeAdapter(r.lattice, new PublicKey(env.LATTICE_BRIDGE_PROGRAM_ID), binding.deploymentId, {
  connection: new Connection(env.LATTICE_RPC_URLS[0]!, "confirmed"),
  payer,
});
const engine = new Engine({
  store,
  source,
  sourceSubmitter: submitter,
  lattice,
  latticeSubmitter: lattice,
  attesters: attesterUrls.map((u, i) => new HttpAttester(`attester-${i}`, u, process.env.ATTESTER_TOKEN)),
  binding,
  log,
});

let stopping = false;
let leader: Awaited<ReturnType<typeof acquireLeadership>> = null;
let lastTick: { at: Date; ok: boolean } | null = null;
let lastStatus: BridgeStatus | null = null;
let running: Promise<void> = Promise.resolve();

const server = healthServer({
  live: () => ({ leader: leader !== null, lastTick }),
  async ready() {
    await pool.query("SELECT 1");
    const fresh = lastTick !== null && Date.now() - lastTick.at.getTime() < tickMs * 6;
    return { ok: leader !== null && fresh && lastTick!.ok, detail: { leader: leader !== null, lastTick } };
  },
  status: () => lastStatus,
});
server.listen(Number(process.env.HEALTH_PORT ?? 8787), process.env.HEALTH_HOST ?? "127.0.0.1");

async function loop() {
  let lastReconcile = 0;
  while (!stopping) {
    if (!leader) {
      leader = await acquireLeadership(pool, binding.deploymentId);
      if (!leader) log.info("standby: another relayer holds leadership");
    }
    if (leader) {
      try {
        const report = await engine.tick();
        lastTick = { at: new Date(), ok: report.halted.length === 0 };
        if (report.discovered || report.advanced || report.errors) log.info("tick", { ...report });
      } catch (e) {
        lastTick = { at: new Date(), ok: false };
        log.error("tick failed", { error: e });
      }
      if (Date.now() - lastReconcile >= reconcileMs) {
        lastReconcile = Date.now();
        try {
          lastStatus = await computeStatus(source, lattice, binding);
          await publishStatus(statusPath, lastStatus);
          await recordSample(pool, lastStatus);
          if (lastStatus.alarms.length) log.critical("reconciliation alarm", { alarms: lastStatus.alarms });
        } catch (e) {
          log.warn("reconciliation unavailable", { error: e });
        }
      }
    }
    await new Promise((res) => setTimeout(res, tickMs));
  }
}

running = loop();
onShutdown(async (signal) => {
  log.info("shutting down", { signal });
  stopping = true;
  await running;
  server.close();
  leader?.release();
  await pool.end();
});
