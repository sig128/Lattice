# Lattice chain baseline

The selected upstream is Agave `v4.3.0` at commit
`825efd18292aff6ffcf9daa0f7612f21b3531a72`. The source is not vendored and no
runtime patch is claimed yet. Fetch it with:

```sh
./chain/scripts/fetch-upstream.sh
```

Follow the build instructions in that exact checkout. Upstream commands can
change between releases. Once `solana-test-validator` from the pinned checkout
is on `PATH`, start an isolated local ledger:

```sh
./chain/scripts/start-local.sh --reset
solana --url http://127.0.0.1:8899 genesis-hash
solana --url http://127.0.0.1:8899 slot
```

`--reset` is guarded to local development and is explicit. Omit it to preserve
the ledger. Ports are HTTP RPC `8899`, WebSocket `8900`, and faucet `9900`.

## Verified local deployment

- Agave `4.3.0` (`src:825efd18`) is installed through the official Anza
  installer.
- Local genesis: `G9818341AwzwpDqHoh3uqy2hS8AkM1d9WCYbaX6YcVRU`.
- HTTP RPC `http://127.0.0.1:8899` and WebSocket
  `ws://127.0.0.1:8900` were verified with advancing finalized slots,
  `getGenesisHash`, `getHealth`, a native transfer, and a slot subscription.
- The ledger persists under `chain/ledger/local-development`; restart without
  `--reset` to preserve this identity.

## Current divergence and limitations

- The baseline validator above is unpatched. Native issuance and burn exist
  only on the fork branch (patches `0004`–`0008`, see below); they are
  unaudited and not deployed.
- The validator proves an independent genesis, advancing slots, native
  transfers, and RPC subscriptions. It does not establish decentralization.
- The default faucet produces unbacked local test units. They can never be
  relabeled, upgraded, or imported as production units.
- Standard Agave transaction authorization, validator identity, gossip, and
  consensus signatures remain classical.
- Multi-validator orchestration remains pending until fork identity and runtime
  patches are defined. Several nodes under one operator would still not prove
  independent decentralization.
- `cargo-build-sbf --manifest-path programs/counter/Cargo.toml` was attempted
  with cargo-build-sbf 4.3.0 / platform-tools 1.57. It is currently blocked by
  the host Xcode installation: `xcodebuild` cannot load
  `libxcodebuildLoader.dylib` because `_XPCTypeBool` is missing, then reports
  `Failed to locate clang`. Repairing or reinstalling Xcode command-line tools
  is the exact external dependency; no program deployment is claimed.

## PQ fork (experimental, separate from the baseline above)

`chain/agave` carries branch `lattice/pq-mldsa-v1`: three patches exported to
`chain/patches/`. They add an ML-DSA-65 `sol_mldsa65_verify` syscall behind a
feature gate. `chain/programs/pq-vault` is an SBF program that uses it. The
fork runs on its own ports (RPC 8999, WS 9000, faucet 9990, gossip 10050,
dynamic 10100-10200) with ledger `chain/ledger/pq-local`, via
`chain/scripts/pq-build.sh` and `chain/scripts/pq-start-local.sh`. It never
touches the baseline validator. See `docs/QUANTUM.md` and
`chain/evidence/pq-local.json`.

Patches `0004`–`0008` on the same branch add native LAT issuance and burn:
a runtime hook that lets only the `lattice-bridge` builtin change native
supply (capitalization), the builtin itself (guardian-threshold mint from
Solana deposits, burn with receipts, governance, pauses, rate limit), and
`solana-genesis --lattice-network mainnet|testnet`. Build and test on the
server with `chain/scripts/build-lattice-validator.sh`; create genesis with
`chain/scripts/lattice-genesis.sh`. See `docs/NATIVE_ISSUANCE.md`.
Unaudited.
