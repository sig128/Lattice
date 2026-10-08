import { INTERNAL_HTTP_RPC, NATIVE_GENESIS_HASH } from "@lattice/config";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { address?: unknown };
    if (typeof body.address !== "string") throw new Error("Address is required");
    const recipient = new PublicKey(body.address);
    if (!NATIVE_GENESIS_HASH) {
      return Response.json({ error: "Faucet is not configured for this network" }, { status: 403 });
    }
    // Same-host validator; the public edge never exposes requestAirdrop.
    const connection = new Connection(INTERNAL_HTTP_RPC, "confirmed");
    const genesis = await connection.getGenesisHash();
    if (genesis !== NATIVE_GENESIS_HASH) {
      return Response.json({ error: "Validator genesis mismatch" }, { status: 409 });
    }
    const signature = await connection.requestAirdrop(recipient, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, "confirmed");
    return Response.json({
      signature,
      amountLamports: LAMPORTS_PER_SOL,
      warning: "Unbacked test units only",
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Faucet request failed" }, { status: 400 });
  }
}
