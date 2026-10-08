"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyButton } from "./components";

const PUBLIC_HTTP_RPC = process.env.NEXT_PUBLIC_NATIVE_HTTP_RPC ?? "http://127.0.0.1:8899";
const PUBLIC_WS_RPC = process.env.NEXT_PUBLIC_NATIVE_WS_RPC ?? "ws://127.0.0.1:8900";

interface RpcReply {
  method: string;
  result: unknown;
  checkedAt: string;
  latencyMs: number;
  error?: string;
}

async function call(method: string, address?: string): Promise<RpcReply> {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, address }),
  });
  const body = await response.json() as RpcReply;
  if (!response.ok) throw new Error(body.error ?? "RPC request failed");
  return body;
}

export function LiveRpcVitals({ expectedGenesis }: { expectedGenesis: string }) {
  const [slot, setSlot] = useState<number | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [genesis, setGenesis] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [slotReply, genesisReply] = await Promise.all([call("getSlot"), call("getGenesisHash")]);
      setSlot(Number(slotReply.result));
      setLatency(slotReply.latencyMs);
      setCheckedAt(slotReply.checkedAt);
      setGenesis(String(genesisReply.result));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "RPC unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div className="live-vitals" aria-live="polite">
      <div><span>RPC</span><strong className={error ? "vital-bad" : "vital-good"}>{error ? "Unavailable" : "Live"}</strong><small>{error ?? "Identity and slot observed"}</small></div>
      <div><span>Finalized slot</span><strong>{slot?.toLocaleString() ?? "Checking…"}</strong><small>Updates every 4 seconds</small></div>
      <div><span>Genesis</span><strong className="mono">{genesis ? `${genesis.slice(0, 6)}…${genesis.slice(-5)}` : "Checking…"}</strong><small>{genesis === expectedGenesis ? "Verified match" : "Awaiting match"}</small></div>
      <div><span>Latency</span><strong>{latency === null ? "—" : `${latency} ms`}</strong><small>{checkedAt ? new Date(checkedAt).toLocaleTimeString() : "Not checked"}</small></div>
    </div>
  );
}

export function RpcConsole() {
  const [method, setMethod] = useState("getSlot");
  const [address, setAddress] = useState("");
  const [output, setOutput] = useState("Select a method and run a real local request.");
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const result = await call(method, address || undefined);
      setOutput(JSON.stringify(result, null, 2));
    } catch (error) {
      setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed" }, null, 2));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rpc-console">
      <div className="console-bar">
        <label>Method<select value={method} onChange={(event) => setMethod(event.target.value)}>
          {["getSlot", "getGenesisHash", "getVersion", "getLatestBlockhash", "getBalance"].map((value) => <option key={value}>{value}</option>)}
        </select></label>
        {method === "getBalance" ? <label className="console-address">Account<input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Public key" /></label> : null}
        <button className="primary" type="button" disabled={running} onClick={run}>{running ? "Running…" : "Run request"}</button>
      </div>
      <pre tabIndex={0}><code>{output}</code></pre>
    </div>
  );
}

export function RpcEndpoints() {
  return (
    <div className="rpc-front">
      <div><span>HTTP JSON-RPC</span><code>{PUBLIC_HTTP_RPC}</code><CopyButton value={PUBLIC_HTTP_RPC} /></div>
      <div><span>WebSocket</span><code>{PUBLIC_WS_RPC}</code><CopyButton value={PUBLIC_WS_RPC} /></div>
      <p>Local machine only. Public developer access requires a hosted node with domain and TLS.</p>
    </div>
  );
}

export function Faucet() {
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("Unbacked local test units only.");
  const [running, setRunning] = useState(false);

  async function requestFunds() {
    setRunning(true);
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const result = await response.json() as { signature?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Faucet request failed");
      setMessage(`Confirmed: ${result.signature}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Faucet request failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="faucet">
      <label>Recipient public key<input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Solana public key on this local genesis" /></label>
      <button type="button" className="primary" onClick={requestFunds} disabled={running || !address}>{running ? "Requesting…" : "Request 1 test LAT"}</button>
      <small>{message}</small>
    </div>
  );
}
