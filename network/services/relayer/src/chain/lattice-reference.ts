import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  Kind,
  PROTOCOL_VERSION,
  burnEventId,
  decodeTransfer,
  equalBytes,
  messageDigest,
  nativeScale,
  transferViolations,
} from "@lattice/protocol/wire";
import { ed25519Verify } from "../vault/client.js";
import {
  Scheme,
  type Binding,
  type BurnReceipt,
  type GuardianSetView,
  type IndexedSignature,
  type LatticeState,
  type LatticeSubmitter,
  type LatticeView,
  type MintRecord,
  type Observed,
} from "./types.js";

export class DestinationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationRejected";
  }
}

/**
 * In-memory reference of the Lattice destination rules (BRIDGE_SPEC §9.1–9.2,
 * signature policy of NATIVE_ISSUANCE §6 for schemes 1 and 3).
 * Not a chain: used by tests and as an executable statement of the rules the
 * native runtime must enforce. `finalityLag` delays visibility of new records
 * to mimic waiting for rooted slots.
 */
export class ReferenceLattice implements LatticeView, LatticeSubmitter {
  slot = 1;
  readonly balances = new Map<string, bigint>();
  private st: LatticeState;
  private readonly sets = new Map<bigint, GuardianSetView>();
  private readonly mints = new Map<bigint, MintRecord>();
  private readonly burns = new Map<bigint, BurnReceipt>();
  mintCalls = 0;

  constructor(
    private readonly binding: Binding,
    guardians: GuardianSetView,
    private readonly finalityLag = 0,
  ) {
    this.sets.set(guardians.epoch, guardians);
    this.st = {
      deploymentId: binding.deploymentId,
      nextBurnSequence: 0n,
      mintedCount: 0n,
      totalMintedNative: 0n,
      totalBurnedNative: 0n,
      guardianEpoch: guardians.epoch,
      flags: 0,
    };
  }

  private visible(slot: bigint) {
    return slot + BigInt(this.finalityLag) <= BigInt(this.slot);
  }

  advance(slots = 1) {
    this.slot += slots;
  }

  rotate(set: GuardianSetView) {
    this.sets.set(set.epoch, set);
    this.st = { ...this.st, guardianEpoch: set.epoch };
  }

  async state(): Promise<Observed<LatticeState>> {
    return { value: { ...this.st }, slot: this.slot };
  }

  async burn(sequence: bigint): Promise<Observed<BurnReceipt | null>> {
    const b = this.burns.get(sequence);
    return { value: b && this.visible(b.slot) ? b : null, slot: this.slot };
  }

  async mintRecord(sequence: bigint): Promise<Observed<MintRecord | null>> {
    const m = this.mints.get(sequence);
    return { value: m && this.visible(m.slot) ? m : null, slot: this.slot };
  }

  async guardianSet(epoch: bigint) {
    return this.sets.get(epoch) ?? null;
  }

  /** §9.1 — atomic, exactly-once mint from an attested DEPOSIT. */
  async mint(message: Uint8Array, signatures: IndexedSignature[]): Promise<string> {
    this.mintCalls += 1;
    const t = decodeTransfer(message);
    const b = this.binding;
    if (t.kind !== Kind.Deposit) throw new DestinationRejected("not a deposit");
    if (message[17] !== PROTOCOL_VERSION) throw new DestinationRejected("version");
    if (
      !equalBytes(t.deploymentId, b.deploymentId) ||
      !equalBytes(t.solanaGenesisHash, b.solanaGenesisHash) ||
      !equalBytes(t.latticeGenesisHash, b.latticeGenesisHash) ||
      !equalBytes(t.sourceProgramId, b.sourceProgramId.toBytes()) ||
      !equalBytes(t.sourceMint, b.sourceMint.toBytes())
    ) {
      throw new DestinationRejected("binding mismatch");
    }
    if (t.signerEpoch !== this.st.guardianEpoch) throw new DestinationRejected("stale epoch");
    const set = this.sets.get(t.signerEpoch)!;
    const scheme = set.scheme ?? Scheme.Ed25519;
    if (t.scheme !== scheme) throw new DestinationRejected("scheme does not match the guardian set");
    const digest = messageDigest(message);
    const seen = new Set<number>();
    for (const s of signatures) {
      const key = set.keys[s.index];
      if (!key || !equalBytes(key, s.publicKey) || !ed25519Verify(key, digest, s.signature)) {
        throw new DestinationRejected(`bad signature from index ${s.index}`);
      }
      if (scheme === Scheme.Hybrid) {
        const mk = set.mldsaKeys?.[s.index];
        if (!mk || !s.mldsaSignature || !ml_dsa65.verify(s.mldsaSignature, digest, mk)) {
          throw new DestinationRejected(`bad ML-DSA-65 signature from index ${s.index}`);
        }
      }
      seen.add(s.index);
    }
    if (seen.size < set.threshold) throw new DestinationRejected("below threshold");
    const v = transferViolations(t, nativeScale(b.sourceDecimals));
    if (v.length) throw new DestinationRejected(v.join(", "));
    if (this.mints.has(t.nonce)) throw new DestinationRejected("already minted");
    this.slot += 1;
    this.mints.set(t.nonce, {
      deploymentId: t.deploymentId,
      depositSequence: t.nonce,
      recipient: t.recipient,
      nativeAmount: t.nativeAmount,
      slot: BigInt(this.slot),
      eventId: t.eventId,
    });
    const k = Buffer.from(t.recipient).toString("hex");
    this.balances.set(k, (this.balances.get(k) ?? 0n) + t.nativeAmount);
    this.st = {
      ...this.st,
      mintedCount: this.st.mintedCount + 1n,
      totalMintedNative: this.st.totalMintedNative + t.nativeAmount,
    };
    return `ref-mint-${t.nonce}`;
  }

  /** §9.2 — burn LAT for a Solana recipient wallet. */
  burnFor(burner: Uint8Array, nativeAmount: bigint, solanaRecipient: Uint8Array): BurnReceipt {
    const scale = nativeScale(this.binding.sourceDecimals);
    if (nativeAmount <= 0n || nativeAmount % scale !== 0n) throw new DestinationRejected("burn must be a positive multiple of the scale");
    if (solanaRecipient.every((x) => x === 0)) throw new DestinationRejected("zero recipient");
    const k = Buffer.from(burner).toString("hex");
    const bal = this.balances.get(k) ?? 0n;
    if (bal < nativeAmount) throw new DestinationRejected("insufficient LAT");
    this.balances.set(k, bal - nativeAmount);
    this.slot += 1;
    const seq = this.st.nextBurnSequence;
    const receipt: BurnReceipt = {
      deploymentId: this.binding.deploymentId,
      burnSequence: seq,
      burner,
      nativeAmount,
      sourceAmount: nativeAmount / scale,
      solanaRecipient,
      slot: BigInt(this.slot),
      eventId: burnEventId(this.binding.deploymentId, seq),
    };
    this.burns.set(seq, receipt);
    this.st = { ...this.st, nextBurnSequence: seq + 1n, totalBurnedNative: this.st.totalBurnedNative + nativeAmount };
    return receipt;
  }
}
