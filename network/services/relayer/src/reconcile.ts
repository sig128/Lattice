import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type pg from "pg";
import { reconcile } from "@lattice/protocol";
import { nativeScale, toHex } from "@lattice/protocol/wire";
import type { Binding, LatticeView, SourceView } from "./chain/types.js";
import type { Logger } from "./log.js";

export interface BridgeStatus {
  schema: "lattice-bridge-status/1";
  observedAt: string;
  deploymentId: string;
  sourceProgramId: string;
  sourceMint: string;
  solana: { slot: number; totalDeposited: string; totalReleased: string; nextDepositSequence: string; guardianEpoch: string; depositsPaused: boolean; withdrawalsPaused: boolean; vault: string };
  lattice: { slot: number; totalMintedNative: string; totalBurnedNative: string; nextBurnSequence: string; mintedCount: string; guardianEpoch: string };
  /** All in source atomic units. */
  R: string;
  N: string;
  P: string;
  W: string;
  liabilities: string;
  surplus: string;
  coverageBps: string | null;
  backed: boolean;
  label: string;
  alarms: string[];
}

/**
 * Computes R (vault balance), N (circulating LAT), P (deposited, not yet
 * minted) and W (burned, not yet released) from finalized chain reads, per
 * BRIDGE_SPEC §10. Negative P or W, or R < N + P + W, raise alarms.
 */
export async function computeStatus(source: SourceView, lattice: LatticeView, binding: Binding, now = new Date()): Promise<BridgeStatus> {
  const [cfgObs, stObs] = await Promise.all([source.config(), lattice.state()]);
  const cfg = cfgObs.value;
  const st = stObs.value;
  const vault = await source.vaultBalance(cfg.vault);
  const scale = nativeScale(binding.sourceDecimals);
  const alarms: string[] = [];
  if (st.totalMintedNative % scale !== 0n || st.totalBurnedNative % scale !== 0n) alarms.push("lattice totals are not multiples of the scale");
  const minted = st.totalMintedNative / scale;
  const burned = st.totalBurnedNative / scale;
  const R = vault.value;
  const N = minted - burned;
  const P = cfg.totalDeposited - minted;
  const W = burned - cfg.totalReleased;
  if (N < 0n) alarms.push("more LAT burned than minted");
  if (P < 0n) alarms.push("more LAT minted than deposited on Solana");
  if (W < 0n) alarms.push("more released on Solana than burned on Lattice");
  const liabilities = N + P + W;
  if (R < liabilities) alarms.push("reserves below liabilities");
  const negative = N < 0n || P < 0n || W < 0n;
  const rec = negative
    ? null
    : reconcile({
        reserves: R,
        redeemableNativeSupply: N,
        pendingDeposits: P,
        pendingWithdrawals: W,
        sourceWatermark: 0n,
        destinationWatermark: 0n,
        observedAt: now,
        staleAfterMs: 120_000,
        now,
      });
  return {
    schema: "lattice-bridge-status/1",
    observedAt: now.toISOString(),
    deploymentId: toHex(binding.deploymentId),
    sourceProgramId: binding.sourceProgramId.toBase58(),
    sourceMint: binding.sourceMint.toBase58(),
    solana: {
      slot: Math.min(cfgObs.slot, vault.slot),
      totalDeposited: cfg.totalDeposited.toString(),
      totalReleased: cfg.totalReleased.toString(),
      nextDepositSequence: cfg.nextDepositSequence.toString(),
      guardianEpoch: cfg.epoch.toString(),
      depositsPaused: cfg.depositsPaused,
      withdrawalsPaused: cfg.withdrawalsPaused,
      vault: cfg.vault.toBase58(),
    },
    lattice: {
      slot: stObs.slot,
      totalMintedNative: st.totalMintedNative.toString(),
      totalBurnedNative: st.totalBurnedNative.toString(),
      nextBurnSequence: st.nextBurnSequence.toString(),
      mintedCount: st.mintedCount.toString(),
      guardianEpoch: st.guardianEpoch.toString(),
    },
    R: R.toString(),
    N: N.toString(),
    P: P.toString(),
    W: W.toString(),
    liabilities: liabilities.toString(),
    surplus: (R - liabilities).toString(),
    coverageBps: rec?.coverageBps?.toString() ?? null,
    backed: alarms.length === 0 && (rec?.backed ?? false),
    label: alarms.length ? "Accounting alarm" : rec!.label,
    alarms,
  };
}

/** Atomically replaces the status file (write + rename). */
export async function publishStatus(path: string, status: BridgeStatus): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, path);
}

export async function recordSample(pool: pg.Pool, s: BridgeStatus): Promise<void> {
  await pool.query(
    `INSERT INTO reconciliation_samples (observed_at, solana_slot, lattice_slot, reserves, circulating, pending_deposits, pending_withdrawals, backed, label, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [s.observedAt, s.solana.slot, s.lattice.slot, s.R, s.N, s.P, s.W, s.backed, s.label, JSON.stringify(s)],
  );
}

export function logStatus(log: Logger, s: BridgeStatus) {
  const fields = { R: s.R, N: s.N, P: s.P, W: s.W, label: s.label, alarms: s.alarms };
  if (s.alarms.length) log.critical("reconciliation alarm", fields);
  else log.info("reconciled", fields);
}
