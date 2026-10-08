import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { TokenBuckets, classifyRpc, createGateway, loadConfig } from "./rpc-gateway.mjs";

let rpcUpstream;
let wsUpstream;
let webUpstream;
let gateway;
let base;
const seen = { rpc: [], web: [] };
const upstreamSockets = new Set();

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

before(async () => {
  rpcUpstream = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return res.end("ok");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.rpc.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
    });
  });
  webUpstream = http.createServer((req, res) => {
    seen.web.push({ method: req.method, url: req.url, xff: req.headers["x-forwarded-for"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  wsUpstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.once("data", () => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
      socket.on("data", (chunk) => socket.write(chunk));
    });
  });
  const [rpcPort, webPort, wsPort] = await Promise.all([listen(rpcUpstream), listen(webUpstream), listen(wsUpstream)]);
  gateway = createGateway({
    quiet: true,
    upstreamRpc: `http://127.0.0.1:${rpcPort}`,
    upstreamWeb: `http://127.0.0.1:${webPort}`,
    upstreamWs: `127.0.0.1:${wsPort}`,
    rpcPerIp: { capacity: 5, perSecond: 0.001 },
    wsPerIpConnections: 2,
    wsUpgrades: { capacity: 100, perSecond: 1 },
    wsClientBytes: { capacity: 1024, perSecond: 1 },
  });
  base = `http://127.0.0.1:${await listen(gateway.server)}`;
});

after(() => {
  for (const server of [gateway.server, rpcUpstream, webUpstream, wsUpstream]) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const socket of upstreamSockets) socket.destroy();
});

function rpc(body, ip = "203.0.113.1") {
  return fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lattice-client-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function openWs(ip) {
  return new Promise((resolve) => {
    const socket = net.connect(new URL(base).port, "127.0.0.1", () => {
      socket.write([
        "GET /ws HTTP/1.1",
        "host: example",
        "upgrade: websocket",
        "connection: Upgrade",
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version: 13",
        `x-lattice-client-ip: ${ip}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.once("data", (chunk) => resolve({ socket, status: Number(chunk.toString().split(" ")[1]) }));
  });
}

test("forwards allowlisted methods and adds CORS", async () => {
  const response = await rpc({ jsonrpc: "2.0", id: 1, method: "getSlot" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: 42 });
  assert.equal(seen.rpc.at(-1).method, "getSlot");
});

test("blocks requestAirdrop and unknown methods without reaching the validator", async () => {
  const before = seen.rpc.length;
  const airdrop = await rpc({ jsonrpc: "2.0", id: 7, method: "requestAirdrop", params: ["x", 1] }, "203.0.113.2");
  assert.equal(airdrop.status, 403);
  const body = await airdrop.json();
  assert.equal(body.id, 7);
  assert.match(body.error.message, /faucet/);
  const batch = await rpc([
    { jsonrpc: "2.0", id: 1, method: "getSlot" },
    { jsonrpc: "2.0", id: 2, method: "getProgramAccounts" },
  ], "203.0.113.2");
  assert.equal(batch.status, 403);
  assert.equal((await batch.json()).length, 2);
  assert.equal(seen.rpc.length, before);
});

test("rejects malformed, oversized, and over-wide requests", async () => {
  assert.equal((await rpc("{not json", "203.0.113.3")).status, 400);
  const wide = Array.from({ length: 21 }, (_, id) => ({ jsonrpc: "2.0", id, method: "getSlot" }));
  assert.equal((await rpc(wide, "203.0.113.3")).status, 400);
  const huge = await rpc({ jsonrpc: "2.0", id: 1, method: "getSlot", params: ["x".repeat(70 * 1024)] }, "203.0.113.3");
  assert.equal(huge.status, 413);
  const get = await fetch(`${base}/rpc`);
  assert.equal(get.status, 405);
});

test("rate-limits per client IP", async () => {
  const statuses = [];
  for (let index = 0; index < 7; index++) {
    statuses.push((await rpc({ jsonrpc: "2.0", id: index, method: "getSlot" }, "198.51.100.9")).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "getSlot" }, "198.51.100.10")).status, 200);
});

test("faucet is limited to one request per IP per interval", async () => {
  const first = await fetch(`${base}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lattice-client-ip": "192.0.2.50" },
    body: JSON.stringify({ address: "x" }),
  });
  assert.equal(first.status, 200);
  assert.equal(seen.web.at(-1).xff, "192.0.2.50");
  const second = await fetch(`${base}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lattice-client-ip": "192.0.2.50" },
    body: JSON.stringify({ address: "x" }),
  });
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("retry-after")) > 0);
});

test("bridge mutations are disabled by default", async () => {
  const response = await fetch(`${base}/api/bridge/test-mint`, { method: "POST", body: "{}" });
  assert.equal(response.status, 403);
});

test("caps concurrent WebSockets per IP and proxies frames", async () => {
  const first = await openWs("192.0.2.77");
  const second = await openWs("192.0.2.77");
  const third = await openWs("192.0.2.77");
  assert.equal(first.status, 101);
  assert.equal(second.status, 101);
  assert.equal(third.status, 429);
  const echoed = new Promise((resolve) => first.socket.once("data", (chunk) => resolve(chunk.toString())));
  first.socket.write("ping");
  assert.equal(await echoed, "ping");
  const closed = new Promise((resolve) => second.socket.once("close", resolve));
  second.socket.write(Buffer.alloc(2048));
  await closed;
  first.socket.destroy();
  third.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(gateway.connections().total, 0);
  assert.equal([...upstreamSockets].filter((socket) => !socket.destroyed).length, 0);
  assert.equal((await openWs("192.0.2.77")).status, 101);
});

test("token buckets refill over time", () => {
  const buckets = new TokenBuckets({ capacity: 2, perSecond: 1 });
  assert.equal(buckets.take("a", 1, 0), true);
  assert.equal(buckets.take("a", 1, 0), true);
  assert.equal(buckets.take("a", 1, 0), false);
  assert.equal(buckets.take("a", 1, 1000), true);
});

test("heavy methods are opt-in", () => {
  const cfg = loadConfig({});
  assert.ok(classifyRpc({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts" }, cfg).denied);
  const allowed = classifyRpc({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts" }, { ...cfg, allowHeavyMethods: true });
  assert.equal(allowed.cost, cfg.heavyCost);
});
