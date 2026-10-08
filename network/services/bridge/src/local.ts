import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type Commitment,
} from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
import { reconcile } from "@lattice/protocol";
import {
  KEY_DIR,
  appendSample,
  type LocalBridgeState,
} from "./state.js";

export const RPC_URL = "http://127.0.0.1:8899";
export const COMMITMENT: Commitment = "finalized";

export async function loadOrCreateKey(name: string): Promise<Keypair> {
  const path = `${KEY_DIR}/${name}.json`;
  try {
    const bytes = JSON.parse(await readFile(path, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pair = Keypair.generate();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify([...pair.secretKey]), { mode: 0o600 });
    return pair;
  }
}

export async function ensureFunding(connection: Connection, payer: Keypair) {
  const balance = await connection.getBalance(payer.publicKey, COMMITMENT);
  if (balance >= 5 * LAMPORTS_PER_SOL) return null;
  const signature = await connection.requestAirdrop(payer.publicKey, 20 * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash(COMMITMENT);
  await connection.confirmTransaction({ signature, ...latest }, COMMITMENT);
  return signature;
}

export async function observe(
  connection: Connection,
  state: LocalBridgeState,
  trigger: string,
  transactionSignatures: string[] = [],
) {
  const [vault, issuedMint, slot] = await Promise.all([
    getAccount(connection, new PublicKey(state.vaultAccount), COMMITMENT),
    getMint(connection, new PublicKey(state.issuedMint), COMMITMENT),
    connection.getSlot(COMMITMENT),
  ]);
  const accounting = reconcile({
    reserves: vault.amount,
    redeemableNativeSupply: issuedMint.supply,
    pendingDeposits: 0n,
    pendingWithdrawals: 0n,
    sourceWatermark: BigInt(slot),
    destinationWatermark: BigInt(slot),
    observedAt: new Date(),
    staleAfterMs: 60_000,
  });
  await appendSample({
    observedAt: new Date().toISOString(),
    slot,
    reservesAtomic: accounting.reserves.toString(),
    issuedAtomic: issuedMint.supply.toString(),
    pendingDepositsAtomic: "0",
    pendingWithdrawalsAtomic: "0",
    liabilitiesAtomic: accounting.liabilities.toString(),
    coverageBps: accounting.coverageBps?.toString() ?? null,
    label: accounting.label,
    trigger,
    transactionSignatures,
  });
  return accounting;
}
