# Lattice

Lattice is an experimental Solana-derived network workspace. This initial
delivery implements the truthful product interface, typed asset/network
configuration, source-mint inspection, exact bridge accounting primitives,
domain-separated bridge messages, an independent RPC monitor, and an off-chain
ML-DSA signing prototype.

It does **not** currently run a production network or bridge. No source mint is
configured, no real funds should be sent, and the system is not audited or
quantum resistant.

## Run

Requirements: Node.js 22+, pnpm 10.19.0, and optionally PostgreSQL 16+.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm test
pnpm dev
```

Open <http://localhost:3000>. Machine-readable endpoints:

- `GET /api/network-manifest`
- `GET /api/status`

Run the monitor against the allowlisted endpoints in configuration:

```sh
pnpm monitor
```

Run the verified local platform:

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
./chain/scripts/start-local.sh          # preserve the configured genesis
pnpm --filter @lattice/bridge setup:local
pnpm --filter @lattice/bridge record
pnpm --filter @lattice/example-native-transfer start
```

The configured genesis is
`G9818341AwzwpDqHoh3uqy2hS8AkM1d9WCYbaX6YcVRU`. Resetting the ledger creates a
different identity and therefore requires an explicit configuration update.

Without `DATABASE_URL`, observations are emitted as structured logs. With a
PostgreSQL URL, the worker creates and writes its `rpc_observations` table. The
monitor does not accept visitor-supplied URLs.

## Configure the source mint

Set the exact public Solana mint address—never a private key:

```sh
SOURCE_TOKEN_MINT=<MINT> pnpm validate:asset
```

The validator checks the expected genesis, supported token-program ownership,
initialized mint layout, decimals, supply, authorities, and explicitly blocked
Token-2022 extensions. A successful result still reports Pump.fun provenance
as unverified: production configuration requires separate creation evidence.

To display a mint read-only, set `NEXT_PUBLIC_SOURCE_TOKEN_MINT`. This does not
configure a vault, bind on-chain state, or enable deposits. The complete
production record must be committed through the versioned schema in
`packages/config`; changing a website environment variable cannot retarget a
deployed bridge.

For the website development server, paste the public mint in one command:

```sh
NEXT_PUBLIC_SOURCE_TOKEN_MINT=<EXACT_SOLANA_MINT> pnpm dev
```

This activates source identity display and server-side GeckoTerminal market
history (24H/7D/30D) when a real pool exists. It does **not** activate the
production bridge. Validate the mint separately before treating its identity or
Pump.fun provenance as verified:

```sh
SOURCE_TOKEN_MINT=<EXACT_SOLANA_MINT> pnpm validate:asset
```

## Development chain

`chain/upstream.lock.json` pins Agave v4.3.0. See `chain/README.md` for fetching,
building, and starting an independent local ledger. No validator was started as
part of the repository build unless explicitly shown in the verification
report.

## Package map

- `apps/web` — responsive documentation-style product, status, bridge empty
  state, explorer empty state, and developer APIs.
- `packages/config` — versioned runtime schema and Solana mint inspection.
- `packages/protocol` — integer conversion, bridge message encoding, claim
  transitions, and `R >= N + P + W` reconciliation.
- `packages/crypto` — off-chain ML-DSA-65 prototype and benchmark.
- `services/monitor` — bounded HTTP and WebSocket RPC probes with optional
  PostgreSQL persistence.
- `services/bridge` — operator-attested local test-asset setup, real
  deposit/redemption demonstration, and persistent reconciliation samples.
- `examples/native-transfer` — genesis verification, faucet, balance, native
  transfer, confirmation, and WebSocket slot subscription.
- `chain` — pinned Agave baseline and reset-safe local launcher.
- `docs` — trust, compatibility, and completion status.

## Safety boundary

The local test validator faucet is unbacked development money. The source-vault
program, durable relayer state machine, destination native issuance/burn runtime
changes, production signer model, and public infrastructure remain future
milestones. See `docs/STATUS.md`.
