# Cutover procedure: adding a third, independent validator

Status: **prepared in advance — not executed, no validator3 exists
yet.** This is ready to run once a real independent operator has
completed `ONBOARDING.md` and sent back their validator address and
announced storage location. Written now so cutover isn't improvised
under time pressure once a real candidate shows up.

## Precondition

Before starting any step here:
- `scripts/verify-deployment.ts` has been run against a `deployment.json`
  that includes the candidate validator3 entry, and every check for it
  passes (announcement, reachability, freshness/checkpoint-currency).
- The candidate's `deployment.json` entry has **every** field genuinely
  distinct from `validator1`/`validator2` — `operator`, `account`,
  `provider`, `iamPrincipal`, `s3Bucket` — confirmed by
  `verify-deployment.ts`'s `independence` check reporting fewer shared
  dimensions than before (ideally zero shared dimensions for the new
  validator specifically).
- The candidate's key has never been sent to, or handled by, Anchor's
  operator — only the address.

If any of these aren't true, do not proceed — adding a validator that
doesn't genuinely satisfy independence doesn't improve gate item 4, it
just makes the ISM's validator count look bigger.

## Decision to make before executing: threshold

Adding a third validator means deciding the new threshold. Two
reasonable options, pick one deliberately rather than defaulting:
- **Keep threshold at 2 (2-of-3)**: any two of three validators can
  attest — improves availability (one validator can be down/misbehaving
  without blocking delivery) without weakening the security bar (still
  needs collusion/compromise of at least 2 independent parties).
- **Raise threshold to 3 (3-of-3)**: requires all three — strictly
  stronger security bar, but any single validator's outage blocks all
  delivery, which given this project's own history of validator
  incidents (OOM crash-loops, RPC rate-limiting) is a real availability
  risk to weigh.

Recommendation: **2-of-3**, given this project's demonstrated real
availability risk on individual validators — record whichever is
chosen and why before executing step 1.

## Steps

### 1. Deploy a new multisig ISM including all three validators

Via Hyperlane's own canonical `staticMerkleRootMultisigIsmFactory` (same
factory used for the current 2-validator ISM — see
`docs/self-hosted-validator-setup.md` for that original deployment).
Record: the new ISM's deployed address, deployment transaction hash,
and confirm on-chain via `validatorsAndThreshold(bytes)` that it
reports exactly the 3 expected addresses and the chosen threshold.

### 2. Point `DecisionRelay` at the new ISM

`DecisionRelay.sol`'s `interchainSecurityModule()` is a stored address,
settable only via the contract's governance path — a **2-of-2 Safe
transaction** (see `docs/multisig-attestor-setup.md`), not a plain
`cast send`. Requires both Safe signers' independent sign-off, same as
any other governance change this project makes. Record: the Safe
transaction hash and the two signers who approved it.

### 3. Update the relayer's whitelist configuration

`chains/hyperlane-relayer/entrypoint.sh`'s `WHITELIST` already points at
the current `DecisionRelay` address — since this cutover does **not**
change `DecisionRelay`'s own address (only its ISM), no whitelist edit
should be needed. Confirm this assumption explicitly rather than
skipping the check: after step 2, run
`scripts/verify-deployment.ts`'s `relayer:whitelist` and
`decisionrelay:ism` checks and confirm both still pass.

### 4. Verify end-to-end before declaring done

- Run `scripts/verify-deployment.ts` against the updated
  `deployment.json` (all 3 validators) — confirm `ism:validator-set`
  reports exactly 3 addresses, `ism:threshold` reports the chosen
  value, `decisionrelay:ism` confirms the live contract points at the
  new ISM.
- Dispatch a real test message (same pattern as
  `chains/evm/contracts/DeliveryProofReceiver.sol` — see
  `docs/production-readiness-hardening-pass.md`'s fifth addendum for
  the exact precedent) and confirm it delivers, proving the new
  validator set can actually reach threshold together, not just that
  the ISM's config looks right on paper.
- Confirm `independence` check reports the improved (fewer shared
  dimensions) result.

## Rollback

If the new ISM is broken (wrong validator set, wrong threshold, a
config mistake found only after cutover):

1. **Do not delete the old ISM** — its deployed address/bytecode stays
   valid and untouched throughout this procedure; nothing about
   deploying a new ISM in step 1 affects it.
2. Rollback is the same governance mechanism as the cutover itself: a
   second 2-of-2 Safe transaction calling `DecisionRelay`'s
   `interchainSecurityModule()` setter, pointed back at the old
   (2-validator) ISM's address.
3. Verify via `scripts/verify-deployment.ts`'s `decisionrelay:ism`
   check that the rollback actually took effect on-chain — don't assume
   the Safe transaction succeeding means the value is what was intended
   (this project's own history includes more than one case where an
   on-chain value didn't match what was intended to be deployed).
4. Any message dispatched during the broken window queues undelivered
   (same as any other undelivered-message case
   `verify-deployment.ts`'s SLA check already alerts on) — rolling the
   ISM back doesn't retroactively fix messages already rejected by the
   broken config; they need re-dispatch once the working ISM is back.

## What this procedure deliberately does not cover

- Recruiting or vetting the independent operator themselves — a real
  human/organizational decision, not something this document can
  automate.
- The Solana side's validator/ISM situation — unrelated; Solana's
  transport remains `TRUSTED_ISM` per `chains/solana/ISM_MIGRATION.md`,
  a separate, not-yet-started migration.
- Any change to attestor keys, the Safe's own signer set, or settlement
  authorization — this procedure only touches Hyperlane's message
  *transport* verification (which validators sign checkpoints), never
  who can authorize a settlement.
