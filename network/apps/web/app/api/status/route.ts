import { publicConfig } from "@lattice/config";
import { probeEndpoint } from "@lattice/monitor/probe";

export const dynamic = "force-dynamic";

export async function GET() {
  const endpoints = await Promise.all(publicConfig.rpc.map(async (endpoint) => ({
    ...endpoint,
    observation: await probeEndpoint(
      endpoint.httpUrl,
      endpoint.websocketUrl,
      endpoint.expectedGenesisHash,
      2_500,
    ),
  })));
  return Response.json(
    {
      generatedAt: new Date().toISOString(),
      monitoringApi: { status: "operational", source: "web process" },
      chain: {
        status: endpoints.some(({ observation }) => observation.httpStatus === "operational") ? "operational" : "unavailable",
        reason: "Derived from bounded allowlisted endpoint probes",
      },
      bridge: {
        deposits: publicConfig.evidence.deposits,
        withdrawals: publicConfig.evidence.withdrawals,
        backing: publicConfig.evidence.backing,
      },
      endpoints: endpoints.map(({ observation, ...endpoint }) => ({
        ...endpoint,
        status: observation.httpStatus,
        reason: observation.httpReason,
        observedGenesisHash: observation.genesisHash,
        finalizedSlot: observation.slot,
        latencyMs: observation.latencyMs,
        lastCheckedAt: observation.checkedAt,
        websocketStatus: observation.websocketStatus,
        availabilityHistory: "Collecting history",
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
