import { PublicKey, type AccountInfo, type Commitment, type RpcResponseAndContext } from "@solana/web3.js";
import type { Logger } from "../log.js";

/** Minimal RPC surface; `@solana/web3.js` `Connection` satisfies it. */
export interface RpcLike {
  getGenesisHash(): Promise<string>;
  getAccountInfoAndContext(
    address: PublicKey,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>>;
  getSlot(commitment?: Commitment): Promise<number>;
}

export interface Endpoint {
  label: string;
  rpc: RpcLike;
}

export class RpcDisagreement extends Error {
  constructor(
    message: string,
    readonly observations: { label: string; summary: string }[],
  ) {
    super(message);
    this.name = "RpcDisagreement";
  }
}

export class InsufficientQuorum extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientQuorum";
  }
}

export interface QuorumAccount {
  exists: boolean;
  owner: PublicKey | null;
  data: Uint8Array | null;
  /** Lowest finalized context slot among agreeing endpoints. */
  slot: number;
  agreeing: string[];
}

const COMMITMENT: Commitment = "finalized";

/**
 * Reads finalized state from several independent RPC endpoints and only
 * returns a value when at least `quorum` endpoints with the expected genesis
 * agree byte-for-byte and **no** responding endpoint disagrees.
 */
export class QuorumReader {
  private genesisChecked = new Set<string>();

  constructor(
    readonly name: string,
    private readonly endpoints: Endpoint[],
    private readonly quorum: number,
    private readonly expectedGenesis: string,
    private readonly log: Logger,
    private readonly timeoutMs = 10_000,
  ) {
    if (quorum < 1 || quorum > endpoints.length) throw new Error(`${name}: quorum ${quorum} not satisfiable`);
    const labels = new Set(endpoints.map((e) => e.label));
    if (labels.size !== endpoints.length) throw new Error(`${name}: duplicate endpoint labels`);
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out`)), this.timeoutMs);
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      );
    });
  }

  /** Verifies every endpoint's genesis once; endpoints with another genesis are excluded and reported. */
  async verifyGenesis(): Promise<string[]> {
    const bad: string[] = [];
    await Promise.all(
      this.endpoints.map(async (e) => {
        try {
          const g = await this.withTimeout(e.rpc.getGenesisHash(), e.label);
          if (g === this.expectedGenesis) this.genesisChecked.add(e.label);
          else {
            this.genesisChecked.delete(e.label);
            bad.push(e.label);
            this.log.critical("rpc genesis mismatch", { chain: this.name, endpoint: e.label, got: g, expected: this.expectedGenesis });
          }
        } catch (error) {
          this.genesisChecked.delete(e.label);
          this.log.warn("rpc genesis unavailable", { chain: this.name, endpoint: e.label, error });
        }
      }),
    );
    return bad;
  }

  private async eligible(): Promise<Endpoint[]> {
    if (this.genesisChecked.size < this.quorum) await this.verifyGenesis();
    const ok = this.endpoints.filter((e) => this.genesisChecked.has(e.label));
    if (ok.length < this.quorum) {
      throw new InsufficientQuorum(`${this.name}: ${ok.length} genesis-verified endpoints, need ${this.quorum}`);
    }
    return ok;
  }

  /**
   * `immutable` records (receipts, consumed markers) must be byte-identical
   * everywhere. Mutable accounts may differ across endpoints at different
   * finalized slots (reported as not converged); a difference at the same
   * slot is a disagreement.
   */
  async getAccount(address: PublicKey, opts: { immutable?: boolean } = {}): Promise<QuorumAccount> {
    const immutable = opts.immutable ?? true;
    const endpoints = await this.eligible();
    const results = await Promise.allSettled(
      endpoints.map(async (e) => ({ label: e.label, res: await this.withTimeout(e.rpc.getAccountInfoAndContext(address, COMMITMENT), e.label) })),
    );
    const views: { label: string; key: string; slot: number; value: AccountInfo<Buffer> | null }[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const v = r.value.res.value;
        const key = v ? `${v.owner.toBase58()}:${Buffer.from(v.data).toString("hex")}` : "absent";
        views.push({ label: r.value.label, key, slot: r.value.res.context.slot, value: v });
      } else {
        this.log.warn("rpc read failed", { chain: this.name, address: address.toBase58(), error: r.reason });
      }
    }
    const distinct = new Set(views.map((v) => v.key));
    if (distinct.size > 1) {
      // An account that exists at a higher finalized slot but not at a lower one is lag, not a lie.
      const present = views.filter((v) => v.key !== "absent");
      const presentKeys = new Set(present.map((v) => v.key));
      const absentAbove = views.some((v) => v.key === "absent" && present.some((p) => v.slot >= p.slot));
      const sameSlotConflict = views.some((a) => views.some((b) => a.slot === b.slot && a.key !== b.key));
      if ((immutable && (presentKeys.size > 1 || absentAbove)) || sameSlotConflict) {
        throw new RpcDisagreement(
          `${this.name}: endpoints disagree on ${address.toBase58()}`,
          views.map((v) => ({ label: v.label, summary: `${v.key.slice(0, 80)}@${v.slot}` })),
        );
      }
      throw new InsufficientQuorum(`${this.name}: ${address.toBase58()} not converged across endpoints`);
    }
    if (views.length < this.quorum) {
      throw new InsufficientQuorum(`${this.name}: ${views.length} responses, need ${this.quorum}`);
    }
    const first = views[0]!.value;
    return {
      exists: first !== null,
      owner: first?.owner ?? null,
      data: first ? new Uint8Array(first.data) : null,
      slot: Math.min(...views.map((v) => v.slot)),
      agreeing: views.map((v) => v.label),
    };
  }

  /** Lowest finalized slot across a quorum of endpoints (a conservative watermark). */
  async finalizedSlot(): Promise<number> {
    const endpoints = await this.eligible();
    const slots = (
      await Promise.allSettled(endpoints.map((e) => this.withTimeout(e.rpc.getSlot(COMMITMENT), e.label)))
    ).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (slots.length < this.quorum) throw new InsufficientQuorum(`${this.name}: slot quorum unavailable`);
    return Math.min(...slots);
  }
}
