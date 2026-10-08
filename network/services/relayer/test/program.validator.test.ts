import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createInitializeDefaultAccountStateInstruction,
  createInitializeInterestBearingMintInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getMintLen,
  mintTo,
  tokenMetadataInitialize,
} from "@solana/spl-token";
import {
  Kind,
  burnEventId,
  deploymentId,
  encodeRotateGuardians,
  encodeSetLimits,
  encodeSetPause,
  encodeTransfer,
  messageDigest,
  type Header,
  type TransferMessage,
} from "@lattice/protocol/wire";
import {
  VaultError,
  decodeConfig,
  decodeConsumed,
  decodeGuardianSet,
  decodeReceipt,
  depositIx,
  ed25519MultiIx,
  ed25519Sign,
  initializeIx,
  pauseIx,
  postSignaturesIx,
  vaultAddresses,
  type InitializeParams,
} from "../src/vault/client.js";
import {
  attest,
  connection,
  deployVault,
  expectCode,
  expectFailure,
  fund,
  governTx,
  guardian,
  releaseTx,
  send,
  validatorReachable,
} from "./helpers/validator.js";

const enabled = process.env.RUN_VALIDATOR_TESTS === "1" && (await validatorReachable());
const UNIT = 1_000_000n; // 6-decimal source token

