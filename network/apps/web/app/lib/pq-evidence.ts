import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE_PATH = resolve(ROOT, "chain/evidence/pq-local.json");
const MAX_TEXT = 240;

export interface PqEvidence {
  available: boolean;
  status: string;
  statusDetail: string | null;
  algorithm: string;
  genesisHash: string | null;
  httpRpc: string | null;
  programId: string | null;
  transactions: string[];
  measurements: Record<string, string | number>;
  protectedNow: string[];
  stillClassical: string[];
  checkedAt: string | null;
}

function cleanText(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max) || null : null;
}

function cleanList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter((item): item is string => Boolean(item)).slice(0, 24)
    : [];
}

export function parsePqEvidence(value: unknown): PqEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PQ evidence must be an object");
  const input = value as Record<string, unknown>;
  const network = input.network && typeof input.network === "object" ? input.network as Record<string, unknown> : {};
  const program = input.program && typeof input.program === "object" ? input.program as Record<string, unknown> : {};
  const crypto = input.crypto && typeof input.crypto === "object" ? input.crypto as Record<string, unknown> : {};
  const ports = input.ports && typeof input.ports === "object" ? input.ports as Record<string, unknown> : {};
  const scope = input.scope && typeof input.scope === "object" ? input.scope as Record<string, unknown> : {};
  const rawMeasurements = input.measurements && typeof input.measurements === "object"
    ? input.measurements as Record<string, unknown>
    : {};
  const measurements: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(rawMeasurements).slice(0, 20)) {
    if (typeof item === "number" && Number.isFinite(item)) measurements[cleanText(key, 60) ?? "measurement"] = item;
    if (typeof item === "string") measurements[cleanText(key, 60) ?? "measurement"] = cleanText(item, 120) ?? "";
  }
  const transactions = cleanList(
    input.transactions ?? input.sampleTransactions ?? input.transactionSignatures ?? program.transactions,
  );
  const genesisHash = cleanText(input.genesisHash ?? network.genesisHash, 96);
  const programId = cleanText(input.programId ?? program.programId ?? program.id, 96);
  const explicitProtected = cleanList(input.protectedNow ?? input.protected ?? scope.protectedNow);
  const protectedNow = explicitProtected.length ? explicitProtected : [
    ...(cleanText(crypto.syscall) ? ["ML-DSA-65 verification syscall implemented and unit tested"] : []),
    ...(programId ? ["pq-vault authorization, replay protection, and tamper tests implemented"] : []),
  ];
  return {
    available: true,
    status: cleanText(input.status ?? input.state) ?? "Experimental evidence available",
    statusDetail: cleanText(input.statusDetail, 1_000),
    algorithm: cleanText(input.algorithm ?? program.algorithm ?? crypto.algorithm) ?? "ML-DSA-65",
    genesisHash,
    httpRpc: genesisHash ? cleanText(input.httpRpc ?? input.rpc ?? network.httpRpc, 160) ?? (typeof ports.rpc === "number" ? `http://127.0.0.1:${ports.rpc}` : null) : null,
    programId,
    transactions,
    measurements,
    protectedNow,
    stillClassical: cleanList(input.stillClassical ?? input.classical ?? scope.stillClassical),
    checkedAt: cleanText(input.checkedAt ?? input.generatedAt ?? input.recordedAt, 64),
  };
}

export async function readPqEvidence(): Promise<PqEvidence> {
  try {
    const text = await readFile(EVIDENCE_PATH, "utf8");
    if (text.length > 1_000_000) throw new Error("PQ evidence exceeds size limit");
    return parsePqEvidence(JSON.parse(text) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("PQ evidence unavailable", error);
    }
    return {
      available: false,
      status: "Post-quantum validator build in progress",
      statusDetail: null,
      algorithm: "ML-DSA-65 · NIST FIPS 204",
      genesisHash: null,
      httpRpc: null,
      programId: null,
      transactions: [],
      measurements: {},
      protectedNow: ["Off-chain canonical signing and verification prototype"],
      stillClassical: [
        "Native transaction authorization",
        "Validator identity and consensus",
        "Gossip and networking",
        "Source-side Solana wallets and custody",
      ],
      checkedAt: null,
    };
  }
}
