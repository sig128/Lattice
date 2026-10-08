import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { equalBytes, fromHex, messageDigest } from "@lattice/protocol/wire";
import type { AttestResponse } from "./attester/core.js";
import { Scheme, type GuardianSetView, type IndexedSignature } from "./chain/types.js";
import type { Direction } from "./db.js";
import type { Logger } from "./log.js";
import { ed25519Verify } from "./vault/client.js";

export interface AttesterEndpoint {
  label: string;
  attest(direction: Direction, nonce: bigint): Promise<AttestResponse>;
}

export class HttpAttester implements AttesterEndpoint {
  constructor(
    readonly label: string,
    private readonly url: string,
    private readonly token?: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async attest(direction: Direction, nonce: bigint): Promise<AttestResponse> {
    const res = await fetch(new URL("/v1/attest", this.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ direction, nonce: nonce.toString() }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = (await res.json()) as AttestResponse & { error?: string; message?: string };
    if (!res.ok) throw new Error(`${this.label}: ${res.status} ${payload.error ?? ""} ${payload.message ?? ""}`.trim());
    return payload;
  }
}

/**
 * Asks every attester for a signature and keeps only those that (a) are over
 * exactly the message this relayer built, (b) come from a key in `set`, and
 * (c) verify. A guardian returning a different message is a disagreement and
 * is logged as critical. For hybrid sets both signatures must verify, since
 * the destination fails the whole instruction on one bad entry.
 */
export async function collectSignatures(
  endpoints: AttesterEndpoint[],
  direction: Direction,
  nonce: bigint,
  expectedMessage: Uint8Array,
  set: GuardianSetView,
  log: Logger,
): Promise<IndexedSignature[]> {
  const scheme = set.scheme ?? Scheme.Ed25519;
  if (scheme !== Scheme.Ed25519 && scheme !== Scheme.Hybrid) throw new Error(`relayer does not support guardian scheme ${scheme}`);
  const digest = messageDigest(expectedMessage);
  const results = await Promise.allSettled(endpoints.map((e) => e.attest(direction, nonce)));
  const out = new Map<number, IndexedSignature>();
  results.forEach((r, i) => {
    const label = endpoints[i]!.label;
    if (r.status === "rejected") {
      log.warn("attester unavailable", { attester: label, direction, nonce, error: r.reason });
      return;
    }
    const a = r.value;
    const message = fromHex(a.message);
    if (!equalBytes(message, expectedMessage)) {
      log.critical("attester observed a different message", { attester: label, direction, nonce, theirs: a.digest });
      return;
    }
    const key = fromHex(a.guardian);
    const index = set.keys.findIndex((k) => equalBytes(k, key));
    const signature = fromHex(a.signature);
    if (index < 0 || signature.length !== 64 || !ed25519Verify(key, digest, signature)) {
      log.critical("attester returned an invalid or foreign signature", { attester: label, direction, nonce });
      return;
    }
    if (scheme === Scheme.Hybrid) {
      const mldsaSignature = a.mldsaSignature ? fromHex(a.mldsaSignature) : null;
      const mldsaKey = set.mldsaKeys?.[index];
      if (!mldsaSignature || !mldsaKey || !ml_dsa65.verify(mldsaSignature, digest, mldsaKey)) {
        log.critical("attester returned a missing or invalid ML-DSA-65 signature", { attester: label, direction, nonce });
        return;
      }
      out.set(index, { index, publicKey: key, signature, mldsaSignature });
      return;
    }
    out.set(index, { index, publicKey: key, signature });
  });
  return [...out.values()].sort((a, b) => a.index - b.index);
}
