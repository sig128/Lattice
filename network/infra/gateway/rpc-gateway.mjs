#!/usr/bin/env node
// Lattice edge gateway. Sits between Caddy and the loopback-only validator and
// web app. Stock Caddy cannot inspect JSON-RPC bodies or rate-limit, so this
// process enforces: a JSON-RPC method allowlist (requestAirdrop is never
// public), batch and body limits, per-IP and global token buckets, WebSocket
// connection caps, and strict limits on the site's mutating API routes.
// Node standard library only; no dependencies to install or audit.
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const SAFE_METHODS = new Set([
  "getAccountInfo", "getBalance", "getBlock", "getBlockCommitment", "getBlockHeight",
  "getBlockProduction", "getBlockTime", "getBlocks", "getBlocksWithLimit", "getClusterNodes",
  "getEpochInfo", "getEpochSchedule", "getFeeForMessage", "getFirstAvailableBlock",
  "getGenesisHash", "getHealth", "getHighestSnapshotSlot", "getIdentity", "getInflationGovernor",
  "getInflationRate", "getInflationReward", "getLatestBlockhash", "getLeaderSchedule",
  "getMaxRetransmitSlot", "getMaxShredInsertSlot", "getMinimumBalanceForRentExemption",
  "getMultipleAccounts", "getRecentPerformanceSamples", "getRecentPrioritizationFees",
  "getSignatureStatuses", "getSignaturesForAddress", "getSlot", "getSlotLeader", "getSlotLeaders",
  "getStakeMinimumDelegation", "getTokenAccountBalance", "getTokenAccountsByDelegate",
  "getTokenAccountsByOwner", "getTokenLargestAccounts", "getTokenSupply", "getTransaction",
  "getTransactionCount", "getVersion", "getVoteAccounts", "isBlockhashValid", "minimumLedgerSlot",
  "sendTransaction", "simulateTransaction",
]);
const HEAVY_METHODS = new Set(["getProgramAccounts", "getLargestAccounts", "getSupply"]);
const BLOCKED_REASONS = {
  requestAirdrop: "requestAirdrop is not public; use the site's rate-limited faucet",
};

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(env = process.env) {
  const n = (name, fallback) => envNumber(env, name, fallback);
  return {
    listenHost: env.GATEWAY_HOST || "127.0.0.1",
    listenPort: n("GATEWAY_PORT", 8080),
    upstreamRpc: env.GATEWAY_UPSTREAM_RPC || "http://127.0.0.1:8899",
    upstreamWs: env.GATEWAY_UPSTREAM_WS || "127.0.0.1:8900",
    upstreamWeb: env.GATEWAY_UPSTREAM_WEB || "http://127.0.0.1:3000",
    allowHeavyMethods: env.GATEWAY_ALLOW_HEAVY_METHODS === "1",
    publicBridgeDemo: env.LATTICE_PUBLIC_BRIDGE_DEMO === "1",
    rpcMaxBodyBytes: n("GATEWAY_RPC_MAX_BODY_BYTES", 64 * 1024),
    rpcMaxBatch: n("GATEWAY_RPC_MAX_BATCH", 20),
    rpcTimeoutMs: n("GATEWAY_RPC_TIMEOUT_MS", 15_000),
    rpcPerIp: { capacity: n("GATEWAY_RPC_IP_BURST", 40), perSecond: n("GATEWAY_RPC_IP_RPS", 20) },
    rpcGlobal: { capacity: n("GATEWAY_RPC_GLOBAL_BURST", 800), perSecond: n("GATEWAY_RPC_GLOBAL_RPS", 400) },
    sendPerIp: { capacity: n("GATEWAY_SEND_IP_BURST", 10), perSecond: n("GATEWAY_SEND_IP_RPS", 5) },
    heavyCost: n("GATEWAY_HEAVY_COST", 20),
    wsPerIpConnections: n("GATEWAY_WS_IP_CONNECTIONS", 8),
    wsGlobalConnections: n("GATEWAY_WS_GLOBAL_CONNECTIONS", 512),
    wsUpgrades: { capacity: n("GATEWAY_WS_UPGRADE_BURST", 10), perSecond: n("GATEWAY_WS_UPGRADE_RPS", 1) },
    wsClientBytes: { capacity: n("GATEWAY_WS_CLIENT_BURST_BYTES", 64 * 1024), perSecond: n("GATEWAY_WS_CLIENT_BYTES_PER_SEC", 4 * 1024) },
    wsMaxLifetimeMs: n("GATEWAY_WS_MAX_LIFETIME_MS", 6 * 60 * 60 * 1000),
    webMaxBodyBytes: n("GATEWAY_WEB_MAX_BODY_BYTES", 16 * 1024),
    webTimeoutMs: n("GATEWAY_WEB_TIMEOUT_MS", 60_000),
    faucetPerIp: { capacity: 1, perSecond: 1 / n("GATEWAY_FAUCET_IP_INTERVAL_SEC", 600) },
    faucetGlobal: { capacity: n("GATEWAY_FAUCET_GLOBAL_PER_HOUR", 30), perSecond: n("GATEWAY_FAUCET_GLOBAL_PER_HOUR", 30) / 3600 },
    bridgePerIp: { capacity: 2, perSecond: 2 / 600 },
    bridgeGlobal: { capacity: 60, perSecond: 60 / 3600 },
    consolePerIp: { capacity: 10, perSecond: 2 },
    readPerIp: { capacity: 20, perSecond: 2 },
    maxTrackedKeys: n("GATEWAY_MAX_TRACKED_KEYS", 50_000),
  };
}

