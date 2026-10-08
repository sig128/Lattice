import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DATA_DIR = resolve(ROOT, "services/bridge/data");
export const KEY_DIR = resolve(ROOT, "keys");
export const STATE_PATH = resolve(DATA_DIR, "local-state.json");
export const SAMPLES_PATH = resolve(DATA_DIR, "samples.json");
export const RECEIPTS_PATH = resolve(DATA_DIR, "receipts.json");

export interface LocalBridgeState {
  schemaVersion: 1;
  genesisHash: string;
  deploymentId: string;
  sourceMint: string;
  issuedMint: string;
  sourceOwnerAccount: string;
  vaultAccount: string;
  issuedOwnerAccount: string;
  operator: string;
  decimals: number;
  setupTransactions: string[];
}

export interface BridgeSample {
  sequence: number;
  observedAt: string;
  slot: number;
  reservesAtomic: string;
  issuedAtomic: string;
  pendingDepositsAtomic: string;
  pendingWithdrawalsAtomic: string;
  liabilitiesAtomic: string;
  coverageBps: string | null;
  label: string;
  trigger: string;
  transactionSignatures: string[];
}

export interface LocalBridgeReceipt {
  id: string;
  direction: "deposit" | "redemption";
  owner: string;
  amountAtomic: string;
  sourceSignature: string;
  destinationSignature: string;
  status: "completed";
  createdAt: string;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readState() {
  return readJson<LocalBridgeState>(STATE_PATH);
}

export async function readSamples() {
  return (await readJson<BridgeSample[]>(SAMPLES_PATH)) ?? [];
}

export async function readReceipts() {
  return (await readJson<LocalBridgeReceipt[]>(RECEIPTS_PATH)) ?? [];
}

export async function saveReceipt(receipt: LocalBridgeReceipt) {
  const receipts = await readReceipts();
  const existing = receipts.find((item) => item.id === receipt.id || item.sourceSignature === receipt.sourceSignature);
  if (existing) return existing;
  receipts.push(receipt);
  await writeJsonAtomic(RECEIPTS_PATH, receipts.slice(-1_000));
  return receipt;
}

export async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeState(state: LocalBridgeState) {
  await writeJsonAtomic(STATE_PATH, state);
}

export async function appendSample(sample: Omit<BridgeSample, "sequence">) {
  const samples = await readSamples();
  samples.push({ ...sample, sequence: samples.length });
  await writeJsonAtomic(SAMPLES_PATH, samples.slice(-512));
}