describe.skipIf(!enabled)("source-vault on a real validator (legacy SPL Token)", () => {
  const authority = Keypair.generate();
  const pauser = Keypair.generate();
  const depositor = Keypair.generate();
  const recipient = Keypair.generate();
  const attacker = Keypair.generate();
  const g = [guardian(), guardian(), guardian()];
  const next = [guardian(), guardian(), guardian()];
  const latticeRecipient = randomBytes(32);
  const latticeGenesis = randomBytes(32);
  const deployment = deploymentId(`lattice-test-${Date.now()}`);
  let programId: PublicKey;
  let mint: PublicKey;
  let otherMint: PublicKey;
  let depositorToken: PublicKey;
  let recipientToken: PublicKey;
  let attackerToken: PublicKey;
  let solanaGenesis: Uint8Array;
  let addr: ReturnType<typeof vaultAddresses>;
  let epoch = 1n;
  let governanceNonce = 0n;
  let nextBurn = 0n;

  const params = (over: Partial<InitializeParams> = {}): InitializeParams => ({
    deploymentId: deployment,
    solanaGenesisHash: solanaGenesis,
    latticeGenesisHash: latticeGenesis,
    pauser: pauser.publicKey,
    depositCap: 10_000n * UNIT,
    rateWindowSecs: 86_400n,
    maxDepositPerWindow: 5_000n * UNIT,
    maxWithdrawalPerWindow: 3_000n * UNIT,
    threshold: 2,
    guardians: g.map((k) => k.publicKey),
    ...over,
  });

  const header = (): Omit<Header, "kind"> => ({
    deploymentId: deployment,
    solanaGenesisHash: solanaGenesis,
    latticeGenesisHash: latticeGenesis,
    sourceProgramId: programId.toBytes(),
    sourceMint: mint.toBytes(),
    signerEpoch: epoch,
    nonce: governanceNonce,
  });

  const withdrawal = (amount: bigint, over: Partial<TransferMessage> = {}): TransferMessage => {
    const nonce = over.nonce ?? nextBurn;
    return {
      ...header(),
      kind: Kind.Withdrawal,
      nonce,
      sourceAmount: amount,
      nativeAmount: amount * 1000n,
      recipient: recipient.publicKey.toBytes(),
      eventId: burnEventId(deployment, nonce),
      ...over,
    };
  };

  const release = (msg: Uint8Array, nonce: bigint, token = recipientToken) =>
    releaseTx(
      { programId, payer: authority, epoch, nonce, recipientToken: token, mint, tokenProgram: TOKEN_PROGRAM_ID },
      msg,
    );

  const deposit = (amount: bigint, seq: bigint, to: Uint8Array = latticeRecipient): TransactionInstruction =>
    depositIx(programId, depositor.publicKey, depositorToken, mint, TOKEN_PROGRAM_ID, seq, amount, to);

  const config = async () => decodeConfig((await connection.getAccountInfo(addr.config))!.data);
  const balance = async (a: PublicKey) => (await getAccount(connection, a, "confirmed")).amount;

  async function governance(message: Uint8Array, signers = g, newSet?: PublicKey) {
    await attest(programId, authority, epoch, message, signers);
    await governTx(programId, authority, epoch, message, newSet);
    governanceNonce += 1n;
  }

  beforeAll(async () => {
    await Promise.all([authority, depositor, attacker].map((k) => fund(k.publicKey, 50)));
    await fund(pauser.publicKey, 1);
    solanaGenesis = new PublicKey(await connection.getGenesisHash()).toBytes();
    programId = await deployVault(authority);
    addr = vaultAddresses(programId);
    mint = await createMint(connection, authority, authority.publicKey, null, 6);
    otherMint = await createMint(connection, authority, authority.publicKey, null, 6);
    depositorToken = await createAssociatedTokenAccountIdempotent(connection, depositor, mint, depositor.publicKey);
    recipientToken = await createAssociatedTokenAccountIdempotent(connection, depositor, mint, recipient.publicKey);
    attackerToken = await createAssociatedTokenAccountIdempotent(connection, attacker, mint, attacker.publicKey);
    await mintTo(connection, authority, mint, depositorToken, authority, 1_000_000n * UNIT);
  }, 300_000);

  it("only the upgrade authority can initialize, with a valid mint and guardian set", async () => {
    await expectCode(
      send([initializeIx(programId, attacker.publicKey, mint, TOKEN_PROGRAM_ID, params())], [attacker]),
      VaultError.NotAuthorizedInitializer,
    );
    const frozenMint = await createMint(connection, authority, authority.publicKey, authority.publicKey, 6);
    await expectCode(
      send([initializeIx(programId, authority.publicKey, frozenMint, TOKEN_PROGRAM_ID, params())], [authority]),
      VaultError.FreezeAuthorityPresent,
    );
    await expectCode(
      send([initializeIx(programId, authority.publicKey, mint, TOKEN_PROGRAM_ID, params({ threshold: 1 }))], [authority]),
      VaultError.InvalidGuardianSet,
    );
    await expectCode(
      send([initializeIx(programId, authority.publicKey, mint, TOKEN_PROGRAM_ID, params({ rateWindowSecs: 0n }))], [authority]),
      VaultError.InvalidLimits,
    );
    await expectCode(
      send([initializeIx(programId, authority.publicKey, mint, TOKEN_2022_PROGRAM_ID, params())], [authority]),
      VaultError.UnsupportedTokenProgram,
    );
    await send([initializeIx(programId, authority.publicKey, mint, TOKEN_PROGRAM_ID, params())], [authority]);
    const c = await config();
    expect(c.mint.equals(mint)).toBe(true);
    expect(c.vault.equals(addr.vault)).toBe(true);
    expect(c.epoch).toBe(1n);
    expect(Buffer.from(c.latticeGenesisHash).equals(latticeGenesis)).toBe(true);
    const gs = decodeGuardianSet((await connection.getAccountInfo(addr.guardianSet(1n)))!.data);
    expect(gs.threshold).toBe(2);
    const vault = await getAccount(connection, addr.vault, "confirmed");
    expect(vault.owner.equals(addr.vaultAuthority)).toBe(true);
    // Binding is immutable: a second initialize cannot retarget the deployment.
    await expectFailure(
      send([initializeIx(programId, authority.publicKey, otherMint, TOKEN_PROGRAM_ID, params())], [authority]),
    );
  });

  it("records a deposit receipt with the measured credited amount", async () => {
    await send([deposit(100n * UNIT, 0n)], [depositor]);
    const r = decodeReceipt((await connection.getAccountInfo(addr.receipt(0n)))!.data);
    expect(r.sequence).toBe(0n);
    expect(r.credited).toBe(100n * UNIT);
    expect(r.native).toBe(100n * UNIT * 1000n);
    expect(r.depositor.equals(depositor.publicKey)).toBe(true);
    expect(Buffer.from(r.latticeRecipient).equals(latticeRecipient)).toBe(true);
    const c = await config();
    expect(c.nextDepositSequence).toBe(1n);
    expect(c.totalDeposited).toBe(100n * UNIT);
    expect(await balance(addr.vault)).toBe(100n * UNIT);
  });

  it("gives multiple deposits in one transaction distinct identities", async () => {
    await send([deposit(1n * UNIT, 1n), deposit(2n * UNIT, 2n)], [depositor]);
    const a = decodeReceipt((await connection.getAccountInfo(addr.receipt(1n)))!.data);
    const b = decodeReceipt((await connection.getAccountInfo(addr.receipt(2n)))!.data);
    expect([a.sequence, b.sequence]).toEqual([1n, 2n]);
    expect(Buffer.from(a.eventId).equals(Buffer.from(b.eventId))).toBe(false);
    expect(a.credited + b.credited).toBe(3n * UNIT);
    // Reusing a sequence slot fails: the receipt PDA is bound to next_deposit_sequence.
    await expectCode(send([deposit(1n * UNIT, 1n)], [depositor]), VaultError.WrongAccount);
  });

  it("rejects the wrong mint, zero amounts and zero recipients", async () => {
    const otherToken = await createAssociatedTokenAccountIdempotent(connection, depositor, otherMint, depositor.publicKey);
    await mintTo(connection, authority, otherMint, otherToken, authority, 10n * UNIT);
    await expectCode(
      send([depositIx(programId, depositor.publicKey, otherToken, otherMint, TOKEN_PROGRAM_ID, 3n, UNIT, latticeRecipient)], [depositor]),
      VaultError.WrongMint,
    );
    await expectCode(send([deposit(0n, 3n)], [depositor]), VaultError.ZeroAmount);
    await expectCode(send([deposit(UNIT, 3n, new Uint8Array(32))], [depositor]), VaultError.ZeroRecipient);
  });

  it("ignores unsolicited donations to the vault", async () => {
    const before = await config();
    await send(
      [createTransferCheckedInstruction(depositorToken, mint, addr.vault, depositor.publicKey, 7n * UNIT, 6)],
      [depositor],
    );
    const after = await config();
    expect(after.nextDepositSequence).toBe(before.nextDepositSequence);
    expect(after.totalDeposited).toBe(before.totalDeposited);
    expect(await balance(addr.vault)).toBe(before.totalDeposited + 7n * UNIT);
    expect(await connection.getAccountInfo(addr.receipt(before.nextDepositSequence))).toBeNull();
  });

  it("enforces the per-window deposit limit and the global cap", async () => {
    await expectCode(send([deposit(5_000n * UNIT, 3n)], [depositor]), VaultError.RateLimitExceeded);
    await governance(
      encodeSetLimits(header(), {
        depositCap: 150n * UNIT,
        rateWindowSecs: 86_400n,
        maxDepositPerWindow: 5_000n * UNIT,
        maxWithdrawalPerWindow: 3_000n * UNIT,
      }),
    );
    await expectCode(send([deposit(50n * UNIT, 3n)], [depositor]), VaultError.DepositCapExceeded);
    await send([deposit(40n * UNIT, 3n)], [depositor]);
    expect((await config()).totalDeposited).toBe(143n * UNIT);
  });

  it("releases an attested withdrawal exactly once, only to the attested owner", async () => {
    const m = encodeTransfer(withdrawal(50n * UNIT));
    await attest(programId, authority, epoch, m, [g[0]!, g[2]!]);
    await expectCode(release(m, nextBurn, attackerToken), VaultError.WrongRecipient);
    await release(m, nextBurn);
    expect(await balance(recipientToken)).toBe(50n * UNIT);
    const consumed = decodeConsumed((await connection.getAccountInfo(addr.consumed(nextBurn)))!.data);
    expect(consumed.amount).toBe(50n * UNIT);
    expect(consumed.recipient.equals(recipient.publicKey)).toBe(true);
    expect(await connection.getAccountInfo(addr.attestation(messageDigest(m)))).toBeNull();
    // Replay: the attestation is gone, and re-posting signatures hits the consumed record.
    await expectCode(release(m, nextBurn), VaultError.DigestMismatch);
    await attest(programId, authority, epoch, m, [g[0]!, g[1]!]);
    await expectCode(release(m, nextBurn), VaultError.AlreadyConsumed);
    expect(await balance(recipientToken)).toBe(50n * UNIT);
    const c = await config();
    expect(c.totalReleased).toBe(50n * UNIT);
    expect(c.releasedCount).toBe(1n);
    nextBurn += 1n;
  });

  it("rejects bad, foreign, insufficient and misdirected signatures", async () => {
    const m = encodeTransfer(withdrawal(UNIT));
    const digest = messageDigest(m);
    // Below threshold.
    await attest(programId, authority, epoch, m, [g[0]!]);
    await expectCode(release(m, nextBurn), VaultError.BelowThreshold);
    // Duplicate signer does not count twice.
    await attest(programId, authority, epoch, m, [g[0]!]);
    await expectCode(release(m, nextBurn), VaultError.BelowThreshold);
    // Non-guardian key.
    const outsider = guardian();
    await expectCode(attest(programId, authority, epoch, m, [outsider]), VaultError.UnknownGuardian);
    // Forged signature bytes are rejected by the Ed25519 precompile itself.
    const forged = ed25519Sign(g[1]!, digest);
    forged[0] = forged[0]! ^ 0xff;
    await expectFailure(
      send([ed25519MultiIx(digest, [{ publicKey: g[1]!.publicKey, signature: forged }]), postSignaturesIx(programId, authority.publicKey, epoch, digest)], [authority]),
    );
    // A valid signature over a different digest.
    const other = messageDigest(encodeTransfer(withdrawal(2n * UNIT)));
    await expectCode(
      send([ed25519MultiIx(other, [{ publicKey: g[1]!.publicKey, signature: ed25519Sign(g[1]!, other) }]), postSignaturesIx(programId, authority.publicKey, epoch, digest)], [authority]),
      VaultError.SignatureNotForDigest,
    );
    // No precompile instruction at all.
    await expectCode(send([postSignaturesIx(programId, authority.publicKey, epoch, digest)], [authority]), VaultError.MissingEd25519Instruction);
    // Now reach threshold and confirm it works.
    await attest(programId, authority, epoch, m, [g[1]!]);
    await release(m, nextBurn);
    nextBurn += 1n;
  });

  it("rejects messages with the wrong domain fields even when properly signed", async () => {
    const cases: [Partial<TransferMessage>, number][] = [
      [{ latticeGenesisHash: randomBytes(32) }, VaultError.WrongGenesis],
      [{ solanaGenesisHash: randomBytes(32) }, VaultError.WrongGenesis],
      [{ deploymentId: deploymentId("another") }, VaultError.WrongDeployment],
      [{ sourceProgramId: Keypair.generate().publicKey.toBytes() }, VaultError.WrongProgram],
      [{ sourceMint: otherMint.toBytes() }, VaultError.WrongMint],
      [{ kind: Kind.Deposit }, VaultError.WrongKind],
      [{ scheme: 2 }, VaultError.WrongScheme],
      [{ eventId: burnEventId(deployment, nextBurn + 99n) }, VaultError.WrongEventId],
      [{ nativeAmount: UNIT * 1000n + 1n }, VaultError.AmountMismatch],
    ];
    for (const [over, code] of cases) {
      const m = encodeTransfer(withdrawal(UNIT, over));
      await attest(programId, authority, epoch, m, g);
      await expectCode(release(m, nextBurn), code);
    }
  });

  it("detects amount tampering against the attested digest", async () => {
    const signed = encodeTransfer(withdrawal(UNIT));
    await attest(programId, authority, epoch, signed, g);
    const tampered = encodeTransfer(withdrawal(20n * UNIT));
    await expectCode(
      releaseTx(
        { programId, payer: authority, epoch, nonce: nextBurn, recipientToken, mint, tokenProgram: TOKEN_PROGRAM_ID },
        tampered,
        messageDigest(signed),
      ),
      VaultError.DigestMismatch,
    );
  });

  it("never releases more than was deposited and respects the withdrawal window", async () => {
    const locked = (await config()).totalDeposited - (await config()).totalReleased;
    await governance(
      encodeSetLimits(header(), {
        depositCap: 150n * UNIT,
        rateWindowSecs: 86_400n,
        maxDepositPerWindow: 5_000n * UNIT,
        maxWithdrawalPerWindow: 10_000n * UNIT,
      }),
    );
    const tooMuch = encodeTransfer(withdrawal(locked + 1n));
    await attest(programId, authority, epoch, tooMuch, g);
    await expectCode(release(tooMuch, nextBurn), VaultError.ExceedsLocked);
    await governance(
      encodeSetLimits(header(), {
        depositCap: 150n * UNIT,
        rateWindowSecs: 86_400n,
        maxDepositPerWindow: 5_000n * UNIT,
        maxWithdrawalPerWindow: 53n * UNIT,
      }),
    );
    // 51 already withdrawn in this window; 3 more would exceed 53.
    const overWindow = encodeTransfer(withdrawal(3n * UNIT));
    await attest(programId, authority, epoch, overWindow, g);
    await expectCode(release(overWindow, nextBurn), VaultError.RateLimitExceeded);
  });

  it("lets the pauser only pause; unpausing needs the guardian threshold", async () => {
    await expectCode(send([pauseIx(programId, attacker.publicKey, true, false)], [attacker]), VaultError.NotPauser);
    await send([pauseIx(programId, pauser.publicKey, true, false)], [pauser]);
    expect((await config()).depositsPaused).toBe(true);
    const seq = (await config()).nextDepositSequence;
    await expectCode(send([deposit(UNIT, seq)], [depositor]), VaultError.DepositsPaused);
    await expectFailure(send([pauseIx(programId, pauser.publicKey, false, false)], [pauser]));
    await send([pauseIx(programId, pauser.publicKey, false, true)], [pauser]);
    const m = encodeTransfer(withdrawal(UNIT));
    await attest(programId, authority, epoch, m, g);
    await expectCode(release(m, nextBurn), VaultError.WithdrawalsPaused);
    // A single guardian cannot unpause.
    const unpause = encodeSetPause(header(), false, false);
    await attest(programId, authority, epoch, unpause, [g[0]!]);
    await expectCode(governTx(programId, authority, epoch, unpause), VaultError.BelowThreshold);
    await governance(unpause, [g[1]!, g[2]!]);
    const c = await config();
    expect([c.depositsPaused, c.withdrawalsPaused]).toEqual([false, false]);
    await send([deposit(UNIT, seq)], [depositor]);
    await release(m, nextBurn);
    nextBurn += 1n;
  });

  it("rotates guardians by threshold of the current set; the old epoch stops verifying", async () => {
    const rotation = encodeRotateGuardians(header(), 2n, 2, next.map((k) => k.publicKey));
    await attest(programId, authority, epoch, rotation, [g[0]!]);
    await expectCode(governTx(programId, authority, epoch, rotation, addr.guardianSet(2n)), VaultError.BelowThreshold);
    // Old-epoch withdrawal attested before rotation.
    const stale = encodeTransfer(withdrawal(UNIT));
    await attest(programId, authority, epoch, stale, g);
    await governance(rotation, g, addr.guardianSet(2n));
    epoch = 2n;
    expect((await config()).epoch).toBe(2n);
    // Replaying the same governance message fails (nonce consumed, epoch moved).
    await expectFailure(governTx(programId, authority, 1n, rotation, addr.guardianSet(2n)));
    await expectCode(
      releaseTx({ programId, payer: authority, epoch: 1n, nonce: nextBurn, recipientToken, mint, tokenProgram: TOKEN_PROGRAM_ID }, stale),
      VaultError.StaleEpoch,
    );
    await expectCode(attest(programId, authority, 1n, stale, g), VaultError.StaleEpoch);
    // Old guardians cannot sign for the new epoch.
    const fresh = encodeTransfer(withdrawal(UNIT));
    await expectCode(attest(programId, authority, epoch, fresh, g), VaultError.UnknownGuardian);
    await attest(programId, authority, epoch, fresh, [next[0]!, next[1]!]);
    await release(fresh, nextBurn);
    nextBurn += 1n;
  });
});

