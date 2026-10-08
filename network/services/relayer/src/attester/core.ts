import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { Kind, equalBytes, messageDigest, toHex } from "@lattice/protocol/wire";
import { Scheme, type Binding, type GuardianSetView, type LatticeView, type SourceView } from "../chain/types.js";
import type { Direction } from "../db.js";
import type { Logger } from "../log.js";
import { depositMessage, withdrawalMessage } from "../messages.js";
import { ed25519Sign, type Ed25519Key } from "../vault/client.js";
import type { SigningJournal } from "./journal.js";
import type { MlDsaKey } from "./keyfile.js";

export class NotFinalized extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFinalized";
  }
}

export class NotAGuardian extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAGuardian";
  }
}

export class BindingMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingMismatch";
  }
}

export interface AttestResponse {
  guardian: string;
  direction: Direction;
  nonce: string;
  signerEpoch: string;
  message: string;
  digest: string;
  signature: string;
  /** Present when the Lattice guardian set is hybrid (deposits only). */
  mldsaSignature?: string;
}

/**
 * A guardian. It signs only events it has read itself from its own RPC
 * endpoints at finalized commitment; the caller supplies nothing but the
 * direction and nonce.
 */
export class Attester {
  constructor(
    private readonly key: Ed25519Key,
    private readonly binding: Binding,
    private readonly source: SourceView,
    private readonly lattice: LatticeView,
    private readonly journal: SigningJournal,
    private readonly log: Logger,
    private readonly mldsa?: MlDsaKey,
  ) {}

  get publicKey() {
    return this.key.publicKey;
  }

  private async checkSourceBinding() {
    const cfg = (await this.source.config()).value;
    const b = this.binding;
    if (
      !equalBytes(cfg.deploymentId, b.deploymentId) ||
      !equalBytes(cfg.solanaGenesisHash, b.solanaGenesisHash) ||
      !equalBytes(cfg.latticeGenesisHash, b.latticeGenesisHash) ||
      !cfg.mint.equals(b.sourceMint) ||
      cfg.decimals !== b.sourceDecimals
    ) {
      throw new BindingMismatch("on-chain source-vault configuration does not match this guardian's binding");
    }
    return cfg;
  }

  private member(set: GuardianSetView | null, epoch: bigint, chain: string): GuardianSetView {
    if (!set) throw new NotAGuardian(`${chain} guardian set for epoch ${epoch} not found`);
    const scheme = set.scheme ?? Scheme.Ed25519;
    if (scheme !== Scheme.Ed25519 && scheme !== Scheme.Hybrid) throw new NotAGuardian(`${chain} guardian scheme ${scheme} is not supported`);
    const index = set.keys.findIndex((k) => equalBytes(k, this.key.publicKey));
    if (index < 0) throw new NotAGuardian(`this key is not in the ${chain} guardian set for epoch ${epoch}`);
    if (scheme === Scheme.Hybrid) {
      const expected = set.mldsaKeys?.[index];
      if (!this.mldsa) throw new NotAGuardian(`${chain} guardian set is hybrid but no ML-DSA-65 key is loaded`);
      if (!expected || !equalBytes(expected, this.mldsa.publicKey)) {
        throw new NotAGuardian(`this ML-DSA-65 key does not match guardian ${index} of the ${chain} set for epoch ${epoch}`);
      }
    }
    return set;
  }

  async attest(direction: Direction, nonce: bigint): Promise<AttestResponse> {
    const cfg = await this.checkSourceBinding();
    let message: Uint8Array;
    let epoch: bigint;
    let kind: number;
    let hybrid = false;
    if (direction === "deposit") {
      const r = (await this.source.receipt(nonce)).value;
      if (!r) throw new NotFinalized(`deposit ${nonce} is not finalized on Solana`);
      const state = (await this.lattice.state()).value;
      epoch = state.guardianEpoch;
      const set = this.member(await this.lattice.guardianSet(epoch), epoch, "Lattice");
      const scheme = set.scheme ?? Scheme.Ed25519;
      hybrid = scheme === Scheme.Hybrid;
      message = depositMessage(this.binding, r, epoch, scheme).message;
      kind = Kind.Deposit;
    } else {
      const b = (await this.lattice.burn(nonce)).value;
      if (!b) throw new NotFinalized(`burn ${nonce} is not finalized on Lattice`);
      epoch = cfg.epoch;
      this.member(await this.source.guardianSet(epoch), epoch, "Solana");
      message = withdrawalMessage(this.binding, b, epoch).message;
      kind = Kind.Withdrawal;
    }
    const digest = messageDigest(message);
    this.journal.record(kind, nonce, epoch, toHex(digest));
    const signature = ed25519Sign(this.key, digest);
    const mldsaSignature = hybrid ? ml_dsa65.sign(digest, this.mldsa!.secretKey) : undefined;
    this.log.info("attested", { direction, nonce, epoch, digest });
    return {
      guardian: toHex(this.key.publicKey),
      direction,
      nonce: nonce.toString(),
      signerEpoch: epoch.toString(),
      message: toHex(message),
      digest: toHex(digest),
      signature: toHex(signature),
      ...(mldsaSignature ? { mldsaSignature: toHex(mldsaSignature) } : {}),
    };
  }
}
