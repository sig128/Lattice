# lattice-source-vault

The Solana side of the Lattice bridge. It holds the bridged SPL / Token-2022
token, emits deposit receipts, and releases tokens against M-of-N guardian
attestations. The normative spec is [`docs/BRIDGE_SPEC.md`](../../docs/BRIDGE_SPEC.md)
(§6 instructions, §7 accounts, §8 token policy).

> **Unaudited.** This program has not been reviewed by any third party. Do not
> deploy it to mainnet or hold user funds with it until an external audit is
> complete. See [`docs/MAINNET_LAUNCH_CHECKLIST.md`](../../docs/MAINNET_LAUNCH_CHECKLIST.md).

## Build and test

```bash
source programs/env.sh          # shared CARGO_TARGET_DIR=programs/target, no debug info
cd programs/source-vault
cargo test --lib                # 9 host unit tests (message codec, cross-language vector, Ed25519 parsing)
cargo-build-sbf --arch v3 --sbf-out-dir ../target/deploy   # local validator (SIMD-0500 active)
```

The integration tests live in `services/relayer`. They deploy this `.so` to
the local test validator under a fresh program id each run:

```bash
cd services/relayer
pnpm test:validator             # needs solana-test-validator on 127.0.0.1:8899 and initdb/postgres on PATH
```

Pinned versions: `solana-program =4.0.0`, `solana-system-interface =3.3.0`,
and `Cargo.lock` is committed. Program crates depend on nothing else.

**SBPF version for mainnet.** `--arch v3` is needed locally because the test
validator activates every feature. For mainnet, build for the SBPF version
that mainnet-beta accepts on the deployment day (`solana feature status -um`),
then verify the artifact with `solana-verify` from a pinned Docker image. On
one host, two builds of the same commit produced byte-identical output.
Reproducibility across machines has not been demonstrated yet.

## Instructions (summary)

| Tag | Name | Data | Accounts |
|---|---|---|---|
| 0 | Initialize | below | authority (s,w), config (w), guardian_set[1] (w), vault_authority, vault (w), mint, token_program, program_data, system_program |
| 1 | Deposit | `amount u64 ‖ lattice_recipient[32]` | depositor (s,w), config (w), depositor_token (w), vault (w), mint, token_program, receipt (w), system_program |
| 2 | PostSignatures | `digest[32]` | payer (s,w), config, guardian_set, attestation (w), instructions sysvar, system_program |
| 3 | Release | WITHDRAWAL message (276 bytes) | payer (s,w), config (w), guardian_set, attestation (w), rent_recipient (w), consumed (w), vault (w), vault_authority, recipient_token (w), mint, token_program, system_program |
| 4 | Govern | SOURCE_GOVERNANCE message | payer (s,w), config (w), guardian_set, attestation (w), rent_recipient (w), [new_guardian_set (w), rotation only], system_program |
| 5 | Pause | `deposits u8 ‖ withdrawals u8` (1 = pause) | pauser (s), config (w) |

The transaction carrying `PostSignatures` must have an Ed25519 precompile
instruction **immediately before it**. Every offset index in that
instruction must be `0xFFFF` (data in the same instruction), and each signed
message must be the 32-byte digest. Signatures from several transactions
accumulate in the attestation PDA until the threshold is reached.

### Initialize data

All integers are little-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 32 | deployment_id = SHA-256(`"lattice-bridge/1:deployment"` ‖ label) |
| 32 | 32 | solana_genesis_hash (mainnet-beta `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`) |
| 64 | 32 | lattice_genesis_hash |
| 96 | 32 | pauser (zero = none) |
| 128 | 8 | deposit_cap: maximum locked balance, in source base units |
| 136 | 8 | rate_window_secs |
| 144 | 8 | max_deposit_per_window |
| 152 | 8 | max_withdrawal_per_window |
| 160 | 1 | flags: bit0 deposits paused, bit1 withdrawals paused |
| 161 | 1 | threshold |
| 162 | 1 | guardian count n |
| 163 | 32·n | guardian Ed25519 keys (epoch 1) |

`Initialize` succeeds once per program id, and only when it is signed by the
program's current upgrade authority (checked through the ProgramData
account). It permanently binds:

- the mint and token program, which must be legacy SPL Token or Token-2022
  with only allowlisted extensions;
- the absence of a freeze authority;
- the vault, the deployment id, both genesis hashes, and the mint's
  decimals, which must be ≤ 9.

No instruction can change those fields later, and no instruction can sweep
the vault. Tokens leave only through `Release` against a threshold-signed
WITHDRAWAL.

## Upgrade-authority plan

The upgrade authority can replace the program, so it can bypass every guardian
check and drain the vault. Until it is removed, it is the strongest key in the
system. The plan:

1. **Deploy** from a ceremony machine with a fresh deploy key, using the
   audited commit and a verified build (`solana-verify`).
2. **Initialize** in the same session. Only the upgrade authority can do
   this, so there is no front-running window. Then read back the config with
   the relayer's decoders and compare it to the signed launch parameters.
3. **Transfer** the upgrade authority to a multisig (for example Squads, at
   least 3-of-5). The signers must be independent of the guardian operators
   and use hardware wallets. Destroy the deploy key, and publish the multisig
   address and its members.
4. **Use the multisig only for emergency fixes** during a fixed soak period
   that is announced in advance. Every upgrade must come from an audited diff
   with a verified build, and is announced before execution.
5. **Freeze** at the end of the soak period: run
   `solana program set-upgrade-authority <PROGRAM_ID> --final`. After that,
   changes need a new program, a new deployment id and a user-driven
   migration. That migration is not designed yet.

The relayer and attesters do not depend on the upgrade authority. Guardian
rotation, limits, pauser changes and unpausing all go through threshold-signed
governance messages. No single key can run them.

## Local program id

`declare_id!` is `hSS8weNSv8RjWCyCPzxHAPq1MZSNX27PH1tRGUpmz3v`. Its keypair is
`keys/source-vault-program.json`, which is gitignored and for local use only.
The program reads its id from the runtime, and nothing in it is specific to
this address. A mainnet id must be generated during the ceremony and must
never be reused from this repository.
