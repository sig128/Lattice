import WebSocket from "ws";

export interface RpcObservation {
  checkedAt: string;
  httpStatus: "operational" | "degraded" | "unavailable";
  httpReason: string;
  latencyMs: number | null;
  genesisHash: string | null;
  genesisMatches: boolean | null;
  health: string | null;
  slot: number | null;
  version: string | null;
  latestBlockhashAvailable: boolean;
  websocketStatus: "operational" | "unavailable" | "unknown";
  websocketReason: string;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown probe error";
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const detail = cause as { code?: string; message?: string };
    if (detail.code === "ECONNREFUSED") return `Connection refused (${detail.code})`;
    if (detail.code) return `${detail.message ?? error.message} (${detail.code})`;
  }
  if (error.name === "AbortError") return "Request timed out";
  return error.message;
}

async function rpc(
  url: string,
  method: string,
  signal: AbortSignal,
): Promise<{ value: unknown; latencyMs: number }> {
  const start = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    signal,
  });
  const latencyMs = Math.round(performance.now() - start);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) {
    throw new Error(`JSON-RPC ${body.error.code ?? "error"}: ${body.error.message ?? "unknown"}`);
  }
  if (!("result" in body)) throw new Error("Malformed JSON-RPC response");
  return { value: body.result, latencyMs };
}

async function probeWebsocket(url: string, timeoutMs: number): Promise<{
  status: RpcObservation["websocketStatus"];
  reason: string;
}> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ status: "unavailable", reason: "Subscription timed out" });
    }, timeoutMs);
    let subscribed = false;
    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
    });
    ws.on("message", (bytes) => {
      try {
        const message = JSON.parse(bytes.toString()) as JsonRpcResponse & { method?: string };
        if (message.id === 1 && typeof message.result === "number") subscribed = true;
        if (subscribed && message.method === "slotNotification") {
          clearTimeout(timer);
          ws.close();
          resolve({ status: "operational", reason: "Received slot subscription message" });
        }
      } catch {
        clearTimeout(timer);
        ws.terminate();
        resolve({ status: "unavailable", reason: "Malformed WebSocket message" });
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: "unavailable", reason: error.message });
    });
  });
}

export async function probeEndpoint(
  httpUrl: string,
  websocketUrl: string | undefined,
  expectedGenesisHash: string | null,
  timeoutMs: number,
): Promise<RpcObservation> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const genesis = await rpc(httpUrl, "getGenesisHash", controller.signal);
    const genesisHash = typeof genesis.value === "string" ? genesis.value : null;
    const genesisMatches = expectedGenesisHash ? genesisHash === expectedGenesisHash : null;
    if (expectedGenesisHash && !genesisMatches) {
      return {
        checkedAt, httpStatus: "unavailable", httpReason: "Genesis hash mismatch",
        latencyMs: genesis.latencyMs, genesisHash, genesisMatches, health: null, slot: null,
        version: null, latestBlockhashAvailable: false, websocketStatus: "unknown",
        websocketReason: "Skipped because HTTP endpoint is on the wrong network",
      };
    }
    const [healthResult, slotResult, versionResult, blockhashResult, websocket] = await Promise.allSettled([
      rpc(httpUrl, "getHealth", controller.signal),
      rpc(httpUrl, "getSlot", controller.signal),
      rpc(httpUrl, "getVersion", controller.signal),
      rpc(httpUrl, "getLatestBlockhash", controller.signal),
      websocketUrl ? probeWebsocket(websocketUrl, timeoutMs) : Promise.resolve({ status: "unknown" as const, reason: "Not configured" }),
    ]);
    const slot = slotResult.status === "fulfilled" && typeof slotResult.value.value === "number"
      ? slotResult.value.value : null;
    const health = healthResult.status === "fulfilled" && typeof healthResult.value.value === "string"
      ? healthResult.value.value : null;
    const versionValue = versionResult.status === "fulfilled" ? versionResult.value.value : null;
    const version = versionValue && typeof versionValue === "object" && "solana-core" in versionValue
      ? String(versionValue["solana-core"]) : null;
    const websocketValue = websocket.status === "fulfilled"
      ? websocket.value : { status: "unavailable" as const, reason: websocket.reason.message };
    const healthy = slot !== null && blockhashResult.status === "fulfilled";
    return {
      checkedAt,
      httpStatus: healthy ? "operational" : "degraded",
      httpReason: healthy ? "Identity and freshness checks passed" : "One or more freshness checks failed",
      latencyMs: genesis.latencyMs,
      genesisHash,
      genesisMatches,
      health,
      slot,
      version,
      latestBlockhashAvailable: blockhashResult.status === "fulfilled",
      websocketStatus: websocketValue.status,
      websocketReason: websocketValue.reason,
    };
  } catch (error) {
    return {
      checkedAt, httpStatus: "unavailable",
      httpReason: errorReason(error),
      latencyMs: null, genesisHash: null, genesisMatches: null, health: null, slot: null,
      version: null, latestBlockhashAvailable: false, websocketStatus: "unknown",
      websocketReason: "HTTP identity check did not complete",
    };
  } finally {
    clearTimeout(timer);
  }
}
