# Lattice bridge specification — wire version 1

Status: **stable draft for implementation, unaudited.** This document is the
contract between the Solana source-vault program (`programs/source-vault`), the
relayer and guardian attesters (`services/relayer`), the TypeScript encoder
(`packages/protocol/src/wire.ts`), and the Lattice native issuance/burn runtime
(`chain/…`, implemented by a separate workstream). Any change to a byte layout
below requires a new wire version; it must never be changed in place.

Byte order is little-endian for all integers. `[32]` is 32 raw bytes. Solana
and Lattice public keys, program ids, mints, and genesis hashes are carried as
their raw 32 bytes (the base58 string decoded), never as text.

## 1. Asset model and conversion

- Source asset: one SPL mint on Solana mainnet-beta (legacy SPL Token or
  Token-2022 with the allowlist in §8). **The mint is not yet chosen.** It is
  a deployment parameter; no mint is hard-coded anywhere.
- Native asset: LAT, 9 decimals, on Lattice.
- `source_decimals` must be `<= 9`. The fixed scale is
  `SCALE = 10^(9 - source_decimals)`; for a 6-decimal Pump.fun mint
  `SCALE = 1000`.
- `native_amount = source_amount * SCALE` exactly, computed with checked u64
  arithmetic. There is no dust in the deposit direction.
- A Lattice burn of `native_amount` **must** be rejected by the runtime unless
  `native_amount % SCALE == 0` and `native_amount > 0`. Then
  `source_amount = native_amount / SCALE`.
- 1 whole source token is redeemable for 1 whole LAT, and vice versa.

## 2. Identities

| Name | Definition |
| --- | --- |
| `deployment_id` | `SHA-256("lattice-bridge/1:deployment" ‖ utf8(label))`, e.g. label `lattice-mainnet-beta-1`. One deployment binds exactly one mint, one source-vault program, one Solana genesis and one Lattice genesis. Changing any of them requires a new label, a new program deployment, and new guardian signatures. |
| `solana_genesis_hash` | Raw 32 bytes of `getGenesisHash` on the source cluster (mainnet-beta: `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`). |
| `lattice_genesis_hash` | Raw 32 bytes of `getGenesisHash` on the Lattice cluster. |
| `source_program_id` | The source-vault program id on Solana. |
| `source_mint` | The configured mint. |
| Deposit event id | `SHA-256("lattice-bridge/1:deposit-event" ‖ deployment_id ‖ u64 deposit_sequence)` |
| Burn event id | `SHA-256("lattice-bridge/1:burn-event" ‖ deployment_id ‖ u64 burn_sequence)` |

Domain tags are ASCII without a terminator. Event identity is the **sequence
number assigned on chain**, not a transaction signature, so several deposits in
one transaction (or several burns in one Lattice transaction) have distinct
identities, and a resubmitted or re-ordered transaction cannot create a second
identity for the same event.

- `deposit_sequence` is assigned by the source-vault program, starting at 0,
  incremented by exactly 1 per successful deposit.
- `burn_sequence` is assigned by the Lattice runtime, starting at 0,
  incremented by exactly 1 per successful bridge burn.

## 3. Canonical message

Every attested message starts with this 196-byte header:

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 16 | `domain` | ASCII `lattice-bridge/1` |
| 16 | 1 | `kind` | 1 = DEPOSIT (Solana→Lattice), 2 = WITHDRAWAL (Lattice→Solana), 3 = SOURCE_GOVERNANCE, 4 = DESTINATION_GOVERNANCE |
| 17 | 1 | `protocol_version` | 1 |
| 18 | 1 | `signature_scheme` | 1 = Ed25519 (only value accepted on Solana); 2 = ML-DSA-65 and 3 = hybrid Ed25519+ML-DSA-65 are reserved for the Lattice verifier |
| 19 | 1 | reserved | 0 |
| 20 | 32 | `deployment_id` | §2 |
| 52 | 32 | `solana_genesis_hash` | §2 |
| 84 | 32 | `lattice_genesis_hash` | §2 |
| 116 | 32 | `source_program_id` | §2 |
| 148 | 32 | `source_mint` | §2 |
| 180 | 8 | `signer_epoch` | u64 epoch of the guardian set **on the verifying chain** |
| 188 | 8 | `nonce` | u64; see per-kind meaning |

### 3.1 Transfer body (kinds 1 and 2) — total length exactly 276 bytes

