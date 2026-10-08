"use client";

import {
  burnChecked,
  getAccount,
  getAssociatedTokenAddress,
  transferChecked,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton } from "../components";
import { loadReceiptId, parseUiAmount, previewConversion, saveReceiptId } from "./client-state";

interface BridgeState {
  genesisHash: string;
  sourceMint: string;
  issuedMint: string;
  vaultAccount: string;
  decimals: number;
  slot: number;
  reservesAtomic: string;
  liabilitiesAtomic: string;
  coverage: string;
  warning: string;
}

interface Receipt {
  id: string;
  direction: "deposit" | "redemption";
  sourceSignature: string;
  destinationSignature: string;
  status: "completed";
}

const RPC = process.env.NEXT_PUBLIC_NATIVE_HTTP_RPC ?? "http://127.0.0.1:8899";
const WALLET_KEY = "lattice.localBridge.devWallet";
const progressStates = ["Awaiting signature", "Submitted", "Awaiting finality", "Processing", "Completed", "Delayed", "Failed"] as const;

function walletFromStorage() {
  const stored = localStorage.getItem(WALLET_KEY);
  if (stored) {
    try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored) as number[])); } catch { /* replace malformed local key */ }
  }
  const wallet = Keypair.generate();
  localStorage.setItem(WALLET_KEY, JSON.stringify([...wallet.secretKey]));
  return wallet;
}

