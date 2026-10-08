import { PublicKey } from "@solana/web3.js";
import { equalBytes, messageDigest } from "@lattice/protocol/wire";
import {
  Scheme,
  type Binding,
  type GuardianSetView,
  type IndexedSignature,
  type LatticeSubmitter,
  type LatticeView,
  type SourceSubmitter,
  type SourceView,
} from "./chain/types.js";
import { ConcurrentUpdate, type Claim, type ClaimStore, type Direction } from "./db.js";
import { collectSignatures, type AttesterEndpoint } from "./guardians.js";
import type { Logger } from "./log.js";
import { InvalidEvent, depositMessage, withdrawalMessage } from "./messages.js";
import { InsufficientQuorum, RpcDisagreement } from "./rpc/quorum.js";

export type FaultPoint = "after-finalize" | "after-signatures" | "after-attempt-recorded" | "after-submit" | "before-complete";

export interface EngineOptions {
  scanBatch: number;
  resubmitAfterMs: number;
  maxAttempts: number;
}

export interface EngineDeps {
  store: ClaimStore;
  source: SourceView;
  sourceSubmitter: SourceSubmitter;
  lattice: LatticeView;
  latticeSubmitter: LatticeSubmitter;
  attesters: AttesterEndpoint[];
  binding: Binding;
  log: Logger;
  options?: Partial<EngineOptions>;
  /** Test hook: throwing here simulates a crash at that point. */
  faults?: (point: FaultPoint, claim: Claim) => void;
}

export class BindingMismatch extends Error {}

export interface TickReport {
  discovered: number;
  advanced: number;
  errors: number;
  halted: string[];
}

const LATTICE_MINT_PAUSED = 1;

/**
 * Durable bridge state machine. All state lives in PostgreSQL; every step
 * re-reads chain state and is safe to repeat, so a crash at any point is
 * recovered by running `tick()` again (in this or a new process). Destination
 * consumption records are the source of truth for completion.
 */
export class Engine {
  private readonly opt: EngineOptions;

  constructor(private readonly d: EngineDeps) {
    this.opt = { scanBatch: 50, resubmitAfterMs: 60_000, maxAttempts: 20, ...d.options };
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { discovered: 0, advanced: 0, errors: 0, halted: [] };
    for (const direction of ["deposit", "withdrawal"] as const) {
      try {
        report.discovered += await this.scan(direction);
      } catch (e) {
        if (e instanceof BindingMismatch) throw e;
        report.errors += 1;
        const level = e instanceof RpcDisagreement ? "critical" : e instanceof InsufficientQuorum ? "warn" : "error";
        this.d.log[level]("scan failed", { direction, error: e });
      }
    }
    for (const direction of ["deposit", "withdrawal"] as const) {
      for (const claim of await this.d.store.active(this.d.binding.deploymentId, direction)) {
        try {
          if (await this.advance(claim)) report.advanced += 1;
        } catch (e) {
          report.errors += 1;
          const ctx = { direction, nonce: claim.nonce, state: claim.state, error: e };
          if (e instanceof ConcurrentUpdate) this.d.log.info("claim moved concurrently", ctx);
          else if (e instanceof InsufficientQuorum) this.d.log.warn("waiting for RPC quorum", ctx);
          else if (e instanceof RpcDisagreement) {
            report.halted.push(`${direction}/${claim.nonce}`);
            this.d.log.critical("rpc disagreement; event halted", { ...ctx, observations: e.observations });
          } else this.d.log.error("claim step failed", ctx);
        }
      }
    }
    return report;
  }

  private async checkBinding() {
    const cfg = (await this.d.source.config()).value;
    const b = this.d.binding;
    if (
      !equalBytes(cfg.deploymentId, b.deploymentId) ||
      !equalBytes(cfg.solanaGenesisHash, b.solanaGenesisHash) ||
      !equalBytes(cfg.latticeGenesisHash, b.latticeGenesisHash) ||
      !cfg.mint.equals(b.sourceMint) ||
      cfg.decimals !== b.sourceDecimals
    ) {
      this.d.log.critical("source-vault configuration does not match the relayer binding");
      throw new BindingMismatch("binding mismatch");
    }
    return cfg;
  }

