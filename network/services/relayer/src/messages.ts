import {
  Kind,
  burnEventId,
  depositEventId,
  encodeTransfer,
  equalBytes,
  nativeScale,
  transferViolations,
  type TransferMessage,
} from "@lattice/protocol/wire";
import type { Binding, BurnReceipt } from "./chain/types.js";
import type { DepositReceipt } from "./vault/client.js";

export class InvalidEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvent";
  }
}

function header(b: Binding, epoch: bigint, nonce: bigint, scheme = 1) {
  return {
    scheme,
    deploymentId: b.deploymentId,
    solanaGenesisHash: b.solanaGenesisHash,
    latticeGenesisHash: b.latticeGenesisHash,
    sourceProgramId: b.sourceProgramId.toBytes(),
    sourceMint: b.sourceMint.toBytes(),
    signerEpoch: epoch,
    nonce,
  };
}

/**
 * DEPOSIT message from a finalized Solana receipt. `latticeEpoch` and
 * `latticeScheme` come from the current Lattice guardian set; the header's
 * scheme must equal the set's scheme there.
 */
export function depositMessage(
  b: Binding,
  r: DepositReceipt,
  latticeEpoch: bigint,
  latticeScheme = 1,
): { message: Uint8Array; transfer: TransferMessage } {
  if (!equalBytes(r.deploymentId, b.deploymentId)) throw new InvalidEvent("receipt deployment mismatch");
  if (!equalBytes(r.eventId, depositEventId(b.deploymentId, r.sequence))) throw new InvalidEvent("receipt event id mismatch");
  const transfer: TransferMessage = {
    ...header(b, latticeEpoch, r.sequence, latticeScheme),
    kind: Kind.Deposit,
    sourceAmount: r.credited,
    nativeAmount: r.native,
    recipient: r.latticeRecipient,
    eventId: r.eventId,
  };
  const v = transferViolations(transfer, nativeScale(b.sourceDecimals));
  if (v.length) throw new InvalidEvent(`deposit ${r.sequence}: ${v.join(", ")}`);
  return { message: encodeTransfer(transfer), transfer };
}

/** WITHDRAWAL message from a finalized Lattice burn; `solanaEpoch` is the source-vault guardian epoch. */
export function withdrawalMessage(b: Binding, burn: BurnReceipt, solanaEpoch: bigint): { message: Uint8Array; transfer: TransferMessage } {
  if (!equalBytes(burn.deploymentId, b.deploymentId)) throw new InvalidEvent("burn deployment mismatch");
  if (!equalBytes(burn.eventId, burnEventId(b.deploymentId, burn.burnSequence))) throw new InvalidEvent("burn event id mismatch");
  const scale = nativeScale(b.sourceDecimals);
  if (burn.nativeAmount % scale !== 0n || burn.nativeAmount / scale !== burn.sourceAmount) {
    throw new InvalidEvent(`burn ${burn.burnSequence}: amount not an exact multiple of the scale`);
  }
  const transfer: TransferMessage = {
    ...header(b, solanaEpoch, burn.burnSequence),
    kind: Kind.Withdrawal,
    sourceAmount: burn.sourceAmount,
    nativeAmount: burn.nativeAmount,
    recipient: burn.solanaRecipient,
    eventId: burn.eventId,
  };
  const v = transferViolations(transfer, scale);
  if (v.length) throw new InvalidEvent(`burn ${burn.burnSequence}: ${v.join(", ")}`);
  return { message: encodeTransfer(transfer), transfer };
}
