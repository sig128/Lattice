# Lattice bridge mainnet launch checklist

Status: **not ready for mainnet.** The bridge code (`programs/source-vault`,
`services/relayer`, `packages/protocol/src/wire.ts`) is unaudited. Nothing
here has been deployed outside the local test validator. Every unchecked item
below blocks launch. See `BRIDGE_THREAT_MODEL.md` for the reasoning.

## 0. What exists today (verified locally)

| Component | Tests | Where |
|---|---|---|
| Source vault, host unit tests | 9 (codec, cross-language vector, Ed25519 instruction parsing) | `cd programs/source-vault && cargo test --lib` |
| Source vault on the real local validator | 15 (legacy SPL and Token-2022: init authority, freeze and extension policy, deposits, every Release rejection path, replay, threshold, pause semantics, rotation, limits, overflow) | `services/relayer/test/program.validator.test.ts` |
| Relayer and attester end to end on the validator | 3 (deposit to mint, crash after release submit, reconciliation with donation) | `services/relayer/test/e2e.validator.test.ts` |
| Relayer state machine on PostgreSQL | crash at each fault point, concurrent engines, epoch retargeting, hybrid deposit | `services/relayer/test/engine.pg.test.ts` |
| Attester, quorum, reconciliation, Lattice adapter | unit | `services/relayer/test/*.test.ts` |
| Wire format | 6, plus the shared vector pinned by the Lattice builtin | `packages/protocol/src/wire.test.ts` |

## 1. Decisions that must be made and signed off

- [ ] **Source mint.** No mint is configured anywhere in this repo, by design.
  - [ ] Record the Pump.fun token's final SPL mint address and where it came
    from: the Pump.fun page, on-chain creation tx and migration tx, checked
    independently by two people.
  - [ ] Confirm on-chain that the freeze authority is `None` (the program
    enforces this) and the mint authority is `None` (the program does **not**
    enforce this).
  - [ ] Record the token program (SPL Token or Token-2022) and its extensions.
  - [ ] Confirm decimals ≤ 9. Pump.fun tokens use 6, giving SCALE = 1000.
- [ ] **Deployment label.** It sets `deployment_id`. Use a new one per
  deployment; a test label must never be reused.
- [ ] **Guardians**: the set n and threshold t for each registry, with
  2t > n, t ≥ 2 and n − t ≥ 2. The Lattice scheme should be 3 (hybrid).
- [ ] **Limits**:
  - [ ] `deposit_cap`, the rate window, and the per-window maxima on
    Solana;
  - [ ] `max_mint_per_epoch` on Lattice.
  - [ ] Write down the loss you accept for one window.
- [ ] **Pauser** key holder(s), with a 24/7 on-call rotation.
- [ ] **Upgrade-authority multisig**: its members and threshold, independent
  of the guardian operators.

## 2. Code and audit

- [ ] An external audit of `programs/source-vault`, the attester and relayer
  (`services/relayer/src`), `packages/protocol/src/wire.ts`, and the Lattice
  `lattice-bridge` builtin and runtime supply patch. Fix all findings and
  publish the report.
- [ ] Fuzz the message decoders and the program instruction parsing, which
  are not fuzzed today.
- [ ] Add LiteSVM or `solana-program-test` coverage with compute-unit
  budgets. Today's program tests run only on the local validator, because
  disk space blocked LiteSVM.
- [ ] **Lattice integration:**
  - [ ] Run the relayer's `SpecLatticeAdapter` against a fork validator with
    the `lattice-bridge` builtin.
  - [ ] Cover `LATGSET1` decoding, staged mints with scheme 1 and scheme 3,
    burns, and the rejection paths.
  - [ ] Measure real compute use per `VerifyAttestation` batch.
  - [ ] Today this is checked only against `NATIVE_ISSUANCE.md` and the
    in-memory reference.
- [ ] Freeze the wire format: the `BRIDGE_SPEC.md` test vector must pass in
  TypeScript, the source vault and the Lattice builtin.

## 3. Build and deploy (Solana)

- [ ] Choose the SBPF version mainnet-beta accepts on deployment day
  (`solana feature status -um`). Local builds use `--arch v3` because the
  test validator activates SIMD-0500.
- [ ] Make the build reproducible with `solana-verify` and a pinned image. Two
  independent builders must get the same hash. The commit and hash go in the
  launch record.
- [ ] Generate the program id keypair at the ceremony. Never use
  `keys/source-vault-program.json`.