| Offset | Size | Field | DEPOSIT (kind 1) | WITHDRAWAL (kind 2) |
| --- | --- | --- | --- | --- |
| 196 | 8 | `source_amount` | credited source atomic units (measured vault delta) | `native_amount / SCALE` |
| 204 | 8 | `native_amount` | `source_amount * SCALE` | burned LAT atomic units |
| 212 | 32 | `recipient` | Lattice account to credit | Solana **wallet** that must own the destination token account |
| 244 | 32 | `event_id` | deposit event id | burn event id |

`nonce` equals `deposit_sequence` (kind 1) or `burn_sequence` (kind 2), and
`event_id` must equal the derivation in §2 for that nonce. Verifiers recompute
it; a mismatch is a rejection. Both amounts must be non-zero and satisfy §1.
`recipient` must not be all zeros.

### 3.2 Source governance body (kind 3)

`nonce` must equal the source-vault `governance_sequence` (next expected value,
starting at 0); it is incremented on success, so each governance message
executes at most once and in order.

| Offset | Size | Field |
| --- | --- | --- |
| 196 | 1 | `action` |
| 197 | … | action payload |

| Action | Payload | Total length |
| --- | --- | --- |
| 1 RotateGuardians | `new_epoch u64` (= current + 1), `threshold u8`, `count u8`, `scheme u8` (= 1), `count × [32]` keys | 208 + 32·count |
| 2 SetPause | `deposits_paused u8 (0/1)`, `withdrawals_paused u8 (0/1)` | 199 |
| 3 SetLimits | `deposit_cap u64`, `rate_window_secs u64`, `max_deposit_per_window u64`, `max_withdrawal_per_window u64` | 229 |
| 4 SetPauser | `pauser [32]` (all zero = no pauser) | 229 |

Kind 4 (DESTINATION_GOVERNANCE) is reserved for the Lattice runtime and uses
the same header; its body is defined by the Lattice workstream. A kind-4
message is never valid on Solana and a kind-3 message is never valid on
Lattice.

### 3.3 What is signed

`digest = SHA-256(message)` (32 bytes). Guardians sign `digest`:

- scheme 1: Ed25519 over the 32 digest bytes;
- scheme 2 (Lattice only, future): ML-DSA-65 (FIPS 204 pure, empty context)
  over the 32 digest bytes, verified with `sol_mldsa65_verify` version 1;
- scheme 3 (Lattice only, future): both of the above, each by the same
  guardian index; both must verify.

Signing a digest keeps the Ed25519 precompile instruction small and lets
signatures be posted over several transactions.

## 4. Guardian sets, thresholds, epochs

- A guardian set is `(epoch u64, scheme u8, threshold u8, keys[1..=19])`.
- Constraints enforced on chain: `1 <= count <= 19`, no duplicate keys, no
  all-zero key, `threshold >= 2`, and `2 * threshold > count` (strict
  majority). Operational policy for mainnet: `threshold >= ceil(2·count/3)`.
- The initial set is epoch 1. Rotation is a SOURCE_GOVERNANCE message signed by
  the **current** set with `new_epoch = current + 1`.
- Only the current epoch is accepted. On rotation the previous set stops
  verifying immediately (no grace period); in-flight withdrawals must be
  re-signed under the new epoch. This trades liveness for not honouring a set
  that was rotated out because it was compromised.
- Solana and Lattice keep **separate** guardian registries with separate
  epochs. `signer_epoch` always refers to the registry of the chain that
  verifies the message (DEPOSIT → Lattice registry; WITHDRAWAL and
  SOURCE_GOVERNANCE → Solana registry).
- There is no single-key administrator. The optional *pauser* key can only set
  pause flags to `true`; unpausing, limits, pauser changes and rotations need a
  guardian-threshold governance message.

## 5. Finality and observation rules

A guardian signs an event only after observing it itself; it never signs bytes
supplied by the relayer.

- **Solana (deposits):** the deposit receipt account (§7.2) must be read at
  `finalized` commitment from at least `quorum` (production: ≥2, distinct
  providers) configured RPC endpoints, each reporting the expected genesis
  hash, with byte-identical account data, owner = source-vault program, and a
  `context.slot` at or above the receipt slot. Any disagreement halts that
  event and raises an alert; nothing is signed.
- **Lattice (withdrawals):** the burn receipt (§9.2) must be read at
  `finalized` commitment (rooted slot) under the same quorum rule from Lattice
  RPCs reporting the expected Lattice genesis.
- `processed`/`confirmed` observations may be displayed as "pending" but never
  drive signing, minting, or release.
