# Lattice bridge threat model

Status: **unaudited.** This document describes what the code in
`programs/source-vault`, `services/relayer` and `packages/protocol/src/wire.ts`
is designed to enforce, and what it does not. No third party has reviewed the
code or this analysis. Every guarantee below is a design claim, supported only
by the tests listed in `MAINNET_LAUNCH_CHECKLIST.md`.

Scope covers the Solana source vault, the relayer and the guardian attesters.
The Lattice-side builtin is specified in `NATIVE_ISSUANCE.md` and owned by
the native-issuance workstream. It appears here only where its behavior
changes bridge safety.

## 1. Assets and the invariant

- **R**: tokens locked in the Solana vault.
- **N**: LAT in circulation that the bridge minted, converted to source
  units: (minted − burned) / SCALE.
- **P**: deposits finalized on Solana but not yet minted on Lattice.
- **W**: burns on Lattice that have not yet been released on Solana.

Safety means **R ≥ N + P + W** at all times, and no release or mint happens
without a matching event on the other chain. `reconcile` computes this from
finalized state and raises an alarm if the invariant breaks or any term goes
negative (`BRIDGE_SPEC.md` §10). Direct transfers into the vault ("donations")
only add surplus.

## 2. Trust assumptions

1. **At most threshold − 1 guardians are compromised or faulty** in the
   current epoch of each chain's registry. The threshold rule
   (2·t > n, t ≥ 2, n ≤ 19) is enforced at Initialize, at rotation, and on
   Lattice.
2. **Solana finalized commitment is final.** This rests on the security of
   Solana consensus.
3. **Lattice finalized commitment is final.** This rests on Lattice consensus,
   meaning its own validator set. At launch that set will be small, so this is
   the weakest assumption in the system (see §3.3).
4. **The upgrade authority of the source vault is honest** until it is frozen
   (§3.6).
5. **Each guardian's RPC providers do not all lie together** (§3.4).
6. **The bridged token behaves like a plain SPL token**, which the token
   policy enforces (§3.9).

## 3. Threats

### 3.1 Compromised guardians

| Compromised | Effect | Mitigation |
|---|---|---|
| < t | They cannot authorize anything. A guardian that equivocates or withholds its signature only affects liveness. | Threshold verification on-chain. Duplicate and unknown signers are rejected. Only the current epoch is accepted. |
| ≥ t (Solana registry) | They can sign forged WITHDRAWALs and drain the vault, at most `max_withdrawal_per_window` per window. | Rate limit. The pauser can stop withdrawals at once. Reconciliation raises an alarm when W or R falls below what the burns justify. |
| ≥ t (Lattice registry) | They can mint LAT that no deposit backs, at most `max_mint_per_epoch` per epoch. They can then burn it to make a valid withdrawal claim. | Lattice rate limit and pause. Reconciliation flags N + P + W > R. |
| ≥ t (governance) | They can rotate to keys they control, raise limits, or replace the pauser. | None on-chain. This is the threshold assumption. Operate the guardians independently (§4). |

The rate limits bound how fast funds can be lost, not how much. **A threshold
compromise that nobody detects eventually drains the vault.** Monitoring and
pausing must react within one rate window.

### 3.2 Relayer compromise

The relayer has no authority over funds. It cannot build a message that
guardians will sign. An attester accepts only `(direction, nonce)`, reads the
event itself from its own RPC endpoints at finalized commitment, and builds
the canonical bytes. Payout goes only to the attested recipient: the
recipient's token account must be the canonical ATA of the attested owner,
on the bound mint. A malicious relayer can therefore only:

- **censor or delay** claims. Anyone can run a relayer, and submission is
  permissionless;
- **waste its own fee payer's SOL or LAT**;
- **pay rent for attestation PDAs.** The rent is refunded to the
  `rent_recipient` given at Release or Govern time.