- [ ] **Order matters for genesis binding:**
  1. Fix the source program id and mint.
  2. Build the Lattice genesis, which embeds them, and record the Lattice
     genesis hash.
  3. Deploy the source vault and run `Initialize` with that Lattice genesis
     hash. It is immutable.
  4. Execute `BindLatticeGenesis` on Lattice with the same hash.

  If Lattice is ever re-genesised, the vault stays bound to the old hash and
  can never release again unless it is upgraded. Do not hold real value
  until the Lattice genesis is final.
- [ ] Right after `Initialize`, read back every config field with
  `decodeConfig` and compare it with the signed parameters. Two people
  check.
- [ ] **Upgrade-authority plan** (program README):
  - [ ] Transfer the authority to the multisig.
  - [ ] Destroy the deploy key.
  - [ ] Publish the multisig.
  - [ ] Announce the soak period.
  - [ ] Run `set-upgrade-authority --final` at its end.

## 4. Guardian key ceremony

- [ ] Each guardian generates its keys on its own machine (air-gapped or
  HSM):
  - an Ed25519 key, used on both chains;
  - an ML-DSA-65 seed for hybrid Lattice sets.

  No machine ever holds two guardians' keys.
- [ ] Keys reach the attester only through `GUARDIAN_KEY_FILE` and
  `GUARDIAN_MLDSA_KEY_FILE`. Those files must be mode 600 and outside any git
  work tree, and the loader refuses anything else. HSM signing support is
  future work and needs its own review.
- [ ] Only public keys are collected, each signed by its owner and
  cross-checked out of band. The guardian set is assembled from them.
- [ ] Keep sealed offline backups under each guardian's control. Rehearse
  restoring one.
- [ ] Rehearse rotation on testnet: kind 3 on Solana and kind 4 on Lattice,
  including re-signing in-flight claims.

## 5. Infrastructure

- [ ] **Each attester** runs on separate infrastructure under a different
  operator and cloud account. It needs:
  - its own RPC providers: at least 2 per chain on distinct hosts, ideally
    including a node it runs itself;
  - `ATTESTER_TOKEN` set;
  - a journal file on durable storage that is backed up.
- [ ] **Relayer:**
  - PostgreSQL with backups and point-in-time recovery;
  - run `migrate` before start;
  - hot fee-payer keys funded minimally;
  - a quorum of at least 2 distinct RPC hosts per chain (enforced in
    production).
  - More than one relayer instance is safe: there is an advisory-lock
    leader, and the on-chain dedupe backs it up.
- [ ] **Reconciliation:**
  - run `reconcile` on a schedule;
  - publish the status JSON;
  - keep its history in `reconciliation_samples`.

## 6. Monitoring and alerting

- [ ] Page on any of these:
  - a reconciliation alarm (R < N + P + W, or a negative term);
  - `RpcDisagreement`;
  - attester logs "observed a different message" or "invalid or foreign
    signature";
  - a journal refusal (equivocation attempt);
  - claims stuck in `submitted` beyond N minutes;
  - `failed` claims;
  - a rate window above 80%;
  - a vault balance change with no matching receipt or release;
  - any upgrade-authority or ProgramData change;
  - any guardian-set rotation.
- [ ] Watch `/healthz`, `/readyz` and `/status` from outside the hosts.
- [ ] Watch the Lattice side as well: state flags, guardian epoch,
  `outstanding_native`, and validator-set health.

## 7. Incident runbook (rehearsed before launch)

1. **Suspected guardian, RPC or Lattice compromise.** The pauser pauses
   withdrawals, deposits, or both, on both chains. Pausing needs one key;
   unpausing needs the threshold.
2. **Freeze the evidence.** Keep the relayer database, attester journals,
   and RPC logs.
3. **Compare** the reconciliation history with on-chain receipts to bound
   the loss.
4. **If guardian keys leaked:** threshold-rotate them out (kind 3 and kind 4)
   from uncompromised guardians, and re-sign pending claims under the new
   epoch.
5. **If funds were drained beyond the threshold:** there is no on-chain
   recovery. Communicate, and use the upgrade multisig only while it still
   exists, following its documented emergency process.
6. **Unpause** only with a threshold governance message after root cause is
   found. Publish a post-mortem.

## 8. Launch staging

- [ ] Run a public testnet / devnet deployment for at least several weeks
  with all guardians on production-like infrastructure.
- [ ] Launch mainnet with a small `deposit_cap` and small windows. Raise them
  in steps by threshold governance (`SetLimits`) as monitoring proves itself.
- [ ] Publish this checklist, the audit, the build hash, program ids,
  guardian keys, limits and the upgrade-authority status.
