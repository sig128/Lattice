import { INTERNAL_HTTP_RPC, TEST_ASSET_NOTICE } from "@lattice/config";
import { loadOrCreateKey } from "@lattice/bridge/local";
import { readState } from "@lattice/bridge/state";
import { getOrCreateAssociatedTokenAccount, mintToChecked } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { SlidingWindowLimiter, clientIp } from "../../../lib/rate-limit";

export const dynamic = "force-dynamic";
const perIp = new SlidingWindowLimiter(3, 600_000);

export async function POST(request: Request) {
  const decision = perIp.check(clientIp(request));
  if (!decision.allowed) {
    return Response.json(
      { error: `Test mint rate limit; retry in ${decision.retryAfterSeconds} s` },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
    );
  }
  try {
    const state = await readState();
    if (!state) return Response.json({ error: "Test bridge is not initialized on this network" }, { status: 503 });
    const body = await request.json() as { owner?: unknown };
    if (typeof body.owner !== "string") throw new Error("Owner public key is required");
    const owner = new PublicKey(body.owner);
    const connection = new Connection(INTERNAL_HTTP_RPC, "confirmed");
    if (await connection.getGenesisHash() !== state.genesisHash) throw new Error("Validator genesis mismatch");
    const operator = await loadOrCreateKey("local-operator");
    const mint = new PublicKey(state.sourceMint);
    const account = await getOrCreateAssociatedTokenAccount(connection, operator, mint, owner);
    const amount = 100n * 10n ** BigInt(state.decimals);
    const signature = await mintToChecked(connection, operator, mint, account.address, operator, amount, state.decimals);
    return Response.json({
      signature,
      account: account.address.toBase58(),
      amountAtomic: amount.toString(),
      warning: TEST_ASSET_NOTICE,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Test mint failed" }, { status: 400 });
  }
}