async function token2022Mint(
  payer: Keypair,
  decimals: number,
  exts: ExtensionType[],
  init: (mint: PublicKey) => TransactionInstruction[],
  extraRentBytes = 0,
) {
  const mint = Keypair.generate();
  const space = getMintLen(exts);
  const lamports = await connection.getMinimumBalanceForRentExemption(space + extraRentBytes);
  await send(
    [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      ...init(mint.publicKey),
      createInitializeMintInstruction(mint.publicKey, decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ],
    [payer, mint],
  );
  return mint.publicKey;
}

describe.skipIf(!enabled)("source-vault on a real validator (Token-2022)", () => {
  const authority = Keypair.generate();
  const depositor = Keypair.generate();
  const recipient = Keypair.generate();
  const g = [guardian(), guardian(), guardian()];
  const latticeGenesis = randomBytes(32);
  const deployment = deploymentId(`lattice-2022-${Date.now()}`);
  let programId: PublicKey;
  let solanaGenesis: Uint8Array;
  const params = (): InitializeParams => ({
    deploymentId: deployment,
    solanaGenesisHash: solanaGenesis,
    latticeGenesisHash: latticeGenesis,
    pauser: null,
    depositCap: 1n << 62n,
    rateWindowSecs: 3_600n,
    maxDepositPerWindow: 1n << 62n,
    maxWithdrawalPerWindow: 1n << 62n,
    threshold: 2,
    guardians: g.map((k) => k.publicKey),
  });

  beforeAll(async () => {
    await Promise.all([authority, depositor].map((k) => fund(k.publicKey, 50)));
    solanaGenesis = new PublicKey(await connection.getGenesisHash()).toBytes();
    programId = await deployVault(authority);
  }, 300_000);

  it("rejects every blocked extension at initialize", async () => {
    const a = authority.publicKey;
    const P = TOKEN_2022_PROGRAM_ID;
    const blocked: [string, ExtensionType, (m: PublicKey) => TransactionInstruction[]][] = [
      ["transfer fee", ExtensionType.TransferFeeConfig, (m) => [createInitializeTransferFeeConfigInstruction(m, a, a, 50, 1000n, P)]],
      ["transfer hook", ExtensionType.TransferHook, (m) => [createInitializeTransferHookInstruction(m, a, Keypair.generate().publicKey, P)]],
      ["permanent delegate", ExtensionType.PermanentDelegate, (m) => [createInitializePermanentDelegateInstruction(m, a, P)]],
      ["non-transferable", ExtensionType.NonTransferable, (m) => [createInitializeNonTransferableMintInstruction(m, P)]],
      ["interest bearing (scaled)", ExtensionType.InterestBearingConfig, (m) => [createInitializeInterestBearingMintInstruction(m, a, 10, P)]],
      ["mint close authority", ExtensionType.MintCloseAuthority, (m) => [createInitializeMintCloseAuthorityInstruction(m, a, P)]],
      ["default account state", ExtensionType.DefaultAccountState, (m) => [createInitializeDefaultAccountStateInstruction(m, AccountState.Initialized, P)]],
    ];
    for (const [name, ext, init] of blocked) {
      const m = await token2022Mint(authority, 6, [ext], init);
      await expectCode(
        send([initializeIx(programId, authority.publicKey, m, TOKEN_2022_PROGRAM_ID, params())], [authority]),
        VaultError.DisallowedExtension,
      ).catch((e) => {
        throw new Error(`${name}: ${(e as Error).message}`);
      });
    }
  });

  it("accepts a Pump.fun-style metadata mint, deposits, releases, and checks overflow", async () => {
    const mint = await token2022Mint(authority, 0, [ExtensionType.MetadataPointer], (m) => [
      createInitializeMetadataPointerInstruction(m, authority.publicKey, m, TOKEN_2022_PROGRAM_ID),
    ], 512);
    await tokenMetadataInitialize(connection, authority, mint, authority.publicKey, authority, "Test", "TST", "https://example.invalid/t.json", [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    await send([initializeIx(programId, authority.publicKey, mint, TOKEN_2022_PROGRAM_ID, params())], [authority]);
    const addr = vaultAddresses(programId);
    const src = await createAssociatedTokenAccountIdempotent(connection, depositor, mint, depositor.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const dst = await createAssociatedTokenAccountIdempotent(connection, depositor, mint, recipient.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    await mintTo(connection, authority, mint, src, authority, 100_000_000_000n, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const dep = (amount: bigint, seq: bigint) =>
      depositIx(programId, depositor.publicKey, src, mint, TOKEN_2022_PROGRAM_ID, seq, amount, randomBytes(32));
    await send([dep(5n, 0n)], [depositor]);
    const r = decodeReceipt((await connection.getAccountInfo(addr.receipt(0n)))!.data);
    expect(r.native).toBe(5_000_000_000n); // 0-decimal source: scale 10^9
    // 20e9 whole tokens × 10^9 exceeds u64 native units.
    await expectCode(send([dep(20_000_000_000n, 1n)], [depositor]), VaultError.Overflow);

    const m = encodeTransfer({
      kind: Kind.Withdrawal,
      deploymentId: deployment,
      solanaGenesisHash: solanaGenesis,
      latticeGenesisHash: latticeGenesis,
      sourceProgramId: programId.toBytes(),
      sourceMint: mint.toBytes(),
      signerEpoch: 1n,
      nonce: 0n,
      sourceAmount: 3n,
      nativeAmount: 3_000_000_000n,
      recipient: recipient.publicKey.toBytes(),
      eventId: burnEventId(deployment, 0n),
    });
    await attest(programId, authority, 1n, m, g);
    await releaseTx({ programId, payer: authority, epoch: 1n, nonce: 0n, recipientToken: dst, mint, tokenProgram: TOKEN_2022_PROGRAM_ID }, m);
    expect((await getAccount(connection, dst, "confirmed", TOKEN_2022_PROGRAM_ID)).amount).toBe(3n);
  });
});
