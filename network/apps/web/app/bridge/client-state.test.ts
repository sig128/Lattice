import { describe, expect, it } from "vitest";
import { loadReceiptId, parseUiAmount, previewConversion, saveReceiptId } from "./client-state";

describe("bridge amount preview", () => {
  it("parses decimals exactly without floating point", () => {
    expect(parseUiAmount("12.345", 9)).toBe(12_345_000_000n);
    expect(previewConversion("1.25", 9, 9).creditedAtomic).toBe(1_250_000_000n);
  });

  it("rejects zero and unsupported precision", () => {
    expect(() => parseUiAmount("0", 9)).toThrow("greater than zero");
    expect(() => parseUiAmount("1.0000000001", 9)).toThrow("Maximum precision");
  });
});

describe("resumable receipt persistence", () => {
  it("stores and validates the latest receipt ID", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    saveReceiptId(storage, "abcdefabcdefabcdefabcdef");
    expect(loadReceiptId(storage)).toBe("abcdefabcdefabcdefabcdef");
    values.set("lattice.localBridge.receiptId", "unsafe");
    expect(loadReceiptId(storage)).toBeNull();
  });
});
