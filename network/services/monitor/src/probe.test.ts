import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeEndpoint } from "./probe.js";

const servers: ReturnType<typeof createServer>[] = [];

async function rpcServer(handler: (method: string) => unknown) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { method } = JSON.parse(body) as { method: string };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handler(method)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("RPC probe", () => {
  it("rejects HTTP 200 JSON-RPC errors", async () => {
    const url = await rpcServer(() => ({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } }));
    const result = await probeEndpoint(url, undefined, "expected", 500);
    expect(result.httpStatus).toBe("unavailable");
    expect(result.httpReason).toContain("JSON-RPC");
  });

  it("rejects a responsive endpoint on the wrong genesis", async () => {
    const url = await rpcServer(() => ({ jsonrpc: "2.0", id: 1, result: "wrong-genesis" }));
    const result = await probeEndpoint(url, undefined, "expected", 500);
    expect(result.httpStatus).toBe("unavailable");
    expect(result.httpReason).toBe("Genesis hash mismatch");
  });

  it("requires slot and freshness responses for operational status", async () => {
    const url = await rpcServer((method) => ({
      jsonrpc: "2.0",
      id: 1,
      result: method === "getGenesisHash" ? "expected" : method === "getSlot" ? 17 : method === "getLatestBlockhash" ? { value: { blockhash: "x" } } : method === "getHealth" ? "ok" : { "solana-core": "test" },
    }));
    const result = await probeEndpoint(url, undefined, "expected", 500);
    expect(result.httpStatus).toBe("operational");
    expect(result.slot).toBe(17);
  });
});