- A guardian keeps an append-only signing journal keyed by
  `(kind, nonce, signer_epoch)` and refuses to sign a second, different
  digest for the same key (equivocation guard). A new epoch legitimately
  re-signs an unfinished nonce, because rotation invalidates old-epoch
  attestations.

## 6. Source-vault program instructions (Solana)

Instruction data starts with a 1-byte tag.

| Tag | Instruction | Data | Signer |
| --- | --- | --- | --- |
| 0 | Initialize | see program README | program upgrade authority (checked against ProgramData) |
| 1 | Deposit | `amount u64`, `lattice_recipient [32]` | token owner |
| 2 | PostSignatures | `digest [32]` | any payer; preceding instruction must be the Ed25519 precompile |
| 3 | Release | 276-byte WITHDRAWAL message | any payer (permissionless) |
| 4 | Govern | SOURCE_GOVERNANCE message | any payer (permissionless) |
| 5 | Pause | `deposits u8`, `withdrawals u8` (1 = pause, 0 = leave unchanged) | pauser |

Signature verification uses Ed25519 precompile introspection: the instruction
immediately before `PostSignatures` must be an Ed25519 program instruction
whose every entry uses instruction index `0xFFFF` (data in the same
instruction), message size 32 equal to `digest`, and a public key in the
current guardian set. Verified guardian indices accumulate in an attestation
account across one or more transactions. `Release`/`Govern` require
`popcount(bitmap) >= threshold` for the current epoch, recompute
`SHA-256(message)`, check every header field against the bound configuration,
and close the attestation.

Release replay protection: a consumed-withdrawal account at
`PDA(["withdrawal", u64 nonce])` is created atomically in the same
instruction as the transfer. If it already exists the instruction fails.
Payout is `transfer_checked` from the vault to a token account whose mint is
the bound mint and whose owner equals the attested `recipient`.

## 7. Source-vault accounts

PDAs are derived from the source-vault program id. All layouts are fixed and
start with an 8-byte ASCII discriminator.

| Account | Seeds |
| --- | --- |
| Config | `["config"]` (exactly one per program deployment) |
| Vault authority | `["vault-authority"]` |
| Vault token account | `["vault"]` (owner = vault authority) |
| Guardian set | `["guardian-set", u64 epoch]` |
| Attestation | `["attestation", digest]` |
| Deposit receipt | `["deposit", u64 sequence]` |
| Consumed withdrawal | `["withdrawal", u64 nonce]` |

### 7.1 Config (`LBSCFG01`, 392 bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 8 | `LBSCFG01` |
| 8 | 1 | layout version = 1 |
| 9 | 1 | bump |
| 10 | 1 | vault authority bump |
| 11 | 1 | vault bump |
| 12 | 1 | source decimals |
| 13 | 1 | flags: bit0 deposits paused, bit1 withdrawals paused |
| 14 | 2 | reserved |
| 16 | 32 | deployment_id |
| 48 | 32 | solana_genesis_hash |
| 80 | 32 | lattice_genesis_hash |
| 112 | 32 | mint |
| 144 | 32 | token program |
| 176 | 32 | vault token account |
| 208 | 32 | pauser (zero = none) |
| 240 | 8 | current guardian epoch |
| 248 | 8 | next deposit sequence |
| 256 | 8 | governance sequence (next expected) |
| 264 | 16 | total deposited (u128, credited source units) |
| 280 | 16 | total released (u128, source units) |
| 296 | 8 | deposit cap (max `total deposited − total released`) |
| 304 | 8 | rate window seconds |
| 312 | 8 | max deposit per window |
| 320 | 8 | max withdrawal per window |
| 328 | 8 | window start (i64 unix seconds) |
| 336 | 8 | deposited in window |
| 344 | 8 | withdrawn in window |
| 352 | 8 | released count |
| 360 | 32 | reserved |

### 7.2 Deposit receipt (`LBSDEPO1`, 224 bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 8 | `LBSDEPO1` |
| 8 | 1 | version = 1 |
| 9 | 1 | bump |
| 10 | 6 | reserved |
| 16 | 8 | sequence |
| 24 | 32 | event_id |
| 56 | 32 | depositor (signing token owner) |
| 88 | 32 | depositor token account |
| 120 | 32 | lattice_recipient |
| 152 | 8 | requested amount |
| 160 | 8 | credited amount (measured vault balance delta) |
| 168 | 8 | native amount |
| 176 | 8 | slot |
| 184 | 8 | unix timestamp |
| 192 | 32 | deployment_id |

