import { createServer, type Server } from "node:http";

export interface HealthSource {
  /** Liveness details; never secrets. */
  live(): Record<string, unknown>;
  /** Readiness: DB reachable, recent successful tick, RPC quorum available. */
  ready(): Promise<{ ok: boolean; detail: Record<string, unknown> }>;
  status(): unknown | null;
}

export function healthServer(src: HealthSource): Server {
  return createServer(async (req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    };
    if (req.method !== "GET") return reply(405, { error: "method not allowed" });
    if (req.url === "/healthz") return reply(200, { ok: true, ...src.live() });
    if (req.url === "/readyz") {
      const r = await src.ready().catch((e: Error) => ({ ok: false, detail: { error: e.message } }));
      return reply(r.ok ? 200 : 503, r);
    }
    if (req.url === "/status") {
      const s = src.status();
      return s ? reply(200, s) : reply(503, { error: "no reconciliation sample yet" });
    }
    return reply(404, { error: "not found" });
  });
}

/** Resolves when SIGINT/SIGTERM arrives; runs `cleanup` once. */
export function onShutdown(cleanup: (signal: string) => Promise<void>): void {
  let done = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (done) return;
      done = true;
      cleanup(sig).then(
        () => process.exit(0),
        () => process.exit(1),
      );
      setTimeout(() => process.exit(1), 30_000).unref();
    });
  }
}
