// Dependency-free network identity, safe to import from client components.
// NEXT_PUBLIC_* values are inlined at build time, so every reference below must
// stay a literal `process.env.NEXT_PUBLIC_…` member access.

export type NativeEnvironment = "local-development" | "testnet";

export const LOCAL_DEVELOPMENT_GENESIS = "G9818341AwzwpDqHoh3uqy2hS8AkM1d9WCYbaX6YcVRU";
const LOCAL_HTTP_RPC = "http://127.0.0.1:8899";
const LOCAL_WS_RPC = "ws://127.0.0.1:8900";

function parseEnvironment(value: string | undefined): NativeEnvironment {
  const environment = value || "local-development";
  // "production" is deliberately not selectable through the environment.
  if (environment !== "local-development" && environment !== "testnet") {
    throw new Error(`Unsupported NEXT_PUBLIC_LATTICE_ENVIRONMENT: ${environment}`);
  }
  return environment;
}

export const NATIVE_ENVIRONMENT: NativeEnvironment = parseEnvironment(process.env.NEXT_PUBLIC_LATTICE_ENVIRONMENT);
export const IS_TESTNET = NATIVE_ENVIRONMENT === "testnet";
export const NATIVE_ENVIRONMENT_LABEL = IS_TESTNET ? "Testnet" : "Local development";
export const NATIVE_GENESIS_HASH: string | null = IS_TESTNET
  ? process.env.NEXT_PUBLIC_NATIVE_GENESIS_HASH || null
  : LOCAL_DEVELOPMENT_GENESIS;
export const PUBLIC_HTTP_RPC = process.env.NEXT_PUBLIC_NATIVE_HTTP_RPC || LOCAL_HTTP_RPC;
export const PUBLIC_WS_RPC = process.env.NEXT_PUBLIC_NATIVE_WS_RPC || LOCAL_WS_RPC;
// Server-side address of the validator on the same host; never sent to browsers.
export const INTERNAL_HTTP_RPC = process.env.LATTICE_INTERNAL_HTTP_RPC || LOCAL_HTTP_RPC;
// Shown wherever test units are dispensed or bridged.
export const TEST_ASSET_NOTICE = IS_TESTNET
  ? "Testnet · unbacked test units · never use for real funds"
  : "Local development · unbacked test units · never use for real funds";
export const INTERNAL_WS_RPC = process.env.LATTICE_INTERNAL_WS_RPC || LOCAL_WS_RPC;
