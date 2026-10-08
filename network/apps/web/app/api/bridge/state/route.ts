import { INTERNAL_HTTP_RPC, TEST_ASSET_NOTICE } from "@lattice/config";
import { readSamples, readState } from "@lattice/bridge/state";
import { getAccount, getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { reconcile } from "@lattice/protocol";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await readState();
  if (!state) return Response.json({ error: "Test bridge is not initialized on this network" }, { status: 503 });
  const connection = new Connection(INTERNAL_HTTP_RPC, "finalized");
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
    warning: TEST_ASSET_NOTICE,
  }, { headers: { "Cache-Control": "no-store" } });
}
