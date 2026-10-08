import { PublicKey } from "@solana/web3.js";
import { toHex } from "@lattice/protocol/wire";
import { Attester } from "../attester/core.js";
import { SigningJournal } from "../attester/journal.js";
import { loadGuardianKey, loadMlDsaKey } from "../attester/keyfile.js";
import { attesterServer } from "../attester/server.js";
import { SpecLatticeAdapter } from "../chain/lattice.js";
import { SolanaSource } from "../chain/solana.js";
import { bindingFrom, loadEnv, readers } from "../env.js";
import { onShutdown } from "../health.js";
import { createLogger } from "../log.js";

/**
 * Guardian attester. Run one per guardian, on its own host, with its own RPC
 * providers, key file and journal. It never accepts message bytes from callers.
 */
const env = loadEnv();
const binding = bindingFrom(env);
const key = loadGuardianKey(process.env.GUARDIAN_KEY_FILE ?? "");
const mldsa = process.env.GUARDIAN_MLDSA_KEY_FILE ? loadMlDsaKey(process.env.GUARDIAN_MLDSA_KEY_FILE) : undefined;
const log = createLogger({ service: "lattice-attester", guardian: toHex(key.publicKey) });
const journalPath = process.env.GUARDIAN_JOURNAL_FILE;
if (!journalPath) throw new Error("GUARDIAN_JOURNAL_FILE is required");
const journal = new SigningJournal(journalPath);
const r = readers(env, log);
const attester = new Attester(
  key,
  binding,
  new SolanaSource(r.solana, binding.sourceProgramId),
  new SpecLatticeAdapter(r.lattice, new PublicKey(env.LATTICE_BRIDGE_PROGRAM_ID), binding.deploymentId),
  journal,
  log,
  mldsa,
);
const token = process.env.ATTESTER_TOKEN;
if (env.ENVIRONMENT === "production" && !token) throw new Error("ATTESTER_TOKEN is required in production");
const server = attesterServer(attester, log, token);
const port = Number(process.env.ATTESTER_PORT ?? 8788);
const host = process.env.ATTESTER_HOST ?? "127.0.0.1";
server.listen(port, host, () => log.info("attester listening", { host, port, journalEntries: journal.size() }));
onShutdown(async (signal) => {
  log.info("shutting down", { signal });
  await new Promise<void>((res) => server.close(() => res()));
  journal.close();
});