export class TokenBuckets {
  constructor({ capacity, perSecond }, maxKeys = 50_000) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }

  take(key, cost = 1, now = Date.now()) {
    if (!this.entries.has(key) && this.entries.size >= this.maxKeys) {
      this.sweep(now);
      if (this.entries.size >= this.maxKeys) key = "__overflow__";
    }
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { tokens: this.capacity, at: now };
      this.entries.set(key, entry);
    }
    entry.tokens = Math.min(this.capacity, entry.tokens + ((now - entry.at) / 1000) * this.perSecond);
    entry.at = now;
    if (entry.tokens < cost) return false;
    entry.tokens -= cost;
    return true;
  }

  retryAfterSeconds(key, cost = 1) {
    const entry = this.entries.get(key);
    if (!entry) return 1;
    return Math.max(1, Math.ceil((cost - entry.tokens) / this.perSecond));
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.tokens + ((now - entry.at) / 1000) * this.perSecond >= this.capacity) this.entries.delete(key);
    }
  }
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function clientIp(req) {
  const peer = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-lattice-client-ip"];
  if (isLoopback(peer) && typeof forwarded === "string" && net.isIP(forwarded.trim())) return forwarded.trim();
  return peer;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, solana-client",
  "access-control-max-age": "600",
};

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error("Request body too large"), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function classifyRpc(payload, cfg) {
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length === 0 || items.length > cfg.rpcMaxBatch) {
    return { error: rpcError(null, -32600, `Batch size must be between 1 and ${cfg.rpcMaxBatch}`) };
  }
  let cost = 0;
  let sends = 0;
  const denied = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.method !== "string") {
      return { error: rpcError(null, -32600, "Invalid JSON-RPC request") };
    }
    const { method } = item;
    if (SAFE_METHODS.has(method)) {
      cost += 1;
      if (method === "sendTransaction") sends += 1;
    } else if (HEAVY_METHODS.has(method) && cfg.allowHeavyMethods) {
      cost += cfg.heavyCost;
    } else {
      denied.push(item);
    }
  }
  if (denied.length > 0) {
    const reason = (method) => BLOCKED_REASONS[method] ?? `Method not allowed on the public RPC: ${method}`;
    const body = Array.isArray(payload)
      ? items.map((item) => denied.includes(item)
        ? rpcError(item.id, -32601, reason(item.method))
        : rpcError(item.id, -32600, "Batch rejected because it contains a blocked method"))
      : rpcError(payload.id, -32601, reason(payload.method));
    return { denied: body, methods: denied.map((item) => item.method) };
  }
  return { cost, sends };
}

function forward(target, req, res, { method, path, body, headers, timeoutMs, extraHeaders = {} }) {
  const url = new URL(path, target);
  const upstream = http.request(url, { method, headers, timeout: timeoutMs }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers, ...extraHeaders };
    delete responseHeaders.connection;
    delete responseHeaders["keep-alive"];
    delete responseHeaders["transfer-encoding"];
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) sendJson(res, 502, { error: "Upstream unavailable" }, extraHeaders);
    else res.destroy();
  });
  upstream.end(body);
}

