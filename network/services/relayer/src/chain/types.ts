import type { PublicKey } from "@solana/web3.js";
import type {
  ConsumedWithdrawal,
  DepositReceipt,
  GuardianSetAccount,
  VaultConfig,
} from "../vault/client.js";

export interface Observed<T> {
  value: T;
  slot: number;
}

/** Signature schemes (BRIDGE_SPEC §3.3). Solana accepts only Ed25519. */
export const Scheme = { Ed25519: 1, MlDsa65: 2, Hybrid: 3 } as const;

export interface GuardianSetView {
  epoch: bigint;
  threshold: number;
  /** Ed25519 keys by guardian index (schemes 1 and 3). */
  keys: Uint8Array[];
  /** Defaults to Ed25519. */
  scheme?: number;
  /** ML-DSA-65 public keys by guardian index (schemes 2 and 3). */
  mldsaKeys?: Uint8Array[];
}

export interface IndexedSignature {
  index: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
  /** ML-DSA-65 signature over the same digest (hybrid sets only). */
  mldsaSignature?: Uint8Array;
}

/** Finalized, quorum-checked reads of the Solana source vault. */
export interface SourceView {
  config(): Promise<Observed<VaultConfig>>;
  receipt(sequence: bigint): Promise<Observed<DepositReceipt | null>>;
  consumed(nonce: bigint): Promise<Observed<ConsumedWithdrawal | null>>;
  guardianSet(epoch: bigint): Promise<GuardianSetAccount | null>;
  vaultBalance(vault: PublicKey): Promise<Observed<bigint>>;
}

export interface SourceSubmitter {
  /** Posts signatures and submits Release. Idempotent; the program rejects duplicates. */
  release(message: Uint8Array, epoch: bigint, signatures: IndexedSignature[], recipientOwner: PublicKey): Promise<string>;
}

export interface LatticeState {
  deploymentId: Uint8Array;
  nextBurnSequence: bigint;
  mintedCount: bigint;
  totalMintedNative: bigint;
  totalBurnedNative: bigint;
  guardianEpoch: bigint;
  flags: number;
}

export interface BurnReceipt {
  deploymentId: Uint8Array;
  burnSequence: bigint;
  burner: Uint8Array;
  nativeAmount: bigint;
  sourceAmount: bigint;
  solanaRecipient: Uint8Array;
  slot: bigint;
  eventId: Uint8Array;
}

export interface MintRecord {
  deploymentId: Uint8Array;
  depositSequence: bigint;
  recipient: Uint8Array;
  nativeAmount: bigint;
  slot: bigint;
  eventId: Uint8Array;
}

/** Finalized, quorum-checked reads of the Lattice native bridge (spec §9). */
export interface LatticeView {
  state(): Promise<Observed<LatticeState>>;
  burn(sequence: bigint): Promise<Observed<BurnReceipt | null>>;
  mintRecord(sequence: bigint): Promise<Observed<MintRecord | null>>;
  guardianSet(epoch: bigint): Promise<GuardianSetView | null>;
}

export interface LatticeSubmitter {
  mint(message: Uint8Array, signatures: IndexedSignature[]): Promise<string>;
}

/** Immutable deployment binding shared by relayer and attesters. */
export interface Binding {
  deploymentId: Uint8Array;
  solanaGenesisHash: Uint8Array;
  latticeGenesisHash: Uint8Array;
  sourceProgramId: PublicKey;
  sourceMint: PublicKey;
  sourceDecimals: number;
}
