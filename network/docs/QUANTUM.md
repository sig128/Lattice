# Post-quantum signatures in Lattice: implementation map

Label: **PQ-authorized vault transfers enforced by the runtime (local experimental fork).**

This is one narrow, experimental capability on a local fork of Agave. It does
not make Lattice a quantum-resistant network. Almost everything else on the
chain still uses classical cryptography; see the table below.

Machine-readable evidence: [`chain/evidence/pq-local.json`](../chain/evidence/pq-local.json).

## Current status (2026-10-08)

| Piece | State |
| --- | --- |
| `agave-mldsa-verify` crate (fork) | Implemented, 6 tests pass (incl. NIST ACVP vectors) |
| `sol_mldsa65_verify` syscall + feature gate (fork) | Implemented, 2 syscall tests pass |
| `pq-vault` SBF program | Built with `cargo-build-sbf` (34,984 bytes), 8 host tests pass |
| TypeScript client + CLI (`packages/crypto`) | Implemented, 5 vitest tests pass, typechecks |
| Fork `solana-test-validator` binary | **Not built.** The build stopped when free disk fell below 1.5 GiB |
| On-chain run (genesis hash, tx signatures) | **Not run yet.** Needs the binary |

So right now, enforcement is shown by tests: the syscall inside Agave's
`InvokeContext`, and the program's instruction logic with real ML-DSA-65.
There is not yet a running fork validator to show it end to end.

## Design

### Verification capability: SBF syscall, not a precompile

- A precompile can only verify bytes that are inside the transaction itself.
  A 3,309-byte ML-DSA-65 signature does not fit in a 1,232-byte packet, so a
  precompile can't work without raising the packet limit.
- Instead the fork adds a syscall:
  `sol_mldsa65_verify(version, pk_addr, msg_addr, msg_len, sig_addr) -> u64`.
  Any SBF program can call it on bytes it reads from accounts.
