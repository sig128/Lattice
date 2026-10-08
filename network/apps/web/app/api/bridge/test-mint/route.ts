import { loadOrCreateKey } from "@lattice/bridge/local";
import { readState } from "@lattice/bridge/state";
import { getOrCreateAssociatedTokenAccount, mintToChecked } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const state = await readState();
    if (!state) return Response.json({ error: "Local bridge is not initialized" }, { status: 503 });
    const body = await request.json() as { owner?: unknown };
    if (typeof body.owner !== "string") throw new Error("Owner public key is required");
    const owner = new PublicKey(body.owner);
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    if (await connection.getGenesisHash() !== state.genesisHash) throw new Error("Local genesis mismatch");
    const operator = await loadOrCreateKey("local-operator");
    const mint = new PublicKey(state.sourceMint);
    const account = await getOrCreateAssociatedTokenAccount(connection, operator, mint, owner);
    const amount = 100n * 10n ** BigInt(state.decimals);
    const signature = await mintToChecked(connection, operator, mint, account.address, operator, amount, state.decimals);
    return Response.json({
      signature,
      account: account.address.toBase58(),
      amountAtomic: amount.toString(),
      warning: "DEV ONLY · unbacked local test source tokens",
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Test mint failed" }, { status: 400 });
  }
}