  /** Discovers new events from finalized on-chain counters. */
  private async scan(direction: Direction): Promise<number> {
    const { store, binding } = this.d;
    const from = await store.nextUnseen(binding.deploymentId, direction);
    let upTo: bigint;
    if (direction === "deposit") {
      upTo = (await this.checkBinding()).nextDepositSequence;
    } else {
      const st = (await this.d.lattice.state()).value;
      if (!equalBytes(st.deploymentId, binding.deploymentId)) throw new BindingMismatch("Lattice deployment mismatch");
      upTo = st.nextBurnSequence;
    }
    let n = 0;
    for (let seq = from; seq < upTo && seq < from + BigInt(this.opt.scanBatch); seq++) {
      const obs = direction === "deposit" ? await this.d.source.receipt(seq) : await this.d.lattice.burn(seq);
      if (!obs.value) break;
      if (await store.insertObserved({ deploymentId: binding.deploymentId, direction, nonce: seq, eventId: obs.value.eventId, observedSlot: BigInt(obs.slot) })) n++;
    }
    return n;
  }

  private async currentEpoch(direction: Direction): Promise<bigint> {
    return direction === "deposit" ? (await this.d.lattice.state()).value.guardianEpoch : (await this.d.source.config()).value.epoch;
  }

  private async guardianSet(direction: Direction, epoch: bigint): Promise<GuardianSetView> {
    const set = direction === "deposit" ? await this.d.lattice.guardianSet(epoch) : await this.d.source.guardianSet(epoch);
    if (!set) throw new InsufficientQuorum(`${direction} guardian set ${epoch} not visible`);
    return set;
  }

  private async build(claim: Claim, epoch: bigint) {
    const { binding } = this.d;
    if (claim.direction === "deposit") {
      const r = await this.d.source.receipt(claim.nonce);
      if (!r.value) throw new InsufficientQuorum("receipt not visible at finalized");
      const set = await this.guardianSet("deposit", epoch);
      const { message, transfer } = depositMessage(binding, r.value, epoch, set.scheme ?? Scheme.Ed25519);
      return { message, transfer, slot: r.slot };
    }
    const b = await this.d.lattice.burn(claim.nonce);
    if (!b.value) throw new InsufficientQuorum("burn not visible at finalized");
    const { message, transfer } = withdrawalMessage(binding, b.value, epoch);
    return { message, transfer, slot: b.slot };
  }

  /** Destination consumption record (finalized), or null. */
  private async consumed(claim: Claim) {
    if (claim.direction === "deposit") {
      const m = (await this.d.lattice.mintRecord(claim.nonce)).value;
      if (!m) return null;
      const ok = equalBytes(m.eventId, claim.eventId) && m.nativeAmount === claim.nativeAmount && equalBytes(m.recipient, claim.recipient!);
      return { ok, slot: m.slot };
    }
    const c = (await this.d.source.consumed(claim.nonce)).value;
    if (!c) return null;
    const ok = equalBytes(c.eventId, claim.eventId) && c.amount === claim.sourceAmount && equalBytes(c.recipient.toBytes(), claim.recipient!);
    return { ok, slot: c.slot };
  }

  /**
   * Makes sure the claim's message targets the current verifying epoch and
   * that at least `threshold` verified signatures are stored for its digest.
   */
  private async ensureSignatures(claim: Claim): Promise<{ claim: Claim; sigs: IndexedSignature[]; threshold: number } | null> {
    const epoch = await this.currentEpoch(claim.direction);
    if (claim.signerEpoch !== epoch) {
      const { message } = await this.build(claim, epoch);
      this.d.log.info("re-targeting claim to new guardian epoch", { direction: claim.direction, nonce: claim.nonce, from: claim.signerEpoch, to: epoch });
      claim = await this.d.store.patch(claim, { message, digest: messageDigest(message), signerEpoch: epoch }, { retargetedEpoch: epoch.toString() });
    }
    const set = await this.guardianSet(claim.direction, epoch);
    let sigs = await this.d.store.signatures(claim.digest!);
    if (sigs.length < set.threshold) {
      const fresh = await collectSignatures(this.d.attesters, claim.direction, claim.nonce, claim.message!, set, this.d.log);
      for (const s of fresh) await this.d.store.storeSignature(claim.digest!, s);
      this.d.faults?.("after-signatures", claim);
      sigs = await this.d.store.signatures(claim.digest!);
    }
    if ((set.scheme ?? Scheme.Ed25519) === Scheme.Hybrid) sigs = sigs.filter((s) => s.mldsaSignature);
    return sigs.length >= set.threshold ? { claim, sigs: sigs.slice(0, set.threshold), threshold: set.threshold } : null;
  }

