import { describe, expect, it } from "vitest";
import { reconcile } from "@lattice/protocol";

describe("local bridge recorder accounting", () => {
  it("tracks deposits and redemption without losing the 1:1 invariant", () => {
    for (const amount of [0n, 100n, 150n, 125n]) {
      const result = reconcile({
        reserves: amount,
        redeemableNativeSupply: amount,
        pendingDeposits: 0n,
        pendingWithdrawals: 0n,
        sourceWatermark: 10n,
        destinationWatermark: 10n,
        observedAt: new Date(),
        staleAfterMs: 60_000,
      });
      expect(result.backed).toBe(true);
      expect(result.surplusOrDeficit).toBe(0n);
      expect(result.label).toBe(amount === 0n ? "No outstanding claims" : "100.00%");
    }
  });
});
