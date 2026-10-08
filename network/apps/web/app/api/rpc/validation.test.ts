import { describe, expect, it } from "vitest";
import { validateRpcRequest } from "./validation";

describe("RPC console allowlist", () => {
  it("allows documented read methods", () => {
    expect(validateRpcRequest({ method: "getSlot" }).method).toBe("getSlot");
    expect(validateRpcRequest({ method: "getGenesisHash" }).method).toBe("getGenesisHash");
    expect(validateRpcRequest({ method: "getVersion" }).params).toEqual([]);
    expect(validateRpcRequest({ method: "getLatestBlockhash" }).method).toBe("getLatestBlockhash");
    expect(validateRpcRequest({ method: "getBalance", address: "11111111111111111111111111111111" }).method).toBe("getBalance");
  });

  it("rejects writes and malformed addresses", () => {
    expect(() => validateRpcRequest({ method: "sendTransaction" })).toThrow("not allowed");
    expect(() => validateRpcRequest({ method: "getBalance", address: "not-a-key" })).toThrow("valid base58");
  });
});
