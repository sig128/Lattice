import { describe, expect, it } from "vitest";
import { formatCheckedAt, statusPresentation } from "./status";

describe("network status presentation", () => {
  it("maps unavailable and degraded observations without overstating health", () => {
    expect(statusPresentation("unavailable")).toEqual({ tone: "bad", label: "Unavailable" });
    expect(statusPresentation("degraded")).toEqual({ tone: "warn", label: "Degraded" });
    expect(statusPresentation("operational")).toEqual({ tone: "good", label: "Operational" });
  });

  it("labels status timestamps as UTC", () => {
    expect(formatCheckedAt("2026-10-08T18:00:00.000Z")).toContain("UTC");
  });
});
