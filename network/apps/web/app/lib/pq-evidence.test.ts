import { describe, expect, it } from "vitest";
import { parsePqEvidence, readPqEvidence } from "./pq-evidence";

describe("post-quantum evidence reader", () => {
  it("normalizes nested evidence without trusting markup", () => {
    const evidence = parsePqEvidence({
      status: "<script>experimental</script>",
      algorithm: "ML-DSA-65",
      network: { genesisHash: "pq-genesis", httpRpc: "http://127.0.0.1:8999" },
      program: { programId: "Verifier111", transactions: ["signature-1"] },
      scope: { protectedNow: ["vault authorization"], stillClassical: ["consensus"] },
      measurements: { signatureBytes: 3309 },
    });
    expect(evidence.status).not.toContain("<");
    expect(evidence.genesisHash).toBe("pq-genesis");
    expect(evidence.transactions).toEqual(["signature-1"]);
    expect(evidence.measurements.signatureBytes).toBe(3309);
  });

  it("returns a truthful build state when evidence is absent", async () => {
    const evidence = await readPqEvidence();
    if (!evidence.available) expect(evidence.status).toContain("build in progress");
    else expect(evidence.algorithm).toContain("ML-DSA");
  });
});
