import { publicConfig } from "@lattice/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      schemaVersion: publicConfig.schemaVersion,
      generatedAt: new Date().toISOString(),
      project: publicConfig.project,
      source: {
        cluster: publicConfig.source.cluster,
        expectedGenesisHash: publicConfig.source.expectedGenesisHash,
        mint: publicConfig.source.mint,
        tokenProgram: publicConfig.source.tokenProgram,
        decimals: publicConfig.source.decimals,
        provenance: publicConfig.source.provenance,
      },
      destination: publicConfig.destination,
      rpc: publicConfig.rpc,
      capabilities: {
        nativeTransfers: "pending",
        programDeployment: "pending",
        websocketSubscriptions: "pending",
        bridgeDeposits: "unconfigured",
        bridgeWithdrawals: "unconfigured",
        postQuantumAuthorization: "pending",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