The relayer's database is not trusted for safety. Exactly-once is enforced
on-chain by the consumed PDA and the Lattice mint record. The database
constraints (unique `event_id`, unique `digest`, compare-and-set transitions)
only prevent duplicate work.

### 3.3 Lattice consensus

If an attacker controls Lattice's finalized fork, it can produce finalized
burn receipts that never happened. Honest guardians would then attest to
them, because they cannot tell the difference. **The bridge is no more
secure than Lattice consensus.** Mitigations:

- the withdrawal rate limit;
- guardians can stop signing if Lattice shows forks or validator-set
  anomalies;
- the pauser.

A young chain with few validators is cheap to attack relative to the value
in the vault. Set caps to match.

### 3.4 RPC lies and disagreement

Each `QuorumReader` queries all configured endpoints and needs `quorum`
finalized answers:

- **Genesis check.** Endpoints that report the wrong genesis hash are
  excluded.
- **Immutable records** (receipts, consumed markers, mint and burn records)
  must agree byte for byte.
- **Mutable accounts** must agree within the same slot.
- **Disagreement** raises `RpcDisagreement`, a critical log, and no
  progress.
- **Production** requires a quorum of at least 2 on distinct hosts.

Residual risk:

- If every endpoint of one guardian lies the same way, that guardian signs a
  false event. That needs t guardians with fully corrupted RPCs, so each
  guardian should use providers the others don't, ideally its own node.
- Omission ("not found") can only delay; it cannot forge.
- The end-to-end test reaches its quorum with two connections to one local
  validator. It exercises the logic, not provider independence.

### 3.5 Reorgs and finality

- Only `finalized` state starts or completes a claim. `confirmed` is used for
  one thing only: skipping a resubmission when the consumed marker is already
  visible. Completion still waits for finalized.
- A deposit is attested only after its receipt PDA is finalized. Its nonce is
  the program's monotonic sequence, so a reorg cannot reuse a nonce with
  different content on the finalized chain.
- If a dropped fork had produced a "confirmed" consumption, the claim stays
  `submitted` and the engine resubmits. The on-chain consumed PDA keeps that
  from paying out twice.

### 3.6 Upgrade authority

Until it is frozen, the source-vault upgrade authority can deploy code that
drains the vault, ignoring guardians. It is effectively a single key over all
locked funds, and the reason the program design avoids an admin key does not
hold until the authority is removed. The plan (program README):

1. deploy and initialize in one ceremony;
2. hand the authority to a hardware-backed multisig independent of the
   guardians;
3. run a public soak period;
4. `--final`.

On Lattice the bridge is a builtin with no upgrade authority. Changes require
a fork release and a feature gate, which puts trust in the validator
operators instead.

### 3.7 Replay and cross-domain confusion

Every signed digest covers:

- the domain string and protocol version;
- the kind and scheme;
- the deployment id;
- both genesis hashes;
- the source program id and the mint;
- the signer epoch, the nonce, the amounts, the recipient and the event id.

Protections:

- **Replay within a deployment.** Release creates the consumed PDA
  `["withdrawal", nonce]`, and Lattice creates the mint record
  `["minted", deployment_id, seq]`. A second attempt fails because the
  account already exists.
- **Cross-chain or cross-deployment replay.** A different genesis,
  deployment id, program or mint changes the digest and fails the binding
  checks.
- **Kind confusion.** Kinds 1–4 have different, exact lengths and are
  checked per instruction. Lattice rejects kind 3, and Solana rejects kinds
  1 and 4 for Release and Govern.
- **Stale epochs.** Only the current epoch verifies. After a rotation, an
  unconsumed claim is re-signed under the new epoch with the same nonce, and
  it can still be consumed only once.
- **Equivocation.** Each attester's fsynced journal refuses a second digest
  for the same (kind, nonce, epoch). Losing the journal file removes that
  protection. On-chain uniqueness per nonce still holds.

### 3.8 Key loss

