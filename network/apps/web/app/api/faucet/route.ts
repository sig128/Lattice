import { INTERNAL_HTTP_RPC, NATIVE_GENESIS_HASH, TEST_ASSET_NOTICE } from "@lattice/config";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { SlidingWindowLimiter, clientIp, positiveIntEnv } from "../../lib/rate-limit";

export const dynamic = "force-dynamic";

const AMOUNT_LAMPORTS = LAMPORTS_PER_SOL;
const perIp = new SlidingWindowLimiter(
  positiveIntEnv("LATTICE_SITE_FAUCET_PER_IP", 1),
  positiveIntEnv("LATTICE_SITE_FAUCET_IP_WINDOW_SECONDS", 600) * 1_000,
);
const perRecipient = new SlidingWindowLimiter(
  1,
  positiveIntEnv("LATTICE_SITE_FAUCET_IP_WINDOW_SECONDS", 600) * 1_000,
);
const global = new SlidingWindowLimiter(positiveIntEnv("LATTICE_SITE_FAUCET_GLOBAL_PER_HOUR", 120), 3_600_000);

function limited(scope: string, retryAfterSeconds: number) {
  return Response.json(
    { error: `Faucet rate limit (${scope}); retry in ${retryAfterSeconds} s`, warning: TEST_ASSET_NOTICE },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export async function POST(request: Request) {
  let recipient: PublicKey;
  try {
    const body = await request.json() as { address?: unknown };
    if (typeof body.address !== "string") throw new Error("Address is required");
    recipient = new PublicKey(body.address);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
  if (!NATIVE_GENESIS_HASH) {
    return Response.json({ error: "Faucet is not configured for this network" }, { status: 403 });
  }

  const ip = clientIp(request);
  const address = recipient.toBase58();
  const ipDecision = perIp.check(ip);
  if (!ipDecision.allowed) return limited("per IP", ipDecision.retryAfterSeconds);
  const recipientDecision = perRecipient.check(address);
  if (!recipientDecision.allowed) {
    perIp.release(ip);
    return limited("per address", recipientDecision.retryAfterSeconds);
  }
  const globalDecision = global.check("global");
  if (!globalDecision.allowed) {
    perIp.release(ip);
    perRecipient.release(address);
    return limited("global", globalDecision.retryAfterSeconds);
  }

  try {
    // Same-host validator; the public edge never exposes requestAirdrop.
    const connection = new Connection(INTERNAL_HTTP_RPC, "confirmed");
    const genesis = await connection.getGenesisHash();
    if (genesis !== NATIVE_GENESIS_HASH) {
      throw Object.assign(new Error("Validator genesis mismatch"), { status: 409 });
    }
    const signature = await connection.requestAirdrop(recipient, AMOUNT_LAMPORTS);
    const latest = await connection.getLatestBlockhash("confirmed");
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmation.value.err) throw new Error("Airdrop transaction failed");
    return Response.json({
      signature,
      recipient: address,
      amountLamports: AMOUNT_LAMPORTS,
      genesisHash: genesis,
      warning: TEST_ASSET_NOTICE,
    });
  } catch (error) {
    perIp.release(ip);
    perRecipient.release(address);
    global.release("global");
    const status = (error as { status?: number }).status ?? 502;
    return Response.json({ error: error instanceof Error ? error.message : "Faucet request failed" }, { status });
  }
}
