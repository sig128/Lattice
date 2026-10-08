<p align="center">
  <img src=".github/assets/banner.svg" alt="Lattice: Solana, built for quantum." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/anza-xyz/agave/releases/tag/v4.3.0"><img alt="Agave fork" src="https://img.shields.io/badge/Solana%20fork-Agave%20v4.3.0-9945FF?style=flat-square&logo=solana&logoColor=white" /></a>
  <a href="https://csrc.nist.gov/pubs/fips/204/final"><img alt="ML-DSA-65" src="https://img.shields.io/badge/post--quantum-ML--DSA--65%20%C2%B7%20FIPS%20204-202020?style=flat-square" /></a>
  <img alt="Redemption" src="https://img.shields.io/badge/LAT%20%E2%86%94%20TOKEN-1%3A1-202020?style=flat-square" />
  <img alt="Devnet" src="https://img.shields.io/badge/devnet-live-176b3a?style=flat-square" />
  <a href="https://18.213.75.190"><img alt="Testnet" src="https://img.shields.io/badge/public%20testnet-live-176b3a?style=flat-square" /></a>
  <img alt="Bridge" src="https://img.shields.io/badge/bridge-unaudited-8a5a00?style=flat-square" />
</p>

<p align="center">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.97-000000?style=flat-square&logo=rust&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10-F69220?style=flat-square&logo=pnpm&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-18-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
  <img alt="AWS" src="https://img.shields.io/badge/AWS-EC2-FF9900?style=flat-square&logo=amazonwebservices&logoColor=white" />
</p>

<p align="center">
  <a href="https://x.com/sig128"><img alt="Follow on X" src="https://img.shields.io/badge/follow-%40sig128-000000?style=flat-square&logo=x&logoColor=white" /></a>
  <a href="https://github.com/PolyClawdDev/Lattice/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/PolyClawdDev/Lattice?style=flat-square&color=202020" /></a>
  <a href="https://github.com/PolyClawdDev/Lattice/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/PolyClawdDev/Lattice?style=flat-square&color=202020" /></a>
  <img alt="Repo size" src="https://img.shields.io/github/repo-size/PolyClawdDev/Lattice?style=flat-square&color=202020" />
</p>

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
| Public testnet on AWS: website, JSON-RPC, WebSocket, rate-limited faucet | Live at [https://18.213.75.190](https://18.213.75.190) (testnet, unbacked test units) |
| Mainnet with real tokens | After external security review, starting with a deposit cap |

### Public testnet

| | URL |
| --- | --- |
| Website | [https://18.213.75.190](https://18.213.75.190) |
| HTTP JSON-RPC | `https://18.213.75.190/rpc` |
| WebSocket | `wss://18.213.75.190/ws` |
| Genesis hash | `3UEpafESpcQx1NbeSGKEYsF3sFqUiiQV9yu8pFL397QS` |

```sh
solana --url https://18.213.75.190/rpc genesis-hash
```

Single-validator testnet running the official Agave v4.3.0 release on AWS. Test units are unbacked and the testnet can be reset. The public RPC serves allowlisted methods only, with per-IP rate limits; admin methods and `requestAirdrop` are blocked (use the site faucet). The TLS certificate is a short-lived Let's Encrypt IP certificate.

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
