import { mkdirSync, openSync, readFileSync, writeSync, fsyncSync, closeSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export class Equivocation extends Error {
  constructor(
    message: string,
    readonly previousDigest: string,
  ) {
    super(message);
    this.name = "Equivocation";
  }
}

interface Entry {
  kind: number;
  nonce: string;
  epoch: string;
  digest: string;
  at: string;
}

/**
 * Append-only signing journal. An entry is fsynced *before* a signature is
 * released, so after a crash the guardian still refuses to sign a different
 * digest for the same (kind, nonce, epoch).
 */
export class SigningJournal {
  private readonly entries = new Map<string, string>();
  private readonly fd: number;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as Entry;
        const key = SigningJournal.key(e.kind, BigInt(e.nonce), BigInt(e.epoch));
        const prior = this.entries.get(key);
        if (prior && prior !== e.digest) throw new Equivocation(`journal already contains conflicting entries for ${key}`, prior);
        this.entries.set(key, e.digest);
      }
    }
    this.fd = openSync(path, "a", 0o600);
  }

  static key(kind: number, nonce: bigint, epoch: bigint) {
    return `${kind}:${nonce}:${epoch}`;
  }

  /** Records intent to sign; throws Equivocation on a conflicting prior entry. */
  record(kind: number, nonce: bigint, epoch: bigint, digestHex: string): void {
    const key = SigningJournal.key(kind, nonce, epoch);
    const prior = this.entries.get(key);
    if (prior === digestHex) return;
    if (prior) throw new Equivocation(`refusing to sign a second digest for ${key}`, prior);
    const entry: Entry = { kind, nonce: nonce.toString(), epoch: epoch.toString(), digest: digestHex, at: new Date().toISOString() };
    writeSync(this.fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(this.fd);
    this.entries.set(key, digestHex);
  }

  size() {
    return this.entries.size;
  }

  close() {
    closeSync(this.fd);
  }
}
