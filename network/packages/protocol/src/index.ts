import { createHash } from "node:crypto";
import { z } from "zod";

export interface Conversion {
  creditedAtomic: bigint;
  consumedSourceAtomic: bigint;
  residualSourceAtomic: bigint;
}

export function convertExact(
  sourceAtomic: bigint,
  sourceDecimals: number,
  nativeDecimals: number,
): Conversion {
  if (sourceAtomic <= 0n) throw new Error("Amount must be positive");
  if (![sourceDecimals, nativeDecimals].every((v) => Number.isInteger(v) && v >= 0 && v <= 18)) {
    throw new Error("Unsupported decimal precision");
  }
  if (nativeDecimals >= sourceDecimals) {
    const creditedAtomic = sourceAtomic * 10n ** BigInt(nativeDecimals - sourceDecimals);
    return { creditedAtomic, consumedSourceAtomic: sourceAtomic, residualSourceAtomic: 0n };
  }
  const quantum = 10n ** BigInt(sourceDecimals - nativeDecimals);
  const creditedAtomic = sourceAtomic / quantum;
  if (creditedAtomic === 0n) throw new Error(`Amount is below the redemption quantum (${quantum})`);
  const consumedSourceAtomic = creditedAtomic * quantum;
  return {
    creditedAtomic,
    consumedSourceAtomic,
    residualSourceAtomic: sourceAtomic - consumedSourceAtomic,
  };
}

export const bridgeMessageSchema = z.object({
  protocol: z.literal("lattice-bridge"),
  version: z.literal(1),
  deploymentId: z.string().min(1).max(96),
  direction: z.enum(["deposit", "withdrawal"]),
  sourceGenesisHash: z.string().min(1).max(96),
  destinationGenesisHash: z.string().min(1).max(96),
  sourceMint: z.string().min(32).max(64),
  amountAtomic: z.string().regex(/^[1-9][0-9]*$/),
  recipient: z.string().min(1).max(128),
  eventId: z.string().min(1).max(160),
  nonce: z.string().regex(/^[0-9]+$/),
  signerEpoch: z.number().int().nonnegative(),
});
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

export function canonicalBridgeMessage(message: BridgeMessage): Uint8Array {
  const m = bridgeMessageSchema.parse(message);
  const fields = [
    m.protocol,
    `${m.version}`,
    m.deploymentId,
    m.direction,
    m.sourceGenesisHash,
    m.destinationGenesisHash,
    m.sourceMint,
    m.amountAtomic,
    m.recipient,
    m.eventId,
    m.nonce,
    `${m.signerEpoch}`,
  ];
  return new TextEncoder().encode(fields.map((field) => `${field.length}:${field}`).join("|"));
}

export function bridgeMessageId(message: BridgeMessage): string {
  return createHash("sha256").update(canonicalBridgeMessage(message)).digest("hex");
}

export type ClaimState =
  | "observed"
  | "finalized"
  | "authorized"
  | "submitted"
  | "completed"
  | "failed";

const TRANSITIONS: Record<ClaimState, readonly ClaimState[]> = {
  observed: ["finalized", "failed"],
  finalized: ["authorized", "failed"],
  authorized: ["submitted"],
  submitted: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function transitionClaim(current: ClaimState, next: ClaimState): ClaimState {
  if (!TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid claim transition: ${current} -> ${next}`);
  }
  return next;
}

export interface ReconciliationInput {
  reserves: bigint;
  redeemableNativeSupply: bigint;
  pendingDeposits: bigint;
  pendingWithdrawals: bigint;
  sourceWatermark: bigint;
  destinationWatermark: bigint;
  observedAt: Date;
  staleAfterMs: number;
  now?: Date;
}

export interface Reconciliation {
  reserves: bigint;
  liabilities: bigint;
  surplusOrDeficit: bigint;
  coverageBps: bigint | null;
  backed: boolean;
  comparable: boolean;
  stale: boolean;
  label: string;
}

export function reconcile(input: ReconciliationInput): Reconciliation {
  const values = [
    input.reserves,
    input.redeemableNativeSupply,
    input.pendingDeposits,
    input.pendingWithdrawals,
  ];
  if (values.some((value) => value < 0n)) throw new Error("Accounting values cannot be negative");
  const liabilities =
    input.redeemableNativeSupply + input.pendingDeposits + input.pendingWithdrawals;
  const comparable = input.sourceWatermark === input.destinationWatermark;
  const stale = (input.now ?? new Date()).getTime() - input.observedAt.getTime() > input.staleAfterMs;
  const coverageBps = liabilities === 0n ? null : (input.reserves * 10_000n) / liabilities;
  const backed = comparable && !stale && input.reserves >= liabilities;
  const label =
    liabilities === 0n
      ? "No outstanding claims"
      : !comparable
        ? "Pending reconciliation"
        : stale
          ? "Stale evidence"
          : `${coverageBps! / 100n}.${(coverageBps! % 100n).toString().padStart(2, "0")}%`;
  return {
    reserves: input.reserves,
    liabilities,
    surplusOrDeficit: input.reserves - liabilities,
    coverageBps,
    backed,
    comparable,
    stale,
    label,
  };
}