There is no admin recovery path, by design. If more than n − t guardians of
a registry lose their keys, that direction stops permanently. Funds stay
locked, and the only recovery is a program upgrade on Solana (if the
authority is not yet frozen) or a fork release on Lattice. Mitigations:

- choose n − t ≥ 2;
- keep sealed, offline backups of each guardian key under separate control;
- rotate promptly when a guardian leaves.

Losing the pauser key only removes fast pausing. Threshold governance can
still pause and set a new pauser.

### 3.9 Token risks

Initialize rejects:

- a freeze authority;
- token programs other than SPL Token and Token-2022;
- any Token-2022 mint extension outside the allowlist (metadata and group
  pointer and data types). This excludes transfer fees, transfer hooks,
  permanent delegate, confidential transfers, close authority, default
  account state and non-transferable.

Deposits credit the measured balance delta, not the requested amount.
Remaining risks:

- **Mint authority not checked.** The program does not require it to be
  revoked. An active mint authority can create new supply. Each new token is
  still backed 1:1 when bridged, but the token itself gets diluted. Verify
  that the authority is revoked before launch.
- **Bonding-curve tokens.** For a Pump.fun token, the bridge must bind the
  final SPL mint. Bridging during the bonding-curve phase depends on
  Pump.fun program behavior, which this repo does not model.
- **Wrong mint.** The mint is bound forever, so binding the wrong one means
  a new deployment.

### 3.10 Griefing and denial of service

- **Rate windows.** An attacker who is willing to lock real tokens, or burn
  real LAT, can fill the deposit or withdrawal window and delay others. The
  attacker gets value back (LAT or tokens), so the cost is capital and fees
  only. Size the windows well above organic demand, and watch for one
  address taking most of a window.
- **Attestation PDAs.** Anyone can post valid guardian signatures. The PDA
  is keyed by digest, so this cannot block a claim.
- **Lattice attestation accounts.** These are fresh keypair accounts. An
  abandoned one wastes only its creator's rent, and the relayer closes it
  on failure.

### 3.11 Quantum adversary

The Solana vault verifies only Ed25519 (`BRIDGE_SPEC.md` §11). An attacker
who can forge Ed25519 can forge withdrawals there. On Lattice, a hybrid
guardian set (scheme 3) requires both Ed25519 and ML-DSA-65 signatures.
The relayer and attesters support it, but it has not yet been tested
against the fork validator. A quantum adversary therefore threatens the
vault (Solana) side, and nothing in this repo can fix that until Solana
offers a post-quantum verifier.

### 3.12 Operational key exposure

- **Guardian keys** load only from a file that is owner-only (mode 600) and
  outside any git work tree, or from an HSM after future work. No key is
  ever read from the web app or the repo.
- **Attester endpoint.** It requires a bearer token in production. It
  accepts no message bytes, so a leaked token only lets an attacker request
  signatures over true finalized events.
- **Relayer fee-payer keys** are hot keys. Fund them minimally.

## 4. Operating requirements that follow

1. Each guardian runs on separate infrastructure, under a separate operator
   and cloud account, with its own RPC providers. Keys stay in HSM or
   offline-generated files.
2. Set rate limits and the deposit cap so that one window's loss is
   survivable. Raise them gradually.
3. Run reconciliation continuously and page on any alarm. An operator must
   be able to pause within one rate window.
4. Freeze the upgrade authority after the soak period.
5. Get an external audit of every component in §0 scope, plus the Lattice
   builtin, before any mainnet value is held.

## 5. Known gaps in verification

- No external audit.
- No fuzzing and no formal verification. The program has 9 host unit tests;
  the relayer has 59 TypeScript tests and the protocol package 14.
- The program was tested on the local validator, not with LiteSVM, because
  disk space was tight. There is no compute-unit regression suite.
- The Lattice adapter, including hybrid staged mints, has been checked only
  against its documented layout and an in-memory reference. It has not run
  against the fork validator.
- The end-to-end RPC quorum used one physical validator.
- The SBPF version for mainnet has not been chosen. The local build used v3.