function units(atomic: bigint, decimals: number) {
  const divisor = 10n ** BigInt(decimals);
  const whole = atomic / divisor;
  const fraction = (atomic % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function LocalBridge() {
  const [state, setState] = useState<BridgeState | null>(null);
  const [wallet, setWallet] = useState<Keypair | null>(null);
  const [direction, setDirection] = useState<"deposit" | "redemption">("deposit");
  const [amount, setAmount] = useState("");
  const [sourceBalance, setSourceBalance] = useState(0n);
  const [issuedBalance, setIssuedBalance] = useState(0n);
  const [solBalance, setSolBalance] = useState(0);
  const [progress, setProgress] = useState<(typeof progressStates)[number]>("Awaiting signature");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lookup, setLookup] = useState("");
  const [message, setMessage] = useState("Ready for a local test transaction.");

  const refresh = useCallback(async (owner: Keypair) => {
    const response = await fetch("/api/bridge/state", { cache: "no-store" });
    const nextState = await response.json() as BridgeState;
    if (!response.ok) throw new Error((nextState as unknown as { error?: string }).error ?? "Bridge state unavailable");
    setState(nextState);
    const connection = new Connection(RPC, "confirmed");
    const sourceAddress = await getAssociatedTokenAddress(new PublicKey(nextState.sourceMint), owner.publicKey);
    const issuedAddress = await getAssociatedTokenAddress(new PublicKey(nextState.issuedMint), owner.publicKey);
    const [sol, source, issued] = await Promise.all([
      connection.getBalance(owner.publicKey, "confirmed"),
      getAccount(connection, sourceAddress, "confirmed").then((account) => account.amount).catch(() => 0n),
      getAccount(connection, issuedAddress, "confirmed").then((account) => account.amount).catch(() => 0n),
    ]);
    setSolBalance(sol);
    setSourceBalance(source);
    setIssuedBalance(issued);
  }, []);

  useEffect(() => {
    const localWallet = walletFromStorage();
    setWallet(localWallet);
    void refresh(localWallet).catch((error) => setMessage(error instanceof Error ? error.message : "Bridge unavailable"));
    const savedReceipt = loadReceiptId(localStorage);
    if (savedReceipt) setLookup(savedReceipt);
  }, [refresh]);

  const preview = useMemo(() => {
    if (!state || !amount) return null;
    try { return previewConversion(amount, state.decimals, state.decimals); } catch { return null; }
  }, [amount, state]);
  const available = direction === "deposit" ? sourceBalance : issuedBalance;

  async function faucet() {
    if (!wallet) return;
    setMessage("Requesting local SOL…");
    const response = await fetch("/api/faucet", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: wallet.publicKey.toBase58() }),
    });
    const result = await response.json() as { error?: string; signature?: string };
    if (!response.ok) return setMessage(result.error ?? "Faucet failed");
    setMessage(`Local SOL confirmed · ${result.signature?.slice(0, 12)}…`);
    await refresh(wallet);
  }

  async function testTokens() {
    if (!wallet) return;
    setMessage("Minting local source test tokens…");
    const response = await fetch("/api/bridge/test-mint", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: wallet.publicKey.toBase58() }),
    });
    const result = await response.json() as { error?: string; signature?: string };
    if (!response.ok) return setMessage(result.error ?? "Test mint failed");
    setMessage(`100 source test units minted · ${result.signature?.slice(0, 12)}…`);
    await refresh(wallet);
  }

  async function bridge() {
    if (!wallet || !state) return;
    setReceipt(null);
    setProgress("Awaiting signature");
    try {
      const amountAtomic = parseUiAmount(amount, state.decimals);
      if (amountAtomic > available) throw new Error("Amount exceeds local test balance");
      const connection = new Connection(RPC, "confirmed");
      const mint = new PublicKey(direction === "deposit" ? state.sourceMint : state.issuedMint);
      const ownerAccount = await getAssociatedTokenAddress(mint, wallet.publicKey);
      setMessage("Authorize the local transaction with the browser-generated development key.");
      const sourceSignature = direction === "deposit"
        ? await transferChecked(connection, wallet, ownerAccount, mint, new PublicKey(state.vaultAccount), wallet, amountAtomic, state.decimals)
        : await burnChecked(connection, wallet, ownerAccount, mint, wallet, amountAtomic, state.decimals);
      setProgress("Submitted");
      setMessage(`Submitted ${sourceSignature.slice(0, 16)}…`);
      setProgress("Awaiting finality");
      const response = await fetch("/api/bridge/settle", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction, owner: wallet.publicKey.toBase58(),
          amountAtomic: amountAtomic.toString(), sourceSignature,
        }),
      });
      setProgress("Processing");
      const result = await response.json() as Receipt & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Bridge settlement failed");
      setReceipt(result);
      saveReceiptId(localStorage, result.id);
      setLookup(result.id);
      setProgress("Completed");
      setMessage("Completed with separate source and destination signatures.");
      setAmount("");
      await refresh(wallet);
    } catch (error) {
      setProgress("Failed");
      setMessage(error instanceof Error ? error.message : "Bridge transaction failed");
    }
  }

  async function lookupReceipt() {
    const response = await fetch(`/api/bridge/settle?id=${encodeURIComponent(lookup)}`);
    const result = await response.json() as Receipt & { error?: string };
    if (!response.ok) return setMessage(result.error ?? "Receipt not found");
    setReceipt(result);
    setProgress("Completed");
    setMessage("Receipt restored.");
  }

  return (
    <div className="bridge-workspace">
      <div className="premium-bridge">
        <div className="bridge-mode"><span>Local development wallet</span><strong>DEV ONLY · unbacked test assets · never use for real funds</strong></div>
        <div className="wallet-row"><div><small>Browser-generated public key</small><code>{wallet?.publicKey.toBase58() ?? "Creating…"}</code></div>{wallet ? <CopyButton value={wallet.publicKey.toBase58()} /> : null}</div>
        <div className="wallet-actions"><button type="button" onClick={faucet}>Get local SOL</button><button type="button" onClick={testTokens}>Get 100 source test units</button><span>{(solBalance / 1e9).toFixed(3)} local SOL</span></div>

        <div className={`network-route ${direction}`}>
          <div className="network-panel"><span className="chain-mark">S</span><div><small>{direction === "deposit" ? "From" : "To"}</small><strong>Solana test source</strong><em>{units(sourceBalance, state?.decimals ?? 9)} available</em></div></div>
          <button className="swap-direction" type="button" aria-label="Swap bridge direction" onClick={() => { setDirection((value) => value === "deposit" ? "redemption" : "deposit"); setAmount(""); }}>⇄</button>
          <div className="network-panel destination"><span className="chain-mark">L</span><div><small>{direction === "deposit" ? "To" : "From"}</small><strong>Lattice test asset</strong><em>{units(issuedBalance, state?.decimals ?? 9)} available</em></div></div>
        </div>

        <div className="amount-entry">
          <label>Amount<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
          <button type="button" onClick={() => state && setAmount(units(available, state.decimals))}>MAX</button>
          <span>{direction === "deposit" ? "Source test units" : "LAT bridge test units"}</span>
        </div>
        <div className="receive-preview"><span>You receive</span><strong>{preview ? units(preview.creditedAtomic, state?.decimals ?? 9) : "—"}</strong><small>{direction === "deposit" ? "LAT bridge test asset" : "source test asset"}</small></div>

        <dl className="bridge-breakdown">
          <div><dt>Conversion</dt><dd>1 : 1 exact units</dd></div>
          <div><dt>Bridge fee</dt><dd>0 · local development</dd></div>
          <div><dt>Precision</dt><dd>{state?.decimals ?? 9} decimals</dd></div>
          <div><dt>Residual dust</dt><dd>{preview?.residualSourceAtomic.toString() ?? "0"} atomic units</dd></div>
        </dl>
        <div className="source-ca"><span>Local source CA</span><code>{state?.sourceMint ?? "Loading…"}</code>{state ? <CopyButton value={state.sourceMint} /> : null}</div>
        <div className="route-visual"><span>Vault lock</span><i>→</i><span>Finality</span><i>→</i><span>Attestation</span><i>→</i><span>Issue</span></div>
        <button className="bridge-submit" type="button" onClick={bridge} disabled={!preview || !wallet || !state}>{direction === "deposit" ? "Deposit and issue" : "Burn and redeem"}</button>
        <p className="bridge-message" aria-live="polite">{message}</p>
      </div>

      <aside className="bridge-side">
        <div className="bridge-stats"><span>Live reconciliation</span><dl><div><dt>Reserves</dt><dd>{state ? units(BigInt(state.reservesAtomic), state.decimals) : "—"}</dd></div><div><dt>Liabilities</dt><dd>{state ? units(BigInt(state.liabilitiesAtomic), state.decimals) : "—"}</dd></div><div><dt>Coverage</dt><dd>{state?.coverage ?? "—"}</dd></div><div><dt>Finalized slot</dt><dd>{state?.slot.toLocaleString() ?? "—"}</dd></div></dl></div>
        <ol className="bridge-timeline">
          {progressStates.map((item) => <li key={item} className={item === progress ? "current" : progress === "Completed" && progressStates.indexOf(item) < 5 ? "done" : ""}><i /><span>{item}</span></li>)}
        </ol>
        <div className="receipt-lookup"><label>Resume receipt<input value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="Receipt ID" /></label><button type="button" onClick={lookupReceipt} disabled={!lookup}>Look up</button></div>
        {receipt ? <div className="receipt-evidence"><strong>Receipt {receipt.id}</strong><a href={`/explorer?tx=${receipt.sourceSignature}`}>Source evidence ↗</a><a href={`/explorer?tx=${receipt.destinationSignature}`}>Destination evidence ↗</a></div> : null}
      </aside>
    </div>
  );
}