The program also emits `sol_log_data(["lattice-deposit", receipt])`. The
receipt account, not the log, is authoritative. Tokens sent to the vault by
any other means create no receipt and no liability (they are surplus).

### 7.3 Consumed withdrawal (`LBSWDRL1`, 176 bytes)

`0 magic 8 | 8 version 1 | 9 bump 1 | 10 reserved 6 | 16 nonce 8 | 24 event_id 32 |
56 recipient owner 32 | 88 recipient token account 32 | 120 source_amount 8 |
128 slot 8 | 136 unix ts 8 | 144 digest 32`

### 7.4 Guardian set (`LBSGSET1`, 648 bytes)

`0 magic 8 | 8 version 1 | 9 bump 1 | 10 scheme 1 | 11 threshold 1 | 12 count 1 |
13 reserved 3 | 16 epoch 8 | 24 created slot 8 | 32 reserved 8 | 40 keys 19×32`

### 7.5 Attestation (`LBSATST1`, 88 bytes)

`0 magic 8 | 8 version 1 | 9 bump 1 | 10 reserved 2 | 12 signer bitmap u32 |
16 epoch 8 | 24 digest 32 | 56 rent payer 32`

## 8. Token program and extension policy (enforced at Initialize)

- Mint owner must be SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
  or Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
- Mint must be initialized, have **no freeze authority**, and
  `decimals <= 9`.
- Token-2022 mint extensions allowed: MetadataPointer (18), TokenMetadata (19),
  GroupPointer (20), TokenGroup (21), GroupMemberPointer (22),
  TokenGroupMember (23). **Every other extension rejects**, including
  TransferFeeConfig, MintCloseAuthority, ConfidentialTransferMint,
  DefaultAccountState, NonTransferable, InterestBearingConfig,
  PermanentDelegate, TransferHook, ConfidentialTransferFeeConfig,
  ConfidentialMintBurn, ScaledUiAmount, and Pausable.
- Deposits additionally measure the vault balance delta and record that as the
  credited amount; a zero delta rejects.

## 9. Lattice destination requirements (for the native-issuance workstream)

### 9.1 Minting from a DEPOSIT message

The Lattice runtime must, atomically in one instruction:

1. Require `kind = 1`, `protocol_version = 1`, accepted `signature_scheme`,
   `deployment_id`, `solana_genesis_hash`, `source_program_id`, `source_mint`
   equal to its configured values and `lattice_genesis_hash` equal to its own
   genesis.
2. Require `signer_epoch` = its current guardian epoch and at least
   `threshold` distinct valid guardian signatures over `SHA-256(message)`.
3. Recompute `event_id` from `nonce` (§2) and require equality; require
   `native_amount = source_amount × SCALE`, both non-zero.
4. Create a mint record at a deterministic address keyed by
   `(deployment_id, nonce)`; fail if it already exists (exactly-once).
5. Credit `native_amount` LAT to `recipient`, and add it to
   `total_minted_native`.

### 9.2 Burning for a WITHDRAWAL

A burn instruction takes `native_amount` and a 32-byte Solana recipient
wallet, rejects zero/non-multiple-of-SCALE/zero-recipient, removes the LAT
from circulation, assigns `burn_sequence`, increments `total_burned_native`,
and writes a burn receipt account. Proposed layout (`LATBURN1`, 169 bytes):

`0 magic 8 | 8 version 1 | 9 deployment_id 32 | 41 burn_sequence 8 |
49 burner 32 | 81 native_amount 8 | 89 source_amount 8 | 97 solana_recipient 32 |
129 slot 8 | 137 event_id 32`

### 9.3 Lattice bridge state (proposed, `LATSTAT1`, 98 bytes)

`0 magic 8 | 8 version 1 | 9 deployment_id 32 | 41 next_burn_sequence 8 |
49 minted_count 8 | 57 total_minted_native u128 | 73 total_burned_native u128 |
89 guardian_epoch 8 | 97 flags 1`

Mint record (proposed, `LATMINT1`, 129 bytes):
`0 magic 8 | 8 version 1 | 9 deployment_id 32 | 41 deposit_sequence 8 |
49 recipient 32 | 81 native_amount 8 | 89 slot 8 | 97 event_id 32`

### 9.4 Lattice instructions (proposed — superseded by §9.5)

The original single-instruction proposal is kept for history only. Neither the
builtin nor the relayer implements it.

