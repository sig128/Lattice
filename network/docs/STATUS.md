# Implementation status — 8 October 2026

## Implemented and testable

- Restrained responsive website with honest unconfigured/unavailable states,
  keyboard-operable copy controls, separate bridge/backing/RPC/security status,
  local endpoints, mobile navigation, and machine-readable manifest/status APIs.
- Versioned configuration schema separating source identity, source and
  destination genesis hashes, bridge deployment identity, RPC capabilities,
  and evidence states.
- Solana mint inspector for legacy SPL Token and Token-2022, with wrong-genesis,
  wrong-owner, malformed-mint, authority, and unsupported-extension reporting.
- Exact integer conversion with explicit redemption quantum and residual dust.
- Length-delimited, domain-separated bridge message encoding that binds both
  genesis hashes, mint, deployment, direction, amount, recipient, event index,
  nonce, and signer epoch.
- Monotonic claim transition helper and reconciliation using
  `L = N + P + W`, exact watermarks, freshness, and zero-liability wording.
- Independent RPC worker checking JSON-RPC semantics, genesis, health, slot,
  latest blockhash, version, and actual WebSocket slot messages. Endpoints come
  only from typed configuration. PostgreSQL persistence is optional.
- ML-DSA-65 signing/verifying prototype with canonical transaction fields,
  altered-field/domain tests, size limits, and a local benchmark. On Node
  v22.22.0, 50 iterations measured a 1,952-byte public key, 4,032-byte secret
  key, 3,309-byte signature, 8.57 ms mean signing, and 1.70 ms mean
  verification. These are development-machine observations, not capacity
  guarantees.
- Agave v4.3.0 / commit `825efd1` pin and reset-safe local test-validator script.
- Official Agave 4.3.0 validator running against independent genesis
  `G9818341AwzwpDqHoh3uqy2hS8AkM1d9WCYbaX6YcVRU`, with HTTP, WebSocket,
  health, advancing finalized slots, faucet, native transfer, balance read, and
  slot subscription verified.
- Operator-attested local bridge demonstration using isolated SPL test assets.
  Real ledger operations moved reserves and issued liabilities together through
  0, 100, 150, and 125 units; a persistent recorder recomputes coverage.
- Allowlisted browser RPC console, local-only faucet, live homepage network
  vitals, and a runnable end-to-end native transfer/WebSocket example.

## Not implemented

- No source mint or verified Pump.fun creation evidence.
- No source vault program, vault token account, deployment, custody, or real
  reserve observation.
- No durable bridge relayer/attestation quorum, signer rotation, pause controls,
  payout path, recovery procedure, or full round trip.
- No Agave runtime fork for backed native issuance or atomic native burn
  receipts. Standard faucet units are explicitly non-production test units.
- No multi-validator test, deployed example program, explorer history index, or
  public RPC. The local validator and genesis are operational.
- No native ML-DSA transaction authorization, fee-payer/account ownership
  integration, validator/consensus/networking protection, bridge-authority
  protection, wallet, rotation, or recovery integration.
- No independent security review, production signer model, TLS host, abuse
  controls, backups, measured validator resource profile, or production
  deployment.

## Compatibility

The unmodified pinned Agave development node is expected to retain normal SVM
tool compatibility, but that has not been proven in this repository. Future
native issuance and post-quantum framing changes may break standard Solana SDKs,
wallets, transaction-size limits, hardware signers, and validator
interoperability. Phantom support for an arbitrary fork or ML-DSA transaction
format is not assumed.

## Required next milestones

1. Build pinned Agave, start a persistent local genesis, store its manifest,
   prove slot progress/native transfer/program invocation, and record resources.
2. Implement and test an explicit local source-vault program with isolated test
   mint plus durable receipt indexer.
3. Add reviewable runtime instructions for restricted native issuance and
   atomic burn receipts; reconcile all fee, rent, stake, treasury, and pending
   balances.
4. Integrate ML-DSA incrementally with deterministic metering and denial-of-
   service limits; preserve an explicit map of every classical surface.
5. Only then prepare public testnet operations. Production requires a reviewed
   verification/custody model and real infrastructure.

The first item is complete except program invocation: `cargo-build-sbf` is
blocked by the host Xcode/clang installation (missing `_XPCTypeBool` while
loading `libxcodebuildLoader.dylib`). Validator observation measured roughly
366 MiB RSS, about one CPU core, and a 3.8 GiB local ledger after 23 minutes;
these are one-machine development observations, not hosting guarantees.
