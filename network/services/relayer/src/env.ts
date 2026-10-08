import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { deploymentId } from "@lattice/protocol/wire";
import type { Binding } from "./chain/types.js";
import { QuorumReader, type Endpoint } from "./rpc/quorum.js";
import type { Logger } from "./log.js";

const list = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().url()).min(1));

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

/**
 * Environment shared by relayer, attester and reconciler. There is no default
 * mint, program, or genesis: every binding value must be supplied explicitly.
 */
export const envSchema = z.object({
  DEPLOYMENT_LABEL: z.string().min(1),
  SOURCE_PROGRAM_ID: base58,
  SOURCE_MINT: base58,
  SOURCE_DECIMALS: z.coerce.number().int().min(0).max(9),
  SOLANA_GENESIS_HASH: base58,
  LATTICE_GENESIS_HASH: base58,
  LATTICE_BRIDGE_PROGRAM_ID: base58,
  SOLANA_RPC_URLS: list,
  LATTICE_RPC_URLS: list,
  SOLANA_RPC_QUORUM: z.coerce.number().int().min(1).default(2),
  LATTICE_RPC_QUORUM: z.coerce.number().int().min(1).default(2),
  ENVIRONMENT: z.enum(["local-development", "testnet", "production"]).default("local-development"),
});
export type Env = z.infer<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const e = envSchema.parse(env);
  if (e.ENVIRONMENT === "production") {
    if (e.SOLANA_RPC_QUORUM < 2 || e.LATTICE_RPC_QUORUM < 2) throw new Error("production requires an RPC quorum of at least 2 per chain");
    if (new Set(e.SOLANA_RPC_URLS.map((u) => new URL(u).host)).size < e.SOLANA_RPC_QUORUM) {
      throw new Error("production Solana RPC quorum must use distinct hosts");
    }
    if (new Set(e.LATTICE_RPC_URLS.map((u) => new URL(u).host)).size < e.LATTICE_RPC_QUORUM) {
      throw new Error("production Lattice RPC quorum must use distinct hosts");
    }
  }
  return e;
}

export function bindingFrom(e: Env): Binding {
  return {
    deploymentId: deploymentId(e.DEPLOYMENT_LABEL),
    solanaGenesisHash: new PublicKey(e.SOLANA_GENESIS_HASH).toBytes(),
    latticeGenesisHash: new PublicKey(e.LATTICE_GENESIS_HASH).toBytes(),
    sourceProgramId: new PublicKey(e.SOURCE_PROGRAM_ID),
    sourceMint: new PublicKey(e.SOURCE_MINT),
    sourceDecimals: e.SOURCE_DECIMALS,
  };
}

function endpoints(urls: string[]): Endpoint[] {
  return urls.map((u, i) => ({ label: `${new URL(u).host}#${i}`, rpc: new Connection(u, "finalized") }));
}

export function readers(e: Env, log: Logger) {
  return {
    solana: new QuorumReader("solana", endpoints(e.SOLANA_RPC_URLS), e.SOLANA_RPC_QUORUM, e.SOLANA_GENESIS_HASH, log),
    lattice: new QuorumReader("lattice", endpoints(e.LATTICE_RPC_URLS), e.LATTICE_RPC_QUORUM, e.LATTICE_GENESIS_HASH, log),
  };
}

/** Fee-payer key for submissions. It pays fees and rent only and controls no bridge funds. */
export function loadFeePayer(path: string | undefined): Keypair {
  if (!path) throw new Error("RELAYER_FEE_PAYER_FILE is required");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}
