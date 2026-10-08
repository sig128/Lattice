import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { InvalidEvent } from "../messages.js";
import { InsufficientQuorum, RpcDisagreement } from "../rpc/quorum.js";
import type { Logger } from "../log.js";
import { BindingMismatch, NotAGuardian, NotFinalized, type Attester } from "./core.js";
import { Equivocation } from "./journal.js";

const requestSchema = z.object({
  direction: z.enum(["deposit", "withdrawal"]),
  nonce: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
});

async function body(req: IncomingMessage, limit = 4096): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function status(e: unknown): number {
  if (e instanceof NotFinalized) return 425;
  if (e instanceof Equivocation) return 409;
  if (e instanceof InvalidEvent || e instanceof BindingMismatch) return 422;
  if (e instanceof NotAGuardian) return 403;
  if (e instanceof InsufficientQuorum || e instanceof RpcDisagreement) return 503;
  return 500;
}

export function attesterServer(attester: Attester, log: Logger, token?: string): Server {
  const expected = token ? Buffer.from(`Bearer ${token}`) : null;
  return createServer(async (req, res) => {
    const reply = (code: number, payload: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    };
    try {
      if (req.method === "GET" && req.url === "/healthz") return reply(200, { ok: true, guardian: Buffer.from(attester.publicKey).toString("hex") });
      if (req.method !== "POST" || req.url !== "/v1/attest") return reply(404, { error: "not found" });
      if (expected) {
        const got = Buffer.from(req.headers.authorization ?? "");
        if (got.length !== expected.length || !timingSafeEqual(got, expected)) return reply(401, { error: "unauthorized" });
      }
      const parsed = requestSchema.safeParse(JSON.parse(await body(req)));
      if (!parsed.success) return reply(400, { error: "invalid request" });
      const out = await attester.attest(parsed.data.direction, BigInt(parsed.data.nonce));
      return reply(200, out);
    } catch (e) {
      const code = status(e);
      const level = code === 409 || code === 422 ? "critical" : code >= 500 ? "error" : "info";
      log[level]("attestation refused", { code, error: e });
      return reply(code, { error: (e as Error).name, message: (e as Error).message });
    }
  });
}
