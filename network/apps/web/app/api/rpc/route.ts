import { INTERNAL_HTTP_RPC, publicConfig } from "@lattice/config";
import { validateRpcRequest } from "./validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const rpcRequest = validateRpcRequest(await request.json());
    const endpoint = publicConfig.rpc[0];
    if (!endpoint || endpoint.environment === "production") {
      return Response.json({ error: "RPC is not configured" }, { status: 503 });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const started = performance.now();
    try {
      const response = await fetch(INTERNAL_HTTP_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...rpcRequest }),
        signal: controller.signal,
        cache: "no-store",
      });
      const payload = await response.json() as { result?: unknown; error?: unknown };
      if (!response.ok || payload.error) {
        return Response.json({ error: payload.error ?? `RPC HTTP ${response.status}` }, { status: 502 });
      }
      return Response.json({
        method: rpcRequest.method,
        result: payload.result,
        endpoint: endpoint.httpUrl,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
      }, { headers: { "Cache-Control": "no-store" } });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 },
    );
  }
}