- Implementation: `chain/agave/mldsa-verify` wraps
  [`fips204`](https://crates.io/crates/fips204) pinned to `=0.4.6`.
  - License: MIT OR Apache-2.0. Pure Rust, `no_std`.
  - Its only dependencies are `sha2`, `sha3`, `rand_core` and `zeroize`, which
    are already in Agave's tree.
  - It ships NIST ACVP vectors.
  - Variant: FIPS 204 "pure" ML-DSA-65 with an empty context string, which is
    the `@noble/post-quantum` default.
  - RustCrypto `ml-dsa 0.1.1` was considered. It would pull in pre-1.0
    `hybrid-array`, `module-lattice` and `sha3 0.11`-era dependencies.
- Input checks:
  - `version` must be `1`; otherwise the syscall returns code `3`.
  - Messages over 4,096 bytes return code `4`.
  - The public key (1,952 bytes) and signature (3,309 bytes) are read at fixed
    lengths. A short memory region is an access violation.
  - A malformed signature encoding returns code `1`.
- Determinism: verification is a pure function of public inputs. There is no
  randomness and no floating point.
- Compute cost: 30,000 CU plus 1 CU per 32 message bytes, charged *before*
  any input is read.
  - Calibration: on this host, ML-DSA-65 verify has a median of 108.7 µs.
    `secp256k1_recover` takes 91.8 µs and its existing syscall costs 25,000 CU.
    The ratio suggests 29,610 CU, rounded up to 30,000.
  - Rerun with `cargo run --release -p agave-mldsa-verify --example bench`.
- Feature gate: `enable_mldsa65_verify_syscall`, id
  `2e8mniAJiRxZz5JFAU2mX8KzCN6Z16GRGkBD7fnPF62P`. That id is
  `base58(sha256("lattice:feature:enable_mldsa65_verify_syscall:v1"))`.
  `solana-test-validator` activates every known feature at genesis.

### Transaction size: staged signature buffer (option b)

The packet limit (1,232 bytes) stays as it is. Raising it would mean patching
the external `solana-packet` crate and touching sigverify, QUIC, RPC limits and
banking. That is a large consensus-wide change with real safety implications.

Instead, the signature is staged in a program-owned buffer account:

1. **Signature buffer.** The relayer creates and initializes a buffer account
   (3,392 bytes), then writes the signature in sequential chunks. Only the
   recorded relayer can write.
2. **Execute.** The last transaction carries the final chunk plus `Execute`.
   The program then:
   - rebuilds the canonical message from on-chain state and instruction
     arguments;
   - calls `sol_mldsa65_verify` on the vault's stored key and the buffered
     signature;
   - moves the lamports;
   - closes the buffer, which is single use.

Measured with the client's packer:

- A PQ transfer is **4 transactions** (1232, 1232, 1232 and 729 bytes).
- Vault setup is a one-time **3 transactions** (1232, 1232 and 305 bytes).

Tradeoffs:

- The steps are not atomic. A half-staged buffer sits idle until it is used
  or closed with `CloseSigBuffer`.
- The relayer pays rent for the buffer temporarily and gets it back when the
  buffer closes.
- The relayer cannot forge or redirect a transfer. Changing the amount,
  recipient, nonce or expiry invalidates the ML-DSA signature.

### pq-vault program (`chain/programs/pq-vault`)

- Vault account: 2,048 bytes, owned by the program. It stores the magic bytes,
  state, algorithm version, setup authority, genesis hash, `next_nonce` and the
  ML-DSA-65 public key.
- Setup: `InitVault` and `WriteVaultKey` run under a one-time Ed25519 setup
  authority. `SealVault` then clears that authority. After sealing, **only**
  an ML-DSA-65 signature can move lamports. The vault address is
  program-owned, so its own keypair cannot spend either.
- Signed message (180 bytes, fixed width, little-endian):

  ```
  len(domain)=25 || "lattice-pq-vault-transfer" || version=1 || algorithm=1 ||
  genesis_hash || program_id || vault || recipient || amount || nonce || expiry_slot
  ```

  This is a different domain from the off-chain prototype's text encoding in
  `packages/crypto/src/index.ts`. A signature over one encoding never verifies
  as the other.
- On-chain checks, in order:
  1. Vault is sealed, algorithm is 1, buffer belongs to this vault and relayer
     and is complete.
  2. `clock.slot <= expiry_slot`, else `Expired` (11).
  3. `nonce == next_nonce`, else `NonceMismatch` (12).
  4. The vault stays rent-exempt, else `InsufficientFunds` (13).
  5. The ML-DSA-65 signature verifies, else `SignatureRejected`
     (`0x100 | syscall code`, for example `0x101`).

  On success, `next_nonce += 1`, so any replay fails at step 3.
- Genesis binding: Agave has no sysvar that exposes the genesis hash.
  - The creator writes it into the vault at `InitVault`; the client takes it
    from `getGenesisHash`. Every signature is then bound to that stored value.
  - A message signed for a different genesis hash fails verification on-chain.
  - The program can't independently prove the stored value is this cluster's
    genesis hash. It is trusted from the vault's creator, the same party that
    picks the ML-DSA key.
- The program is loaded at genesis with `--bpf-program`, so it is immutable
  and has no upgrade authority.

## What is PQ-protected now, and what stays classical

| Component | Status |
| --- | --- |
| Moving lamports out of a sealed pq-vault | **ML-DSA-65, enforced by the fork runtime** (syscall + program). Tested in unit tests; on-chain run pending |
| Fee payer / transaction signatures | Classical Ed25519 (unchanged). Every pq-vault transaction is still sent by an Ed25519 fee payer (relayer) |
| Relayer (stages buffers, submits) | Ed25519. Cannot move vault funds, but can censor or delay |
| Vault creation / setup authority | One-time Ed25519; powerless after `SealVault` |
| Ordinary accounts, system transfers, SPL tokens | Ed25519 |
| Wallets | Ed25519 everywhere. The `packages/crypto` CLI holds ML-DSA keys in memory only for the demo |
| Validator identity, vote accounts | Ed25519 |
| Votes / consensus (Tower BFT; Alpenglow BLS12-381 where enabled) | Classical |
| Gossip, Turbine, repair, QUIC/TLS | Classical (Ed25519 / ECDHE) |
| Bridge authorities | None implemented |
| Program upgrade authority | pq-vault: none (immutable). Other upgradeable programs: Ed25519 |
| PoH, account hashing, Merkle roots | Hash-based (SHA-256 / blake3 / lattice-hash), not signatures; not changed |

## Compatibility breaks

- A new feature id is added to `FEATURE_NAMES`. That changes the fork's
  feature-set id, so it cannot join upstream Agave clusters.
- The new `sol_mldsa65_verify` syscall means programs that import it (like
  pq-vault) fail to load on unmodified Agave, with an unresolved-symbol error.
- No transaction-format, packet-size, RPC or account-layout changes were made
  to upstream components.

## How to reproduce

```sh
source chain/scripts/pq-env.sh       # toolchain workarounds, ports, lean profile
cd chain/agave
cargo test --release -p agave-mldsa-verify
cargo test --release -p solana-syscalls --features agave-unstable-api --lib -- mldsa65
cargo run  --release -p agave-mldsa-verify --example bench
cd ../programs/pq-vault && cargo test && cargo-build-sbf --sbf-out-dir ../../target/deploy
pnpm --filter @lattice/crypto test

# Needs ~8 GB free disk:
./chain/scripts/pq-build.sh                         # fork solana-test-validator
./chain/scripts/pq-start-local.sh --reset           # RPC 8999, WS 9000, faucet 9990
pnpm --filter @lattice/crypto pq:demo               # writes chain/evidence/pq-local.run.json
```

## Remaining work

1. Free disk (about 8 GB), build the fork validator, and run `pq:demo`. That
   produces the genesis hash, on-chain signatures for the valid and rejected
   cases, and measured `Execute` CU. Then copy those into `pq-local.json`.
2. Add a `solana-program-test` / SVM integration test inside the fork that
   loads `lattice_pq_vault.so`.
3. Add a proof-of-possession signature at `SealVault`, plus a way to rotate
   keys.
4. Benchmark on validator-class hardware, and get an independent review of the
   CU cost.
5. Larger steps: PQ fee-payer signatures (a new transaction signature scheme
   with a raised packet size), then PQ validator identity, votes and
   networking. None of these are started.
