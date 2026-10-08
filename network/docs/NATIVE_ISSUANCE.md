# Native LAT issuance and burn (Lattice destination side)

Status: **implemented on the fork branch, unaudited, not deployed.** Nothing
here has been reviewed by a third party. Treat every guarantee below as a
design claim backed only by the tests listed in [§12](#12-test-status).

This is the Lattice-side counterpart of [`BRIDGE_SPEC.md`](BRIDGE_SPEC.md)
(wire version 1). It covers the `lattice-bridge` builtin in the Agave fork
(`chain/agave`, branch `lattice/pq-mldsa-v1`, patches
`chain/patches/0004`–`0008`), the runtime change that lets it alter native
supply, and the genesis tooling.

## 1. Identities

| Item | Value |
|---|---|
| Program id | `Geuc2RbbzoWXSNYRyVDcjM5fZx6raKgf45y1bQr6aSzN` = base58(sha256(`lattice:program:lattice-bridge:v1`)) |
| Feature gate | `enable_lattice_bridge_program` = `EX9XkmgKPffcEKpHpStcMDwFixLVV6RG94XN1i1WcdWi` = base58(sha256(`lattice:feature:enable_lattice_bridge_program:v1`)) |
| Crate | `programs/lattice-bridge` (`solana-lattice-bridge-program`) |
| Builtin list entry | `BUILTINS[8]`, `lattice_bridge_program`, no Core BPF migration config |

`--lattice-network` genesis activates the feature at slot 0, so the builtin
is present from genesis. There is no upgrade authority. Changing the program
means a new fork release and a new feature gate.

## 2. How native supply changes (runtime patch 0004)

Agave normally forbids any instruction or transaction from changing the sum of
lamports. Two checks enforce this: `UnbalancedInstruction` on each
instruction and `UnbalancedTransaction` on the transaction. The patch adds
exactly one exception:

- `TransactionContext::record_native_supply_change(delta: i128)` succeeds only
  when the current instruction is **top level** (stack height 1) and its
  program is `LATTICE_BRIDGE_PROGRAM_ID`. Otherwise it returns `CallDepth` or
  `IncorrectProgramId`. Calls through CPI, and calls from any other program,
  are rejected.
- It adjusts the instruction lamport-balance accumulator by `-delta`, so the
  bridge can credit (mint) or debit (burn) exactly `delta` and still pass the
  balance check. It also adds `delta` to a per-transaction
  `native_supply_delta` (checked add).
- The SVM end-of-transaction check becomes `post_sum == pre_sum + delta`. The
  delta reaches the bank only for **successfully executed** transactions.
  `Bank::commit_transactions` sums the deltas and applies them to
  `capitalization` with checked arithmetic, panicking on overflow or
  underflow, which would mean an invariant violation.
- Snapshot load still recomputes capitalization from accounts, so a
  validator whose capitalization diverged would fail verification.

The bridge program is the only code that calls the hook. Mint calls it with
`+native_amount` after crediting the recipient. Burn first moves
`native_amount` from the burner to the state PDA with a system transfer
(CPI), then debits the PDA and calls the hook with `-native_amount`. The LAT
is destroyed and capitalization falls by the same amount. It is not sent to a
dead address.

## 3. Instructions

Instruction data is a 1-byte tag followed by fixed little-endian fields.
Builders live in `instruction::builders`. Errors are
`InstructionError::Custom(code)` using the stable codes in `src/error.rs`.

| Tag | Instruction | Data | Accounts |
|---|---|---|---|
| 0 | InitAttestation | `scheme u8, signature_count u8, message_len u32` | writer (signer), attestation (w, owned by program, zeroed, exact size) |
| 1 | WriteAttestation | `offset u32, bytes…` (offset relative to the message area) | writer (signer), attestation (w) |
| 2 | VerifyAttestation | `first u8, count u8` | attestation (w), state, guardian set (current epoch) |
| 3 | CloseAttestation | — | writer (signer, w), attestation (w) |
| 4 | MintFromDeposit | — | payer = writer (signer, w), state (w), guardian set, attestation (w), mint record PDA (w), recipient (w), system program |
| 5 | BurnForWithdrawal | `native_amount u64, solana_recipient [32]` | burner (signer, w), state (w), burn receipt PDA (w), system program |
| 6 | Govern | — | payer = writer (signer, w), state (w), guardian set, attestation (w), system program, [new guardian set PDA (w), RotateGuardians only] |
| 7 | Pause | `deposits u8, withdrawals u8` (1 = pause, 0 = leave) | pauser (signer), state (w) |

### Relayer flow (deposit)

1. Create the attestation account. Use a fresh keypair and the system
   `create_account` call, owned by the bridge program, with size
   `96 + message_len + signature_count × entry_len`. In the **same**
   transaction, call `InitAttestation`.
2. Use `WriteAttestation` to upload the 276-byte DEPOSIT message, then the
   signature entries. A large attestation needs several transactions.
3. Call `VerifyAttestation(first, count)`, once or over several transactions.
   The first call seals the account: the message can no longer change, and
   the digest and signer epoch are fixed. Each call verifies its entries and
   ORs the proven guardian indices into a bitmap.
4. Call `MintFromDeposit`. It checks the threshold over the bitmap, validates
   the message (§9.1 of the spec), creates the mint record, credits the
   recipient, records the supply change, updates the state, and closes the
   attestation, refunding its rent to the payer.

Signature entry = `guardian_index u8 ‖ [ed25519_sig 64] ‖ [mldsa65_sig 3309]`,
where each part is present iff the guardian-set scheme includes it.

**Divergence from BRIDGE_SPEC §9.4 (proposed `MintAttested` and `Burn`).** A
single-instruction mint with inline Ed25519 signatures cannot carry ML-DSA-65
signatures, which are 3,309 bytes each, more than a 1,232-byte packet. So the
builtin always uses staged attestations, and the tags above replace the
proposed tags 1 and 2. The relayer's `LatticeAdapter` must be updated to this
interface. That work is outside this workstream, which does not edit
`services/relayer`. PDA seeds `["state"]`, `["minted"]` and `["burn"]` and
the 98-byte `LATSTAT1` prefix, `LATMINT1` and `LATBURN1` layouts are exactly
as §9 proposes. Two additions: the guardian-set PDA, and state fields after
offset 98.

## 4. Accounts

All accounts are owned by the program and use a little-endian layout with an
8-byte magic and a version byte (1).

| Account | Address | Size |
|---|---|---|
| State `LATSTAT1` | PDA `["state", deployment_id]` | 384 |
| Guardian set `LATGSET1` | PDA `["guardian-set", deployment_id, epoch u64]` | 64 + count × key_len |
| Mint record `LATMINT1` | PDA `["minted", deployment_id, deposit_sequence u64]` | 129 (spec §9.3) |
| Burn receipt `LATBURN1` | PDA `["burn", deployment_id, burn_sequence u64]` | 169 (spec §9.2) |
| Attestation `LATATST1` | any keypair address | 96 + message + entries |

`LATSTAT1` bytes 0–97 are exactly spec §9.3. The extension:

| Offset | Size | Field |
|---|---|---|
| 97 | 1 | flags: bit0 deposits paused, bit1 withdrawals paused, bit2 Lattice genesis bound |
| 98 | 1 | bump |
| 99 | 1 | source_decimals (≤ 9; SCALE = 10^(9−d)) |
| 100 | 1 | network (1 mainnet, 2 testnet, 3 development) |
| 104 | 32 | solana_genesis_hash |
| 136 | 32 | lattice_genesis_hash (zero until bound) |
| 168 | 32 | source_program_id |
| 200 | 32 | source_mint |
| 232 | 32 | pauser (zero = none) |
| 264 | 8 | governance_sequence (next accepted kind-4 nonce) |
| 272 | 8 | max_mint_per_epoch (native lamports) |
| 280 | 8 | rate_limit_epoch |
| 288 | 8 | minted_in_rate_epoch |
| 296 | 8 | genesis_bootstrap_native |
| 304 | 8 | genesis_unbacked_native |
| 312 | 16 | outstanding_native = total_minted − total_burned (u128) |
| 328 | 8 | last_mint_slot |
| 336 | 8 | last_burn_slot |

`LATGSET1` header: `0 magic | 8 version | 9 scheme | 10 threshold | 11 count |
12 bump | 16 epoch u64 | 24 created_slot u64 | 32 deployment_id` and then
`count` key entries: `ed25519[32]` and/or `mldsa65[1952]`.

`LATATST1` header: `0 magic | 8 version | 9 scheme | 10 status (1 open,
2 sealed) | 11 signature_count | 12 verified_bitmap u32 | 16 signer_epoch u64
| 24 digest[32] | 56 writer[32] | 88 message_len u32`.

Supply is readable over RPC with `getAccountInfo` on the state PDA. The genesis
tool prints the address.

## 5. Messages

DEPOSIT (kind 1) is exactly BRIDGE_SPEC §3.1. Kind 3 is rejected on Lattice.
**Kind 4 (DESTINATION_GOVERNANCE)** uses the standard 196-byte header with
`kind = 4`, `nonce = governance_sequence` (strictly sequential), and
`signer_epoch` = the current Lattice guardian epoch. The body starts at offset
196. Every action has an exact length, and trailing bytes are rejected:

| Action | Body |
|---|---|
| 1 RotateGuardians | `1 ‖ new_epoch u64 ‖ threshold u8 ‖ count u8 ‖ scheme u8 ‖ count × key_entry` (key_entry = 32 / 1952 / 1984 bytes for scheme 1 / 2 / 3) |
| 2 SetPause | `2 ‖ deposits_paused u8 (0/1) ‖ withdrawals_paused u8 (0/1)` |
| 3 SetLimits | `3 ‖ max_mint_per_epoch u64` |
| 4 SetPauser | `4 ‖ pauser [32]` (zero = none) |
| 5 BindLatticeGenesis | `5` |

**Binding the Lattice genesis hash.** The Lattice genesis hash depends on the
genesis contents, so it cannot be stored in genesis. The state starts with a
zero hash and *deposits are rejected* (`LatticeGenesisNotBound`, and burns
too) until a threshold-signed `BindLatticeGenesis` message is executed. That
message carries the real hash in its header. Binding is one-shot. Before
binding, all other kind-4 messages must carry the zero hash. Afterwards,
every message must carry the bound hash. Guardians must check the hash
against `getGenesisHash` on Lattice before signing the binding. The same
value must be configured on Solana (source-vault config), or withdrawals
signed for this chain will not verify there.

## 6. Signature policy (exactly what is required)

The guardian set for each epoch declares one scheme. The message header's
`signature_scheme` must equal it, and so must the attestation account's
scheme.

| Scheme | A guardian index counts once toward the threshold iff | Entry size |
|---|---|---|
| 1 Ed25519 | its Ed25519 signature over `SHA-256(message)` verifies (`verify_strict`) | 65 |
| 2 ML-DSA-65 | its ML-DSA-65 signature (FIPS 204 pure, empty context, `agave-mldsa-verify` = the verifier behind `sol_mldsa65_verify`) over the same digest verifies | 3,310 |
| 3 Hybrid | **both** its Ed25519 and its ML-DSA-65 signatures verify | 3,374 |

- The threshold counts distinct guardian indices of the **current** epoch's
  set. A repeated index counts once.
- **Every provided entry must verify.** One invalid signature fails the
  instruction, so a relayer must not forward unverified signatures.
- Only the current epoch is accepted (spec §4). After rotation, unconsumed
  attestations for the old epoch fail with `WrongSignerEpoch` and must be
  re-signed.
- Rotation (kind 4, action 1) needs a threshold of the current set, and
  `new_epoch = current + 1`. The new set must satisfy spec §4: 1–19 keys, no
  duplicates or zero keys, threshold ≥ 2, and 2·threshold > count. The key
  shapes must match the new scheme. **Moving from scheme 1 to 3 is a normal
  rotation.**
- Mainnet recommendation: launch with scheme 3 (hybrid) so that an attacker
  must break both Ed25519 and ML-DSA-65. Scheme 1 alone gives no
  post-quantum protection on Lattice. As spec §11 notes, the Solana side
  stays Ed25519 regardless.

## 7. Compute metering

Costs are charged before the work they pay for, so execution is deterministic
on every validator.

| Item | CU |
|---|---|
| Base per instruction | 1,500 |
| Ed25519 verify (per signature) | 12,000 (ratio to the ML-DSA calibration in `QUANTUM.md`; re-measure on validator hardware) |
| ML-DSA-65 verify (per signature) | `verify_cost(32)` = 30,001 |
| SHA-256 of the message (once, at sealing) | 85 + ⌈len/2⌉ |
| PDA derivation | 1,500 per bump attempt |
| WriteAttestation | ⌈bytes/16⌉ |

Examples: a 13-of-19 hybrid quorum costs about 13 × 42,001 ≈ 546k CU. Set
`SetComputeUnitLimit`, because the default for a non-listed builtin is 200k
per instruction. Alternatively, split the work over several
`VerifyAttestation` calls. Deliberately, the builtin is **not** listed in
`builtins-default-costs`, so it gets the normal (non-builtin) compute
allocation.

## 8. Controls

- **No admin mint path.** Native lamports are created only by
  `MintFromDeposit` against a threshold-signed DEPOSIT, once per
  `(deployment_id, deposit_sequence)`. The record PDA is keyed by the
  sequence alone, so re-signing under another epoch, amount or recipient
  cannot mint twice. Creating the record and crediting the recipient happen in
  one instruction.
- **Separate pauses.** Deposits (mint) and withdrawals (burn) are paused
  independently through governance SetPause. The optional pauser key can
  only set pause flags (instruction 7). Unpausing, limits, pauser changes and
  rotations all need governance.
- **Rate limit.** `max_mint_per_epoch` is in native lamports per Lattice
  epoch. A mint that would exceed it fails and stays mintable in a later
  epoch. `0` disables minting.
- **Burn bounds.** Only multiples of SCALE can be burned, at most
  `outstanding_native`, with a non-zero Solana recipient. Burns also require a
  bound genesis hash.
- **Atomicity and griefing.** Lamports sent to a future record or receipt
  address do not block it: the program uses transfer + allocate + assign
  instead of `create_account`. Only the attestation writer can consume or
  close it.

## 9. Genesis and the supply model

`solana-genesis --lattice-network mainnet|testnet --lattice-bridge-config FILE
--lattice-runtime-reserve-lamports N` (patch 0006), usually through
`chain/scripts/lattice-genesis.sh`. Example configs:
`chain/config/lattice-bridge.{mainnet,testnet}.example.yaml`.

Lattice mode requires `--cluster-type development`. With other cluster types,
upstream adds Solana's own genesis stake allocations (about 500M SOL) and
clones Solana's feature set over RPC. The bridge feature must be active and
cannot be deactivated. The bridge accounts are added **last**, after all
other genesis accounts.

**Mainnet** has no faucet and inflation `none` (enforced). The supply rule is:

```
genesis_account_lamports + runtime_reserve  <=  Σ bootstrap deposits × SCALE
```

- **Bootstrap deposits** are ordinary source-vault deposits finalized on Solana
  before launch. Each becomes a pre-consumed `LATMINT1` record in genesis, so
  it can never be minted again. Each is counted in `total_minted_native` and
  in `genesis_bootstrap_native`.
- Any excess backing is credited to `bootstrap_surplus_recipient`, so genesis
  supply equals the backing.
- If the inequality fails, solana-genesis exits without writing a ledger.
- `genesis_unbacked_native = 0`.

**Runtime reserve.** At slot 0, Agave itself creates rent-exempt balances for
sysvars and builtin program accounts. These lamports are not in the genesis
accounts. The reserve (default 2 LAT) must cover them, and the actual amount
must be measured. `build-lattice-validator.sh --smoke-validator` boots the
ledger and compares `getSupply.total` with the genesis account sum. A reserve
that is too large under-issues, which is the safe direction. A reserve that
is too small leaves that difference unbacked.

**Testnet** allows a faucet. Everything not covered by bootstrap deposits is
written to `genesis_unbacked_native` and printed as `UNBACKED`. Those units
are never redeemable and cannot be relabelled as production units.

**Lattice-side reconciliation** (complements spec §10). For a mainnet genesis,
at any finalized slot:

```
capitalization = genesis_supply + Σ mints − Σ burns − Σ burned fees − Σ VAT burns
                 (+ runtime-created balances at feature activations)
outstanding_native = total_minted_native − total_burned_native   (state account)
```

- With inflation off, fees and VAT only **remove** LAT, so circulating LAT ≤
  `outstanding_native`. The vault therefore stays over-collateralised.
- `outstanding_native` and `total_*` must equal the spec §10 inputs read from
  the state PDA.
- Monitoring should alarm if `capitalization > genesis_supply +
  outstanding_native − genesis_bootstrap_native + reserve`.

## 10. Server steps (not done on the development host)

On the build server (Ubuntu 24.04, m7i.2xlarge, 500 GB):

```sh
chain/scripts/build-lattice-validator.sh                     # build + tests + genesis smoke
chain/scripts/build-lattice-validator.sh --no-apt --full-runtime-tests --smoke-validator
```

The script uses `chain/agave` if it is a checkout. Otherwise it clones Agave
`825efd18` and runs `git am chain/patches/*.patch`. It builds `agave-validator`,
`solana-test-validator`, `solana-genesis`, `solana-keygen` and `solana`. It
then runs the tests in §12 and the genesis smoke tests: a fully backed
mainnet genesis, a labelled-unbacked testnet genesis, and checks that
mainnet refuses both an unbacked genesis and a faucet. Results go to
`chain/evidence/lattice-build-<timestamp>/`.

## 11. Remaining risks and open items

- **Unaudited.** The runtime hook, the builtin, and the genesis tool all need
  independent review. A bug in the hook or in mint authorization is a
  direct inflation bug.
- **Not compiled locally.** `solana-runtime`, `solana-genesis` and the
  bank-level tests were not compiled on the development host (disk). Upstream
  runtime tests that hash or count builtins under `all_enabled` feature sets
  may need expectation updates. Run `--full-runtime-tests`.
- **Ed25519 CU price** (12,000) is an estimate. Benchmark both verifiers on
  validator hardware before mainnet.
- **Runtime reserve** must be measured, not assumed (§9). Feature activations
  after genesis that create builtin or sysvar accounts also add small,
  unbacked balances, as they do upstream. They are not tracked in the bridge
  state.
- **Recipient rent.** Minting less than the rent-exempt minimum
  (~0.00089 LAT) to an empty account fails, but stays mintable after the
  recipient is funded. The source side should enforce a minimum deposit of
  at least that amount.
- **Liveness.** Rotation retires the old epoch immediately (spec §4). The
  per-epoch rate limit can delay large deposits. Pausing stops burns, so a
  stuck pause traps funds until governance unpauses.
- **Relayer adapter mismatch** with spec §9.4 (§3 above). This needs an
  update outside this workstream.
- **Other lockfiles.** `programs/sbf`, `svm/examples` and `dev-bins` have
  their own `Cargo.lock` files, and those were not refreshed. The main
  workspace lock is updated.
- **Cluster type `development`** also changes some upstream defaults (for
  example the auto `hashes_per_tick` and the default slots per epoch).
  `lattice-genesis.sh` pins both explicitly.

## 12. Test status

Run on the development host (macOS, toolchain 1.97.1, isolated builds):

| Command | Result |
|---|---|
| `cargo test -p solana-transaction-context --features agave-unstable-api --lib` | 13 passed (5 new supply-hook tests) |
| `cargo test -p solana-lattice-bridge-program --lib` | 33 passed (pure logic: mint once, replay, below threshold, invalid/foreign signatures, wrong domain/version/deployment/genesis/program/mint/epoch/event id/amount/scheme, genesis binding, rotation, pauses and pauser, rate limit and epoch reset, burn bookkeeping/receipt/sequence, burn bounds, overflow, ML-DSA-only, hybrid, scheme migration, compute exhaustion, genesis builder, spec test vector) |
| `cargo test -p solana-lattice-bridge-program --features dev-context-only-utils --lib` | 41 passed before the vector test was added (adds 8 processor tests running the builtin through `mock_process_instruction`: mint then burn with exact lamport accounting and supply delta, replay, threshold/foreign keys, pre-funded record PDA, wrong record/recipient/writer, rotation via Govern, pauser, spoofed state) |
| `cargo test -p solana-builtins --features agave-unstable-api,dev-context-only-utils --lib` | 25 passed |
| `cargo check -p solana-svm --features agave-unstable-api` | ok |
| `solana_genesis::lattice` tests in an isolated crate (runtime stubbed) | 5 passed |
| Patch series `0001`–`0008` applied to `825efd18` | tree identical to the branch |

Pending on the server (exact commands are in `build-lattice-validator.sh`):
`cargo test -p solana-runtime --lib lattice_bridge` (bank-level: capitalization
moves by exactly the mint and burn amounts, replay, failed tx, and
`capitalization == calculate_capitalization_for_tests()` after freeze),
`cargo test -p solana-genesis`, `cargo test -p solana-svm --lib`, clippy, and
the release build.