  private async submit(claim: Claim): Promise<Claim | null> {
    const ready = await this.ensureSignatures(claim);
    if (!ready) return null;
    claim = ready.claim;
    if (claim.direction === "withdrawal" && (await this.d.source.config()).value.withdrawalsPaused) {
      this.d.log.warn("withdrawals paused on Solana; holding release", { nonce: claim.nonce });
      return null;
    }
    if (claim.direction === "deposit" && ((await this.d.lattice.state()).value.flags & LATTICE_MINT_PAUSED) !== 0) {
      this.d.log.warn("minting paused on Lattice; holding", { nonce: claim.nonce });
      return null;
    }
    if (claim.submitAttempts >= this.opt.maxAttempts) {
      this.d.log.error("submission attempts exhausted; operator action required", { direction: claim.direction, nonce: claim.nonce });
      return null;
    }
    claim = await this.d.store.recordAttempt(claim);
    this.d.faults?.("after-attempt-recorded", claim);
    try {
      const tx =
        claim.direction === "deposit"
          ? await this.d.latticeSubmitter.mint(claim.message!, ready.sigs)
          : await this.d.sourceSubmitter.release(claim.message!, claim.signerEpoch!, ready.sigs, new PublicKey(claim.recipient!));
      this.d.faults?.("after-submit", claim);
      await this.d.store.recordSubmitTx(claim, tx);
      this.d.log.info("submitted", { direction: claim.direction, nonce: claim.nonce, tx });
    } catch (e) {
      // A duplicate or concurrent submission is expected to fail on chain; completion is judged from consumption.
      this.d.log.warn("submission failed", { direction: claim.direction, nonce: claim.nonce, error: e });
    }
    return claim;
  }

  /** Executes at most one transition. Returns true if the claim changed state. */
  async advance(claim: Claim): Promise<boolean> {
    const { store, log } = this.d;
    try {
      switch (claim.state) {
        case "observed": {
          const epoch = await this.currentEpoch(claim.direction);
          const { message, transfer, slot } = await this.build(claim, epoch);
          if (!equalBytes(transfer.eventId, claim.eventId)) throw new InvalidEvent("event id changed since observation");
          await store.transition(claim, "finalized", {
            sourceAmount: transfer.sourceAmount,
            nativeAmount: transfer.nativeAmount,
            recipient: transfer.recipient,
            finalizedSlot: BigInt(slot),
            message,
            digest: messageDigest(message),
            signerEpoch: epoch,
          });
          this.d.faults?.("after-finalize", claim);
          return true;
        }
        case "finalized": {
          const ready = await this.ensureSignatures(claim);
          if (!ready) return false;
          await store.transition(ready.claim, "authorized", {}, { signatures: ready.sigs.map((s) => s.index) });
          return true;
        }
        case "authorized": {
          const done = await this.consumed(claim);
          if (done) {
            await store.transition(claim, "submitted", {}, { alreadyConsumed: true });
            return true;
          }
          const after = await this.submit(claim);
          if (!after) return false;
          await store.transition(after, "submitted", {}, { attempt: after.submitAttempts });
          return true;
        }
        case "submitted": {
          this.d.faults?.("before-complete", claim);
          const done = await this.consumed(claim);
          if (done && done.ok) {
            await store.transition(claim, "completed", { completedSlot: done.slot });
            log.info("completed", { direction: claim.direction, nonce: claim.nonce, slot: done.slot });
            return true;
          }
          if (done && !done.ok) {
            log.critical("destination consumption record does not match the claim", { direction: claim.direction, nonce: claim.nonce });
            await store.transition(claim, "failed", { failureReason: "consumption record mismatch" });
            return true;
          }
          const age = claim.lastSubmitAt ? Date.now() - claim.lastSubmitAt.getTime() : Infinity;
          if (age >= this.opt.resubmitAfterMs) await this.submit(claim);
          return false;
        }
        default:
          return false;
      }
    } catch (e) {
      if (e instanceof InvalidEvent && (claim.state === "observed" || claim.state === "finalized")) {
        log.critical("invalid bridge event; marking failed", { direction: claim.direction, nonce: claim.nonce, error: e });
        await store.transition(claim, "failed", { failureReason: e.message });
        return true;
      }
      throw e;
    }
  }
}
