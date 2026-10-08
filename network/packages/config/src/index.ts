import { z } from "zod";
import { IS_TESTNET, NATIVE_ENVIRONMENT, NATIVE_GENESIS_HASH, PUBLIC_HTTP_RPC, PUBLIC_WS_RPC } from "./network";

export const evidenceStateSchema = z.enum([
  "unconfigured",
  "local-development",
  "testnet",
  "experimental",
  "operational",
  "degraded",
  "paused",
  "unavailable",
  "unknown",
]);

const endpointSchema = z.object({
  label: z.string().min(1),
  environment: z.enum(["local-development", "testnet", "production"]),
  httpUrl: z.string().url(),
  websocketUrl: z.string().url().optional(),
  expectedGenesisHash: z.string().min(1).nullable(),
  capabilities: z.array(z.string()),
  rateLimit: z.string(),
});

export const deploymentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    environment: z.enum(["local-development", "testnet", "production"]),
    nativeName: z.string().min(1),
    nativeSymbol: z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/),
    nativeDecimals: z.number().int().min(0).max(18),
  }),
  source: z.object({
    cluster: z.enum(["mainnet-beta", "devnet", "testnet", "localnet"]),
    expectedGenesisHash: z.string().min(1),
    mint: z.string().nullable(),
    tokenProgram: z.string().nullable(),
    decimals: z.number().int().min(0).max(18).nullable(),
    identity: z.object({
      name: z.string(),
      symbol: z.string(),
      imageUrl: z.string().url().nullable(),
    }),
    provenance: z.object({
      state: z.enum(["unverified", "verified"]),
      evidenceUrl: z.string().url().nullable(),
      checkedAt: z.string().datetime().nullable(),
    }),
    bridgeProgram: z.string().nullable(),
    vaultTokenAccount: z.string().nullable(),
  }),
  destination: z.object({
    genesisHash: z.string().nullable(),
    bridgeDeploymentId: z.string().nullable(),
  }),
  rpc: z.array(endpointSchema),
  evidence: z.object({
    network: evidenceStateSchema,
    rpc: evidenceStateSchema,
    deposits: evidenceStateSchema,
    withdrawals: evidenceStateSchema,
    backing: evidenceStateSchema,
    quantumSecurity: evidenceStateSchema,
    securityReviewUrl: z.string().url().nullable(),
  }),
});

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;

export const LOCAL_TEST_MINT = "So11111111111111111111111111111111111111112";
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export * from "./network";
const isTestnet = IS_TESTNET;

export const defaultConfig: DeploymentConfig = deploymentConfigSchema.parse({
  schemaVersion: 1,
  project: {
    name: "Lattice",
    environment: NATIVE_ENVIRONMENT,
    nativeName: "Lattice Native",
    nativeSymbol: "LAT",
    nativeDecimals: 9,
  },
  source: {
    cluster: "mainnet-beta",
    expectedGenesisHash: SOLANA_MAINNET_GENESIS,
    mint: null,
    tokenProgram: null,
    decimals: null,
    identity: {
      name: "Production source token",
      symbol: "UNCONFIGURED",
      imageUrl: null,
    },
    provenance: {
      state: "unverified",
      evidenceUrl: null,
      checkedAt: null,
    },
    bridgeProgram: null,
    vaultTokenAccount: null,
  },
  destination: {
    genesisHash: NATIVE_GENESIS_HASH,
    bridgeDeploymentId: isTestnet ? "lattice-testnet-bridge-v1" : "lattice-local-bridge-v1",
  },
  rpc: [
    {
      label: isTestnet ? "Lattice public testnet" : "Local validator",
      environment: NATIVE_ENVIRONMENT,
      httpUrl: PUBLIC_HTTP_RPC,
      websocketUrl: PUBLIC_WS_RPC,
      expectedGenesisHash: NATIVE_GENESIS_HASH,
      capabilities: isTestnet
        ? ["getGenesisHash", "getHealth", "getSlot", "getVersion", "getLatestBlockhash", "sendTransaction"]
        : ["getGenesisHash", "getHealth", "getSlot", "getVersion", "getLatestBlockhash", "requestAirdrop"],
      rateLimit: isTestnet
        ? "Per-IP edge limits; requestAirdrop is blocked (use the site faucet)"
        : "Local machine only",
    },
  ],
  evidence: {
    network: NATIVE_ENVIRONMENT,
    rpc: "operational",
    deposits: "unconfigured",
    withdrawals: "unconfigured",
    backing: "unconfigured",
    quantumSecurity: "experimental",
    securityReviewUrl: null,
  },
});

export function withSourceMint(mint: string | undefined): DeploymentConfig {
  if (!mint) return defaultConfig;
  return deploymentConfigSchema.parse({
    ...defaultConfig,
    source: { ...defaultConfig.source, mint },
  });
}

export const publicConfig = withSourceMint(process.env.NEXT_PUBLIC_SOURCE_TOKEN_MINT);
