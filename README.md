# Lattice

**Solana, built for quantum.** Lattice is a Solana-derived network (a fork of Agave v4.3.0) that adds NIST ML-DSA post-quantum signatures, verified by the chain itself, and a native coin, LAT, designed to redeem 1:1 for its source token on Solana.

The network code lives in [`network/`](network/). The existing web app at the repository root is unchanged.

## Status

| Component | Status |
| --- | --- |
| Lattice devnet: validator, RPC, WebSocket, explorer, faucet | Live (local development) |
| Website: live RPC vitals, peg charts, bridge UI, docs | Live (local development) |
| Development bridge: deposit, issue, burn, redeem with test assets | Live (local development) |
| ML-DSA-65 verification syscall and `pq-vault` program | Implemented and tested |
| Native LAT issuance and burn (`lattice-bridge` builtin) | Implemented and tested |
| Solana source vault and guardian relayer | Implemented and tested |
| Public testnet on AWS | Deploying |
| Mainnet with real tokens | After external security review, starting with a deposit cap |

## How it works

```mermaid
flowchart TD
    A[Holder locks token in Solana source vault] --> B{Finalized on Solana?}
    B -- No --> B1[Wait for finality]
    B1 --> B
    B -- Yes --> C[Receipt recorded with deposit sequence]
    C --> D[Guardians sign canonical deposit message]
    D --> E{Threshold met? Ed25519 / ML-DSA-65 / hybrid}
    E -- No --> E1[Rejected]
    E -- Yes --> F{Deposit already consumed?}
    F -- Yes --> F1[Replay rejected]
    F -- No --> G[lattice-bridge mints exact LAT 1:1]
    G --> H[LAT used on Lattice]
    H --> I[Holder burns LAT with Solana recipient]
    I --> J[Supply destroyed + withdrawal receipt]
    J --> K[Guardians attest burn]
    K --> L{Valid and unconsumed?}
    L -- No --> L1[Rejected]
    L -- Yes --> M[Source vault releases original tokens]
```

```mermaid
flowchart LR
    subgraph Solana
        V[Source vault program]
    end
    subgraph Off-chain
        R[Relayer] --> G[Guardian attesters]
        MON[RPC monitor]
    end
    subgraph Lattice
        N[Agave fork validator]
        B[lattice-bridge builtin]
        Q[ML-DSA-65 syscall]
        RPC[HTTP + WebSocket RPC]
    end
    W[Website and SDK] --> RPC
    V --> R
    G --> B
    B --> N
    Q --> N
    N --> RPC
    MON --> RPC
```

Backing invariant: reserves in the vault must cover everything owed, `R >= N + P + W` (native supply plus pending deposits plus pending withdrawals). Reserves and liabilities are published from on-chain data.

## Run locally

```sh
cd network
corepack enable && pnpm install
./chain/scripts/start-local.sh --reset   # Lattice devnet on :8899 / :8900
pnpm build && pnpm --filter @lattice/web start
```

Open http://localhost:3000. Read the specification in [`network/docs/BRIDGE_SPEC.md`](network/docs/BRIDGE_SPEC.md), the post-quantum scope in [`network/docs/QUANTUM.md`](network/docs/QUANTUM.md), and the deployment runbook in [`network/infra/RUNBOOK.md`](network/infra/RUNBOOK.md).

## Security

Post-quantum protection currently covers runtime-verified ML-DSA authorization. Fee payers, validator identity, consensus and networking still use Ed25519. The source token on Solana remains as secure as Solana. The bridge code is unaudited; no real funds until review.
