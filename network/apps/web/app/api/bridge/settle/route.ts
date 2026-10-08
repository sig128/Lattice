import { createHash } from "node:crypto";
import { loadOrCreateKey } from "@lattice/bridge/local";
import { readReceipts, readState, saveReceipt } from "@lattice/bridge/state";
import {
  getOrCreateAssociatedTokenAccount,
  mintToChecked,
  transferChecked,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";
const inflight = new Set<string>();

async function finalizedTransaction(connection: Connection, signature: string) {
  for (let attempt = 0; attempt < 35; attempt++) {
    const transaction = await connection.getParsedTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction) return transaction;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Source transaction did not reach finalized commitment in time");
}

function tokenAmount(
  balances: readonly { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null | undefined,
  predicate: (balance: { accountIndex: number; mint: string; owner?: string }) => boolean,
) {
  const balance = balances?.find(predicate);
  return balance ? BigInt(balance.uiTokenAmount.amount) : 0n;
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Receipt ID is required" }, { status: 400 });
  const receipt = (await readReceipts()).find((item) => item.id === id);
  return receipt ? Response.json(receipt) : Response.json({ error: "Receipt not found" }, { status: 404 });
}

export async function POST(request: Request) {
  let sourceSignature = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    const direction = body.direction;
    if (direction !== "deposit" && direction !== "redemption") throw new Error("Invalid bridge direction");
    if (typeof body.owner !== "string") throw new Error("Owner is required");
    if (typeof body.amountAtomic !== "string" || !/^[1-9][0-9]*$/.test(body.amountAtomic)) throw new Error("Positive atomic amount is required");
    if (typeof body.sourceSignature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(body.sourceSignature)) throw new Error("Valid source signature is required");
    sourceSignature = body.sourceSignature;
    const amount = BigInt(body.amountAtomic);
    if (amount > 1_000_000n * 10n ** 9n) throw new Error("Amount exceeds local bridge limit");
    const owner = new PublicKey(body.owner);
    const existing = (await readReceipts()).find((item) => item.sourceSignature === sourceSignature);
    if (existing) return Response.json(existing);
    if (inflight.has(sourceSignature)) return Response.json({ error: "Receipt is already processing" }, { status: 409 });
    inflight.add(sourceSignature);

    const state = await readState();
    if (!state) throw new Error("Local bridge is not initialized");
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    if (await connection.getGenesisHash() !== state.genesisHash) throw new Error("Local genesis mismatch");
    const transaction = await finalizedTransaction(connection, sourceSignature);
    if (transaction.meta?.err) throw new Error("Source transaction failed");
    const keys = transaction.transaction.message.accountKeys.map((item) => item.pubkey.toBase58());

    if (direction === "deposit") {
      const vaultIndex = keys.indexOf(state.vaultAccount);
      if (vaultIndex < 0) throw new Error("Deposit did not target the configured vault");
      const predicate = (balance: { accountIndex: number; mint: string }) =>
        balance.accountIndex === vaultIndex && balance.mint === state.sourceMint;
      const before = tokenAmount(transaction.meta?.preTokenBalances, predicate);
      const after = tokenAmount(transaction.meta?.postTokenBalances, predicate);
      if (after - before !== amount) throw new Error("Vault credited amount does not match receipt");
    } else {
      const predicate = (balance: { accountIndex: number; mint: string; owner?: string }) =>
        balance.mint === state.issuedMint && balance.owner === owner.toBase58();
      const before = tokenAmount(transaction.meta?.preTokenBalances, predicate);
      const after = tokenAmount(transaction.meta?.postTokenBalances, predicate);
      if (before - after !== amount) throw new Error("Burned amount does not match receipt");
    }

    const operator = await loadOrCreateKey("local-operator");
    const vaultAuthority = await loadOrCreateKey("local-vault-authority");
    let destinationSignature: string;
    if (direction === "deposit") {
      const destination = await getOrCreateAssociatedTokenAccount(connection, operator, new PublicKey(state.issuedMint), owner);
      destinationSignature = await mintToChecked(
        connection, operator, new PublicKey(state.issuedMint), destination.address,
        operator, amount, state.decimals,
      );
    } else {
      const destination = await getOrCreateAssociatedTokenAccount(connection, operator, new PublicKey(state.sourceMint), owner);
      destinationSignature = await transferChecked(
        connection, operator, new PublicKey(state.vaultAccount), new PublicKey(state.sourceMint),
        destination.address, vaultAuthority, amount, state.decimals,
      );
    }
    await finalizedTransaction(connection, destinationSignature);
    const receipt = await saveReceipt({
      id: createHash("sha256").update(`${state.deploymentId}:${direction}:${sourceSignature}`).digest("hex").slice(0, 24),
      direction,
      owner: owner.toBase58(),
      amountAtomic: amount.toString(),
      sourceSignature,
      destinationSignature,
      status: "completed",
      createdAt: new Date().toISOString(),
    });
    return Response.json(receipt);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Settlement failed" }, { status: 400 });
  } finally {
    if (sourceSignature) inflight.delete(sourceSignature);
  }
}
