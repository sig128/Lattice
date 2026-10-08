import { readSamples, readState } from "@lattice/bridge/state";
import { getAccount, getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { reconcile } from "@lattice/protocol";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await readState();
  if (!state) return Response.json({ error: "Local bridge is not initialized" }, { status: 503 });
  const connection = new Connection("http://127.0.0.1:8899", "finalized");
  const [vault, issued, slot, samples] = await Promise.all([
    getAccount(connection, new PublicKey(state.vaultAccount), "finalized"),
    getMint(connection, new PublicKey(state.issuedMint), "finalized"),
    connection.getSlot("finalized"),
    readSamples(),
  ]);
  const accounting = reconcile({
    reserves: vault.amount,
    redeemableNativeSupply: issued.supply,
    pendingDeposits: 0n,
    pendingWithdrawals: 0n,
    sourceWatermark: BigInt(slot),
    destinationWatermark: BigInt(slot),
    observedAt: new Date(),
    staleAfterMs: 60_000,
  });
  return Response.json({
    genesisHash: state.genesisHash,
    deploymentId: state.deploymentId,
    sourceMint: state.sourceMint,
    issuedMint: state.issuedMint,
    vaultAccount: state.vaultAccount,
    decimals: state.decimals,
    slot,
    reservesAtomic: accounting.reserves.toString(),
    liabilitiesAtomic: accounting.liabilities.toString(),
    coverage: accounting.label,
    sampleCount: samples.length,
    warning: "DEV ONLY · unbacked test assets · never use for real funds",
  }, { headers: { "Cache-Control": "no-store" } });
}
