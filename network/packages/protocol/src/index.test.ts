import { describe, expect, it } from "vitest";
import {
  bridgeMessageId,
  canonicalBridgeMessage,
  convertExact,
  reconcile,
  transitionClaim,
  type BridgeMessage,
} from "./index.js";

const message: BridgeMessage = {
  protocol: "lattice-bridge",
  version: 1,
  deploymentId: "local-1",
  direction: "deposit",
  sourceGenesisHash: "source-genesis",
  destinationGenesisHash: "destination-genesis",
  sourceMint: "So11111111111111111111111111111111111111112",
  amountAtomic: "1000000",
  recipient: "native-recipient",
  eventId: "transaction-signature:instruction-2:event-0",
  nonce: "7",
  signerEpoch: 0,
};

describe("exact conversion", () => {
  it("scales without floating point", () => {
    expect(convertExact(42n, 6, 9)).toEqual({
      creditedAtomic: 42_000n,
      consumedSourceAtomic: 42n,
      residualSourceAtomic: 0n,
    });
  });

  it("reports residual dust", () => {
    expect(convertExact(12_345n, 6, 3)).toEqual({
      creditedAtomic: 12n,
      consumedSourceAtomic: 12_000n,
      residualSourceAtomic: 345n,
    });
  });

  it("rejects amounts below one redemption quantum", () => {
    expect(() => convertExact(999n, 6, 3)).toThrow("redemption quantum");
  });
});

describe("bridge messages", () => {
  it("is canonical and domain-sensitive", () => {
    expect(new TextDecoder().decode(canonicalBridgeMessage(message))).toContain("14:lattice-bridge");
    expect(
      bridgeMessageId({ ...message, destinationGenesisHash: "another-destination" }),
    ).not.toBe(bridgeMessageId(message));
    expect(bridgeMessageId({ ...message, eventId: `${message.eventId}:second` })).not.toBe(
      bridgeMessageId(message),
    );
  });
});

describe("claim state machine", () => {
  it("prevents completion before an authorized submission", () => {
    expect(() => transitionClaim("observed", "completed")).toThrow("Invalid claim transition");
    expect(transitionClaim("submitted", "completed")).toBe("completed");
    expect(() => transitionClaim("completed", "submitted")).toThrow();
  });
});

describe("reconciliation", () => {
  it("counts native supply and both pending obligation classes", () => {
    const result = reconcile({
      reserves: 130n,
      redeemableNativeSupply: 100n,
      pendingDeposits: 10n,
      pendingWithdrawals: 20n,
      sourceWatermark: 9n,
      destinationWatermark: 9n,
      observedAt: new Date("2026-10-08T18:00:00Z"),
      now: new Date("2026-10-08T18:00:01Z"),
      staleAfterMs: 60_000,
    });
    expect(result.liabilities).toBe(130n);
    expect(result.backed).toBe(true);
    expect(result.label).toBe("100.00%");
  });

  it("does not claim coverage for incomparable or stale observations", () => {
    const base = {
      reserves: 100n,
      redeemableNativeSupply: 100n,
      pendingDeposits: 0n,
      pendingWithdrawals: 0n,
      observedAt: new Date("2026-10-08T18:00:00Z"),
      now: new Date("2026-10-08T18:02:00Z"),
      staleAfterMs: 60_000,
    };
    expect(reconcile({ ...base, sourceWatermark: 1n, destinationWatermark: 2n }).label).toBe(
      "Pending reconciliation",
    );
    expect(reconcile({ ...base, sourceWatermark: 2n, destinationWatermark: 2n }).label).toBe(
      "Stale evidence",
    );
  });

  it("uses a non-percentage label for zero liabilities", () => {
    const result = reconcile({
      reserves: 0n,
      redeemableNativeSupply: 0n,
      pendingDeposits: 0n,
      pendingWithdrawals: 0n,
      sourceWatermark: 0n,
      destinationWatermark: 0n,
      observedAt: new Date(),
      staleAfterMs: 60_000,
    });
    expect(result.coverageBps).toBeNull();
    expect(result.label).toBe("No outstanding claims");
  });
});