export function createGateway(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const limiter = (spec) => new TokenBuckets(spec, cfg.maxTrackedKeys);
  const limits = {
    rpcIp: limiter(cfg.rpcPerIp),
    rpcGlobal: limiter(cfg.rpcGlobal),
    sendIp: limiter(cfg.sendPerIp),
    wsUpgrades: limiter(cfg.wsUpgrades),
    faucetIp: limiter(cfg.faucetPerIp),
    faucetGlobal: limiter(cfg.faucetGlobal),
    bridgeIp: limiter(cfg.bridgePerIp),
    bridgeGlobal: limiter(cfg.bridgeGlobal),
    consoleIp: limiter(cfg.consolePerIp),
    readIp: limiter(cfg.readPerIp),
  };
  const wsByIp = new Map();
  let wsTotal = 0;
  const stats = { rpcForwarded: 0, rpcDenied: 0, rateLimited: 0, wsOpened: 0, wsRejected: 0, webForwarded: 0 };
  const deniedSample = new Map();

  function limited(res, buckets, key, cost, headers = {}) {
    stats.rateLimited += 1;
    const retry = buckets.retryAfterSeconds(key, cost);
    sendJson(res, 429, rpcError(null, -32005, "Rate limit exceeded"), { "retry-after": String(retry), ...headers });
  }

  async function handleRpc(req, res, ip) {
    let raw;
    try {
      raw = await readBody(req, cfg.rpcMaxBodyBytes);
    } catch (error) {
      sendJson(res, error.status ?? 400, rpcError(null, -32600, error.message), CORS);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, rpcError(null, -32700, "Parse error"), CORS);
      return;
    }
    const verdict = classifyRpc(payload, cfg);
    if (verdict.error) {
      sendJson(res, 400, verdict.error, CORS);
      return;
    }
    if (verdict.denied) {
      stats.rpcDenied += 1;
      for (const method of verdict.methods) deniedSample.set(method, (deniedSample.get(method) ?? 0) + 1);
      sendJson(res, 403, verdict.denied, CORS);
      return;
    }
    if (!limits.rpcIp.take(ip, verdict.cost)) return limited(res, limits.rpcIp, ip, verdict.cost, CORS);
    if (!limits.rpcGlobal.take("global", verdict.cost)) return limited(res, limits.rpcGlobal, "global", verdict.cost, CORS);
    if (verdict.sends > 0 && !limits.sendIp.take(ip, verdict.sends)) {
      return limited(res, limits.sendIp, ip, verdict.sends, CORS);
    }
    stats.rpcForwarded += 1;
    forward(cfg.upstreamRpc, req, res, {
      method: "POST",
      path: "/",
      body: raw,
      headers: { "content-type": "application/json", "content-length": raw.length },
      timeoutMs: cfg.rpcTimeoutMs,
      extraHeaders: CORS,
    });
  }

  const webRoutes = [
    { path: "/api/faucet", methods: ["POST"], buckets: [["faucetIp", true], ["faucetGlobal", false]] },
    { path: "/api/bridge/test-mint", methods: ["POST"], bridge: true, buckets: [["bridgeIp", true], ["bridgeGlobal", false]] },
    { path: "/api/bridge/settle", methods: ["POST"], bridge: true, buckets: [["bridgeIp", true], ["bridgeGlobal", false]] },
    { path: "/api/bridge/state", methods: ["GET", "HEAD"], buckets: [["readIp", true]] },
    { path: "/api/rpc", methods: ["POST"], buckets: [["consoleIp", true]] },
  ];

  async function handleWeb(req, res, ip, route) {
    if (!route.methods.includes(req.method)) {
      sendJson(res, 405, { error: "Method not allowed" }, { allow: route.methods.join(", ") });
      return;
    }
    if (route.bridge && !cfg.publicBridgeDemo) {
      sendJson(res, 403, { error: "The bridge demonstration is not enabled on this public testnet" });
      return;
    }
    for (const [name, perIp] of route.buckets) {
      const key = perIp ? ip : "global";
      if (!limits[name].take(key)) return limited(res, limits[name], key, 1);
    }
    let body;
    try {
      body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, cfg.webMaxBodyBytes);
    } catch (error) {
      sendJson(res, error.status ?? 400, { error: error.message });
      return;
    }
    const headers = {
      "content-type": req.headers["content-type"] ?? "application/json",
      accept: req.headers.accept ?? "*/*",
      host: req.headers.host ?? "localhost",
      "x-forwarded-for": ip,
      "x-forwarded-proto": req.headers["x-forwarded-proto"] ?? "http",
    };
    if (body) headers["content-length"] = body.length;
    stats.webForwarded += 1;
    const url = new URL(req.url, "http://gateway.invalid");
    forward(cfg.upstreamWeb, req, res, {
      method: req.method,
      path: url.pathname + url.search,
      body,
      headers,
      timeoutMs: cfg.webTimeoutMs,
    });
  }

  function rejectUpgrade(socket, status, text) {
    stats.wsRejected += 1;
    socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`, () => socket.destroy());
  }

  function handleUpgrade(req, socket, head) {
    const path = new URL(req.url, "http://gateway.invalid").pathname;
    const ip = clientIp(req);
    if (path !== "/ws" && path !== "/ws/") return rejectUpgrade(socket, 404, "Not Found");
    if (req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    if (wsTotal >= cfg.wsGlobalConnections) return rejectUpgrade(socket, 503, "Service Unavailable");
    if ((wsByIp.get(ip) ?? 0) >= cfg.wsPerIpConnections) return rejectUpgrade(socket, 429, "Too Many Requests");
    if (!limits.wsUpgrades.take(ip)) return rejectUpgrade(socket, 429, "Too Many Requests");

    const [host, port] = cfg.upstreamWs.split(":");
    const upstream = net.connect(Number(port), host);
    const budget = new TokenBuckets(cfg.wsClientBytes, 1);
    wsTotal += 1;
    wsByIp.set(ip, (wsByIp.get(ip) ?? 0) + 1);
    stats.wsOpened += 1;
    let closed = false;
    const lifetime = setTimeout(() => close(), cfg.wsMaxLifetimeMs);
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(lifetime);
      wsTotal -= 1;
      const remaining = (wsByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) wsByIp.delete(ip);
      else wsByIp.set(ip, remaining);
      socket.destroy();
      upstream.destroy();
    }
    // HTTP server sockets allow half-open connections, so "close" alone never fires on client FIN.
    socket.on("end", close);
    socket.on("error", close);
    socket.on("close", close);
    upstream.on("end", close);
    upstream.on("error", () => {
      if (!socket.writableEnded && !closed) socket.write("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      close();
    });
    upstream.on("close", close);
    upstream.on("connect", () => {
      const forwardHeaders = [
        "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol",
      ];
      let request = `GET / HTTP/1.1\r\nhost: ${cfg.upstreamWs}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n`;
      for (const name of forwardHeaders) {
        const value = req.headers[name];
        if (typeof value === "string" && !/[\r\n]/.test(value)) request += `${name}: ${value}\r\n`;
      }
      upstream.write(`${request}\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.on("data", (chunk) => {
        if (!budget.take("conn", chunk.length)) {
          close();
          return;
        }
        if (!upstream.write(chunk)) {
          socket.pause();
          upstream.once("drain", () => socket.resume());
        }
      });
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gateway.invalid");
    const ip = clientIp(req);
    const path = url.pathname;
    if (path === "/healthz") return sendJson(res, 200, { ok: true, websockets: wsTotal });
    if (path === "/rpc" || path === "/rpc/") {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (req.method !== "POST") return sendJson(res, 405, rpcError(null, -32600, "Use HTTP POST for JSON-RPC"), { allow: "POST, OPTIONS", ...CORS });
      handleRpc(req, res, ip).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: "Gateway error" }); });
      return;
    }
    if (path === "/rpc/health" && (req.method === "GET" || req.method === "HEAD")) {
      if (!limits.readIp.take(ip)) return limited(res, limits.readIp, ip, 1, CORS);
      forward(cfg.upstreamRpc, req, res, { method: "GET", path: "/health", headers: {}, timeoutMs: 5_000, extraHeaders: CORS });
      return;
    }
    if (path === "/ws" || path === "/ws/") return sendJson(res, 426, { error: "WebSocket upgrade required" }, { upgrade: "websocket" });
    const route = webRoutes.find((candidate) => candidate.path === path);
    if (route) {
      handleWeb(req, res, ip, route).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: "Gateway error" }); });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  });
  server.on("upgrade", handleUpgrade);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  const sweeper = setInterval(() => {
    for (const buckets of Object.values(limits)) buckets.sweep();
    const active = Object.values(stats).some((value) => value > 0) || deniedSample.size > 0;
    if (active && !overrides.quiet) {
      console.log(JSON.stringify({
        level: "info",
        event: "gateway_stats",
        ...stats,
        websockets: wsTotal,
        deniedMethods: Object.fromEntries(deniedSample),
      }));
    }
    for (const key of Object.keys(stats)) stats[key] = 0;
    deniedSample.clear();
  }, 60_000);
  sweeper.unref();
  server.on("close", () => clearInterval(sweeper));

  return { server, cfg, stats, connections: () => ({ total: wsTotal, byIp: new Map(wsByIp) }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, cfg } = createGateway();
  server.listen(cfg.listenPort, cfg.listenHost, () => {
    console.log(JSON.stringify({
      level: "info",
      event: "gateway_listening",
      address: `${cfg.listenHost}:${cfg.listenPort}`,
      upstreamRpc: cfg.upstreamRpc,
      upstreamWs: cfg.upstreamWs,
      upstreamWeb: cfg.upstreamWeb,
      publicBridgeDemo: cfg.publicBridgeDemo,
    }));
  });
  const stop = (signal) => {
    console.log(JSON.stringify({ level: "info", event: "shutdown", signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
