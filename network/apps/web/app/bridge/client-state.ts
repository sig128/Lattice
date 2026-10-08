import { convertExact } from "@lattice/protocol";

export function parseUiAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(normalized)) throw new Error("Enter a positive decimal amount");
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`Maximum precision is ${decimals} decimals`);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (atomic <= 0n) throw new Error("Amount must be greater than zero");
  return atomic;
}

export function previewConversion(value: string, sourceDecimals: number, destinationDecimals: number) {
  const sourceAtomic = parseUiAmount(value, sourceDecimals);
  return convertExact(sourceAtomic, sourceDecimals, destinationDecimals);
}

export interface ReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const RECEIPT_KEY = "lattice.localBridge.receiptId";

export function saveReceiptId(storage: ReceiptStorage, id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid receipt ID");
  storage.setItem(RECEIPT_KEY, id);
}

export function loadReceiptId(storage: ReceiptStorage) {
  const value = storage.getItem(RECEIPT_KEY);
  return value && /^[a-f0-9]{24}$/.test(value) ? value : null;
}