- `MintAttested`: `tag u8 = 1 ‖ message[276] ‖ count u8 ‖ count × (guardian_index u8 ‖ ed25519_signature[64])`.
  With a 1,232-byte packet this fits about 9 signatures; larger thresholds
  need staged signatures as on Solana.
- `Burn`: `tag u8 = 2 ‖ native_amount u64 ‖ solana_recipient[32]`.

`services/relayer/src/chain/lattice-reference.ts` is an executable,
in-memory reference of §9.1–§9.2 semantics, used by the relayer tests.

Addresses on Lattice (proposed): PDAs of the Lattice native bridge program id
with seeds `["state", deployment_id]`, `["minted", deployment_id, u64 nonce]`,
`["burn", deployment_id, u64 burn_sequence]`. If the Lattice workstream
chooses different layouts or addresses, it must update §9 and the relayer's
`LatticeAdapter` (`services/relayer/src/chain/lattice.ts`); §1–§8 stay fixed.

### 9.5 Implemented Lattice interface (native-issuance workstream)

Implemented, unaudited, as the `lattice-bridge` builtin (program id
`Geuc2RbbzoWXSNYRyVDcjM5fZx6raKgf45y1bQr6aSzN`) in the Agave fork; details in
[`NATIVE_ISSUANCE.md`](NATIVE_ISSUANCE.md). It follows §9.1–§9.3 (seeds,
`LATMINT1`, `LATBURN1`, and the 98-byte `LATSTAT1` prefix, which it extends to
384 bytes) with these differences from the §9.4 proposal:

- Signatures are staged in an attestation account
  (`InitAttestation`/`WriteAttestation`/`VerifyAttestation`, then
  `MintFromDeposit`), because ML-DSA-65 signatures do not fit in a packet;
  instruction tags differ from §9.4. The relayer `SpecLatticeAdapter`
  (`services/relayer/src/chain/lattice.ts`) targets that interface: it
  decodes `LATGSET1`, sets the DEPOSIT header `scheme` to the Lattice set's
  scheme, and submits mints as staged attestations. Hybrid (scheme 3) sets are
  supported: each attester holds an ML-DSA-65 key as well, and the relayer
  verifies both signatures before forwarding. The relayer refuses ML-DSA-only
  (scheme 2) sets. That path is not exercised against a running fork validator
  yet; see `MAINNET_LAUNCH_CHECKLIST.md`.
- The Lattice guardian registry lives at PDA
  `["guardian-set", deployment_id, u64 epoch]`; kind-4 bodies are defined in
  `NATIVE_ISSUANCE.md` §5.
- `lattice_genesis_hash` is bound after launch by a kind-4
  `BindLatticeGenesis` message; deposits and burns are rejected until then.

## 10. Reconciliation

All quantities in source atomic units, read at finalized commitment:

- `R` = vault token account balance (includes donations).
- `N` = `(total_minted_native − total_burned_native) / SCALE` (circulating
  redeemable LAT).
- `P` = `config.total_deposited − total_minted_native / SCALE` (deposited on
  Solana, not yet minted).
- `W` = `total_burned_native / SCALE − config.total_released` (burned, not yet
  released).

The invariant is `R >= N + P + W`; identically
`N + P + W = total_deposited − total_released`, so `R − (N+P+W)` is exactly the
donation surplus. A negative `P` or `W` (more minted than deposited, more
released than burned) is a critical alarm and pauses both directions. Each
status sample records the Solana and Lattice finalized slots used.

## 11. Post-quantum note

Solana mainnet has no ML-DSA verification, so the Solana side of this bridge
(release, governance, the vault itself) is classical Ed25519 and will stay so
until Solana adds a PQ verifier. The `signature_scheme` byte and the
per-epoch guardian set allow the Lattice registry to move to scheme 2 or 3 via
DESTINATION_GOVERNANCE without changing this wire format. A quantum attacker
able to forge Ed25519 would be able to forge Solana-side releases regardless
of what Lattice does.

## 12. Build target note

The local test validator activates every feature, including SIMD-0500
(no new SBPF v0–v2 deployments), so local builds use
`cargo-build-sbf --arch v3`. The mainnet artifact must be built for an SBPF
version that is deployable on mainnet-beta **at deployment time**
(`solana feature status -um`), and its hash must be reproducible
(`solana-verify`). The program logic does not depend on the SBPF version.

## 13. Test vector

See `packages/protocol/src/wire.test.ts` and `programs/source-vault/tests`
(`VECTOR_*`): both implementations must produce the same bytes and digest.
