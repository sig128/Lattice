import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { computeStatus } from "../src/reconcile.js";
import { world } from "./helpers/fixtures.js";

describe("reconciliation", () => {
  it("computes R, N, P, W from chain reads with donations as surplus", async () => {
    const w = world();
    w.source.deposit(10_000_000n, Keypair.generate().publicKey.toBytes());
    w.source.vault += 500n; // unsolicited donation
    let s = await computeStatus(w.source, w.lattice, w.binding);
    expect([s.R, s.N, s.P, s.W]).toEqual(["10000500", "0", "10000000", "0"]);
    expect(s.backed).toBe(true);
    expect(s.surplus).toBe("500");

    // Mint, burn part, before release.
    const lat = Keypair.generate().publicKey.toBytes();
    w.source.deposit(4_000_000n, lat);
    w.lattice.balances.set(Buffer.from(lat).toString("hex"), 0n);
    (w.lattice as unknown as { st: { totalMintedNative: bigint; mintedCount: bigint } }).st.totalMintedNative = 14_000_000_000n;
    w.lattice.balances.set(Buffer.from(lat).toString("hex"), 14_000_000_000n);
    w.lattice.burnFor(lat, 3_000_000_000n, Keypair.generate().publicKey.toBytes());
    s = await computeStatus(w.source, w.lattice, w.binding);
    expect([s.N, s.P, s.W]).toEqual(["11000000", "0", "3000000"]);
    expect(BigInt(s.liabilities)).toBe(14_000_000n);
    expect(s.label).toBe("100.00%");
  });

  it("raises alarms for over-minting and reserve deficits", async () => {
    const w = world();
    w.source.deposit(1_000_000n, Keypair.generate().publicKey.toBytes());
    (w.lattice as unknown as { st: { totalMintedNative: bigint } }).st.totalMintedNative = 2_000_000_000n;
    let s = await computeStatus(w.source, w.lattice, w.binding);
    expect(s.alarms).toContain("more LAT minted than deposited on Solana");
    expect(s.backed).toBe(false);

    const w2 = world();
    w2.source.deposit(1_000_000n, Keypair.generate().publicKey.toBytes());
    w2.source.vault -= 1n;
    s = await computeStatus(w2.source, w2.lattice, w2.binding);
    expect(s.alarms).toEqual(["reserves below liabilities"]);
    expect(s.label).toBe("Accounting alarm");
  });
});
