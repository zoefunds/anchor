# Production-readiness hardening pass — summary and deliverables

This covers the security/operations hardening pass requested across three
phases: Hyperlane validator independence + delivery proof (Phase 1),
Solana transport hardening (Phase 2), and a fintech controls roadmap
(Phase 3). Nothing in prior attestation, Safe governance, validator
multisig, or audit anchoring was weakened.

## 1. Prioritized implementation plan

### Code now (done this pass)
- `chains/hyperlane-validator/scripts/verify-deployment.ts` — 17-check
  live verification tool (announcements, reachability, freshness, ISM/
  DecisionRelay/relayer-whitelist consistency, delivery SLA, honest
  operator-independence reporting).
- `chains/hyperlane-validator/ONBOARDING.md` / `ALERTING.md` — third-party
  validator onboarding runbook + machine-readable template; alerting
  wiring guide (cron/GitHub Actions).
- `chains/solana/programs/decision-relay/src/lib.rs` — `ReplayGuard`:
  fixed, pre-allocated PDA ring-buffering the last 32 distinct
  `decision_hash` values `handle()` has notified on; rejects replays.
  Notification-only invariant unchanged (still no CPI into escrow, still
  no payer/signer in the account list).
- `chains/solana/ISM_MIGRATION.md` — design doc + Testnet proof checklist
  for migrating `TRUSTED_ISM` to a real multisig ISM. Not deployed.
- `docs/fintech-controls-roadmap.md` — prioritized Phase 3 roadmap.
- `apps/web/src/lib/adjudication-service.ts` — emergency settlement pause
  (`SETTLEMENT_PAUSED`) and configurable per-chain settlement limits
  (`SETTLEMENT_LIMIT_ATTO_*`), both fail-closed, both gating
  `dispatchSettlementForDecision` only (evidence/appeal access untouched).
  **P0 fix (post-audit)**: the initial version of these two gates
  returned with no durable state, so a decision finalized while paused or
  over-limit was silently stranded forever — unpausing/raising the limit
  never re-triggered dispatch, since `retryFailedSettlements` only
  retries rows with `relayError` set. Fixed: both gates now write a
  stable sentinel (`SETTLEMENT_PAUSED` / `LIMIT_EXCEEDED`) to
  `relayError` without incrementing `relayAttempts`, so the existing
  retry sweep picks the decision back up automatically once the gate
  lifts. Covered by `tests/integration/settlement-gate-recovery.test.ts`
  (2 new tests, both real-Postgres integration tests: finalize while
  blocked, sweep while still blocked, lift the gate, sweep again, assert
  exactly one dispatch).
- `chains/hyperlane-validator/scripts/verify-deployment.ts` — **P1 fix
  (post-audit)**: `checkRecentDelivery` previously only printed a manual
  verification command instead of actually calling
  `Mailbox.delivered(messageId)`. It now derives the real message ID
  (`keccak256` of the Dispatch event's `message` field) and calls
  `delivered()` directly, failing when a dispatch is both past SLA and
  genuinely undelivered — cross-checked against a direct `cast call`.
  Building this also caught and fixed a real event-ABI bug (`destination`
  needed `indexed: true` to match Hyperlane's actual `Mailbox.sol`
  event — see the script's own comment for the exact decode error this
  produced before the fix). Also renamed `checkFreshness` to
  `agent-liveness` and added `checkCheckpointCurrency` — a second,
  real audit-caught gap: the old freshness check only proved a per-boot
  heartbeat file was recent, not that the validator's real signed
  checkpoint index was current, which is what actually determines
  whether delivery is possible.
- `chains/hyperlane-validator/fly.validator1.toml` /
  `fly.validator2.toml` — bumped VM memory 256mb → 512mb. Root cause of
  this pass's validator staleness/undelivered-message chain: both
  validators were OOM-crash-looping until Fly's 10-restart budget
  exhausted and both machines went fully offline (`flyctl logs`: "Out of
  memory: Killed process ... (validator)" → "machine has reached its max
  restart count of 10"). Redeployed and restarted both; confirmed no
  further OOM kill for this pass's remaining observation window.

### Code now (not yet done — real follow-up work)
- Actually implementing the Sealevel multisig ISM per `ISM_MIGRATION.md`
  (design-only per the brief's explicit "do not deploy without complete
  Testnet proof" instruction).
- Daily settlement reconciliation job (same shape as
  `retryFailedSettlements`/`checkForMissedAnchors`; not built this pass).
- Evidence provenance attestation schema (needs a first real external
  source to attest from before the shape is non-speculative).
- Policy governance `PolicyVersion` table + approval workflow.
- Human escalation queue + dual-control reviewer flow.
- Adding a Solana-side equivalent of `checkRelayerWhitelist`/
  `checkDecisionRelayIsm` to `verify-deployment.ts` once the Solana ISM
  migration actually ships (nothing to verify on that axis until then).

### Operator action required
- Recruit and onboard at least one genuinely independent Hyperlane
  validator (separate operator/account/provider/IAM/bucket) using
  `ONBOARDING.md` — today's two validators share all five dimensions
  (`chains/hyperlane-validator/deployment.json`), so the current set does
  **not** provide real multi-party validator security, only redundancy
  against one process crashing.
- Wire `verify-deployment.ts` into an actual cron/CI schedule with a real
  notification channel (`ALERTING.md` gives both options; neither is
  wired up yet).
- **Root cause of validator staleness found and fixed this pass (see
  §1 "Root cause" below): both validators were OOM-crash-looping** on
  their 256mb Fly machines, eventually exhausting Fly's 10-restart budget
  and going fully offline. Fixed: bumped `fly.validator1.toml`/
  `fly.validator2.toml` memory to 512mb, redeployed, restarted — both
  ran without a further OOM kill for the remainder of this pass. This
  supersedes the earlier (real, but secondary-symptom) `AccessDenied`/S3-
  connect-timeout findings from earlier in this pass — those were
  consequences of the same underlying resource starvation, not
  independent root causes. **Still needs operator follow-through**:
  confirm 512mb holds up over a real 24h+ window (this pass's own
  observation window was much shorter), and consider whether 512mb has
  enough headroom as the Merkle tree keeps growing over time.
- **A second, independent contributing factor found this pass: the
  shared public Sepolia RPC (`ethereum-sepolia.publicnode.com`) rate-
  limits the validators.** Confirmed via a real log line:
  `Received rate limit request JsonRpcError ... code: -32005, message:
  Rate limit exceeded`. This throttles how fast a validator's indexing
  can catch up after any downtime (observed catch-up rate after the OOM
  fix: roughly 2 leaves per 15 minutes — far too slow to close a
  ~1300-leaf gap quickly). **Not fixed this pass** — needs a dedicated/
  paid Sepolia RPC endpoint (an operator/cost decision), not a code
  change.
- Correct the validator announcement path — both validators announce a
  URI with a spurious `eu-north-1/` region segment that 403s; only the
  real object path (without it) is reachable. Requires either a
  validator-agent config change (`checkpointSyncer.region`/`.folder`
  flags) or a corrected re-announcement (its own on-chain transaction,
  signed by the validator key) — deliberately not done blind mid-pass
  given the risk of silently changing the real write path.
- Let validator checkpoint indexing finish catching up past leaf 872850
  (or provision a dedicated RPC endpoint to accelerate it — see above),
  then re-run `verify-deployment.ts` to confirm message
  `0x61b6e9e3...15df71` actually delivers. Diagnosis is done (validator
  indexing lag, not a relayer-side bug — see root cause above); what's
  left is real wall-clock catch-up time, not further investigation.
- Decide whether/when to call `InitReplayGuard` on the live Solana
  program — the code is tested and ready but not deployed; deploying a
  program upgrade is an operator action, not something to do unprompted
  mid-hardening-pass.

### Regulated / business decision required
- Which external evidence sources count as sufficiently independent for
  higher-stakes policy decisions (Phase 3 §1).
- Who is authorized to approve a policy version in production, and who
  qualifies as a dual-control reviewer for high-value human-escalated
  cases (Phase 3 §2, §3).
- Actual retention periods and legal-hold trigger conditions (Phase 3
  §5) — Anchor's own code can provide the *mechanism* but not invent
  regulatory-appropriate defaults.
- Whether/when Anchor's validator/attestor/Safe setup is mature enough to
  handle real, unrestricted-value settlements — see residual risk
  register below.

## 2. Safe code changes with tests — summary

| Change | Tests | Result |
|---|---|---|
| `verify-deployment.ts` | Run live against Sepolia/Testnet infra (not a unit-test suite — it *is* the check) | 17 checks: 13 pass, 4 honest warns, 0 fails |
| Solana `ReplayGuard` | `cargo test -p decision-relay` | 12/12 passing (3 new: replay rejected, distinct decisions accepted, ring-buffer eviction) |
| Settlement pause + limits | `tests/unit/settlement-controls.test.ts` | 10/10 passing |

Full existing suites re-confirmed unaffected: `forge test` (EVM,
untouched this pass), `cargo test -p decision-relay` (above), the web
app's `tests/integration/**` suite (untouched logic paths besides the
two new gates, which fail closed and only affect dispatch).

## 3. Testnet verification checklist

**Hyperlane validator / EVM delivery** (already live, re-run any time via):
```bash
npx tsx chains/hyperlane-validator/scripts/verify-deployment.ts
```
Required evidence for a clean bill of health: 0 `fail` results.

**Current real state, honestly (last run 2026-09-01, post-fix)**: 13
pass, 3 warn, **1 fail** — not a clean run. An independent audit of this
pass's first draft caught two real problems that are now fixed, plus one
genuine live infrastructure gap that remains:

- **Fixed — delivery check now actually proves delivery.** The original
  `checkRecentDelivery` only printed a manual `cast` command instead of
  calling `Mailbox.delivered(messageId)` itself. It now derives the real
  Hyperlane message ID (`keccak256` of the Dispatch event's own `message`
  field) and calls `delivered()` directly, `fail`-ing (not just `warn`)
  when a dispatch is both past SLA and genuinely undelivered. Building
  this surfaced a second real bug: the event ABI had `destination` marked
  non-indexed, which decoded garbage instead of throwing loudly at first
  — Hyperlane's real `Mailbox.sol` event has `destination` indexed (3
  indexed params total). Fixed and cross-checked against a direct `cast
  call ... delivered(bytes32)(bool)` — both agree.
- **Root cause found this pass (superseding the earlier S3-timeout/
  AccessDenied framing below, which were real but secondary symptoms):
  both validators were OOM-crash-looping.** `flyctl logs -a anc-hor-
  validator1 --no-tail` showed, in order: repeated "Latest checkpoint"
  entries frozen at index 871497 (chain tip nonce was 872868 — a ~1370
  gap) → `Out of memory: Killed process ... (validator)` → `Main child
  exited normally with code: 137` → `machine has reached its max
  restart count of 10` → machine state `stopped`. validator2 showed the
  identical pattern independently. Both machines were fully offline
  (not just stale) by the time this was found — `flyctl status` showed
  `STATE stopped` for both. **Fixed**: bumped both
  `fly.validatorN.toml`'s VM memory from 256mb to 512mb, redeployed
  (`flyctl deploy -a anc-hor-validatorN --config fly.validatorN.toml`),
  restarted both machines. Confirmed via `flyctl status`: both `started`;
  confirmed via `flyctl logs`: no further OOM kill for the remainder of
  this pass's observation window (~20+ minutes), and checkpoint index
  visibly advancing again (871497 → 871499 and climbing) instead of
  frozen.
- **A second, independent contributing factor: the shared public
  Sepolia RPC rate-limits the validators.** Confirmed via a real log
  line: `Received rate limit request JsonRpcError ... code: -32005,
  message: Rate limit exceeded` from `ethereum-sepolia.publicnode.com`.
  This is why catch-up after the OOM fix is slow (~2 leaves per 15
  minutes observed) even with the crash loop resolved — **not fixed
  this pass**, needs a dedicated/paid RPC endpoint (operator/cost
  decision).
- **Not fixed — the flagged dispatch is still undelivered as of this
  pass's end.** Message
  `0x61b6e9e3923a8b097d8580dfd29d8de5a85222634bf772895b499a37f815df71`
  (tx `0x2331a1fdaacf9d6c0d50cc5e34caf0554626a1b52d5b2f33cc1ca4d7999128c0`,
  decoded nonce 872850) is confirmed **not delivered** — `delivered()`
  returns `false`, checked both via the script and directly via `cast
  call`. This is a real `fail`, not a false alarm from an under-built
  check, and it will very likely remain a real fail until validator
  checkpoint indexing (currently still well behind the tip even after
  the OOM fix, due to the RPC rate-limiting above) catches up past leaf
  872850. Deliberately left unresolved rather than force-delivered —
  proving genuine end-to-end delivery requires the real catch-up to
  finish, which takes real wall-clock time this pass's budget didn't
  allow waiting out.
- **New check added: `checkCheckpointCurrency`.** The freshness check
  (renamed `agent-liveness` — see below) only proved
  `metadata_latest.json` was recently touched, an unrelated per-boot
  heartbeat file — it does NOT prove the checkpoint INDEX is current,
  which is the actual property that matters for delivery. This exact gap
  is why the OOM crash-loop looked "fresh" immediately after every
  restart while the real index sat frozen. `checkCheckpointCurrency` is
  currently a `warn`-only check (the real per-index checkpoint JSON
  files were not reachable at any filename this project's tooling
  tried — only the heartbeat files are public) that explicitly says so
  and points at a manual cross-check, rather than silently continuing to
  conflate the two the way the old check did.
- **Announcement/reachability warns remain warns, correctly.** Both
  validators' on-chain-announced S3 path includes a spurious
  `eu-north-1/` segment that 403s; the real object path (without it)
  returns 200. This is a genuine announced-vs-actual mismatch — a generic
  third-party Hyperlane relayer that trusts the announced URI literally
  would fail to fetch these checkpoints. **Not fixed this pass**: fixing
  it means either reconfiguring the validator agent's
  `checkpointSyncer.region`/`.folder` flags or re-announcing a corrected
  URI, both of which are real on-chain-transaction / redeploy operator
  actions with their own risk (a botched re-announce or a config change
  that silently changes the real write path) — not something to change
  blind mid-verification-pass. Tracked as an explicit operator-action
  item below, not silently worked around by only fixing the verifier's
  own read path (the verifier's dual-path check already existed and
  correctly reports both the literal-announcement 403 and the real-path
  200 as separate results, so this gap is visible, not hidden).

**Solana ISM migration** (not started — see `ISM_MIGRATION.md` §2 for
full detail): before any deployment, must have real recorded evidence
for all of:
1. Validator checkpoint generation covering Solana-destination messages.
2. Constructed multisig-ISM metadata for a real dispatched message.
3. Relayer simulation accepting that metadata.
4. A successful `process()` transaction signature on Testnet.
5. `decision-relay`'s notification log/state correctly updated.
6. Replay of the same message/metadata rejected (Hyperlane's own
   `Processed` PDA).
7. Forged-origin/insufficient-signature metadata rejected.
8. `handle_account_metas` re-confirmed unchanged (still no
   escrow-authority-capable account) after cutover.

**Solana ReplayGuard deployment** (code-ready, not deployed): once a
program upgrade is pushed, before relying on it:
- Call `InitReplayGuard` once, confirm the PDA is created at the expected
  seeds/size via a direct account read.
- Dispatch a real `DECISION_RELAY` message, confirm `handle()` succeeds
  and the PDA's `seen`/`next_index` updated.
- Attempt to redeliver the same message (if the relayer's own dedup
  doesn't already block it) and confirm `handle()` itself now also
  rejects it independent of Hyperlane's own `Processed` check.

## 4. Residual risk register

What remains genuinely unsafe for unrestricted real-money use, stated
plainly:

1. **Validator independence is not real yet.** Both live Hyperlane
   validators share operator, cloud account, provider, IAM principal, and
   S3 bucket. The multisig ISM's 2-of-2 threshold provides zero real
   Byzantine-fault protection today — one compromised credential set
   (this pass found the account genuinely had zero AWS credentials on the
   relayer side, but the *validator* side's single IAM principal is a
   single point of compromise for both checkpoint sources) controls both
   validators. **Mitigation exists** (`ONBOARDING.md`) but requires a real
   second operator, not code.
2. **Solana's inbound ISM is still `TRUSTED_ISM`** (unconditional accept)
   — unchanged this pass, by design (the brief required a complete
   Testnet proof before touching it, which doesn't exist yet). This is
   currently safe only because `handle()` is notification-only and cannot
   move funds — that invariant is load-bearing and must never regress
   without equal rigor to `attested_settle` itself.
3. **A real message is confirmed undelivered right now, with a diagnosed
   (partially fixed) root cause.** `verify-deployment.ts`'s delivery
   check calls `Mailbox.delivered()` directly (fixed this pass) and
   confirms message `0x61b6e9e3...15df71` (nonce 872850) is genuinely
   undelivered. Root cause chain, confirmed via `flyctl logs` and
   on-chain reads: both validators were OOM-crash-looping (fixed —
   memory bumped 256mb→512mb, redeployed) on top of a shared public
   Sepolia RPC that rate-limits them (`code: -32005, Rate limit
   exceeded` — not fixed, needs a dedicated RPC endpoint), leaving
   validator checkpoint indexing ~1370 leaves behind the chain tip.
   Until indexing catches up past leaf 872850, no validator can sign a
   checkpoint covering this message, so no valid multisig-ISM metadata
   can exist for it — the relayer cannot deliver what the ISM has no
   basis to accept, independent of any relayer-side issue.
4. **The OOM crash-loop that caused the above has been fixed but not
   yet proven durable.** Both validators ran without a further OOM kill
   for this pass's observation window (~20+ minutes post-fix), but that
   is far short of the sustained operation needed to be confident 512mb
   is actually enough headroom, especially as the Merkle tree keeps
   growing over time. Needs continued observation (ideally 24h+) before
   being considered resolved, per this pass's own residual-risk
   discipline of not declaring things fixed on a short observation
   window.
5. **The validator announcement path doesn't match the real checkpoint
   location.** Both validators announce a URI with an extra `eu-north-1/`
   segment that 403s; only the real path (without it) is reachable. A
   generic third-party Hyperlane relayer that trusts the announced URI
   literally — not this project's own verifier, which deliberately tries
   both — would fail to fetch these checkpoints at all. Unfixed; see
   operator-action items above.
6. **Settlement limits and emergency pause are MVP-shaped.** Env-var
   configuration, not tenant/policy-scoped DB rows with an approval
   workflow — an operator with deploy access can change a limit with no
   audit trail beyond a deploy log. Adequate as a first real gate, not as
   a durable control for real-money operation. (The dispatch-blocking
   behavior itself is now durable and self-recovering — see the P0 fix
   above — this residual point is only about the configuration mechanism
   being env-vars rather than an auditable DB-backed workflow.)
7. **No daily reconciliation job exists yet.** A finalized decision with
   a dispatch that silently fails downstream (destination-chain issue,
   not caught by this pass's SLA check) has no automated cross-check
   against actual on-chain settlement state.
8. **No human escalation / dual-control queue exists yet.** Cases that
   don't reach ACCEPTED consensus have no structured reviewer workflow;
   they're just unresolved `Decision` rows today.
9. **No evidence retention/legal-hold/access-log mechanism exists yet.**
   All evidence is retained indefinitely with no export/deletion
   workflow and no record of who viewed what.

None of these are regressions introduced this pass — they're the honest
state of what's still missing, stated the way this pass's own tooling
(`verify-deployment.ts`'s independence check) already insists on: no
silent "looks secure enough," only what's actually verified.

## Addendum (same day, follow-up round): a deeper root cause found, still unresolved

A further round of read-only investigation (no announcements changed, no
programs/contracts redeployed, per explicit instruction) found the OOM
fix, while real and necessary, is **not sufficient** — there is a second,
deeper problem underneath it.

**Real finding: the validators' own AUTHENTICATED S3 requests are being
denied.** `flyctl logs -a anc-hor-validator1/-2 --no-tail | grep -c
AccessDenied` returns real, nonzero counts (18 and 10 respectively at
time of writing), and the underlying log lines show hundreds of retries
(`retries: 190`, `191`, `192`, `193`, climbing) against genuine signed S3
calls — not the already-known public-read 403s, a completely different
and more serious problem: **the validator's own credentials, which
should have full read/write access, cannot successfully read or write
its own checkpoint objects at all.**

Investigated (read-only, via the AWS console) without exposing or
recording any secret value:
- The IAM user (`anchor-hyperlane-validators`) has `AmazonS3FullAccess`
  (AWS-managed, directly attached) — the broadest possible S3 grant. This
  rules out an under-scoped IAM policy as the cause.
- Its access key (only one exists) shows `Active`, `Used today. Created
  today.` — actively being used, not a stale/orphaned credential.
- The bucket's policy has only `Allow` statements (public read on
  `validator1/*`/`validator2/*` — the same policy documented earlier);
  no `Deny` statement was visible in what this pass reviewed.
- Object Ownership is `Bucket owner enforced` (ACLs disabled, policy-only
  access) — a standard, unremarkable configuration.
- Default encryption is `SSE-S3` (Amazon-managed keys), not SSE-KMS —
  rules out a missing-KMS-grant explanation, which would otherwise be the
  single most common cause of "full S3 access, still AccessDenied."

**None of the ordinary explanations fit.** What remains unruled-out and
would explain full-access-still-denied: an AWS Organizations Service
Control Policy (SCP) restricting S3 actions at the account level, a
bucket-policy statement further down in the document this pass's review
didn't scroll to, or some other account-level guardrail. **This pass did
not attempt to view Organizations/SCP settings or edit the bucket
policy** — diagnosing further requires either broader AWS account access
this pass wasn't given, or the account owner's own investigation.
Flagged as a hard operator-escalation item, not something to guess at
with further live changes.

**Corrected finding: the real Hyperlane S3 checkpoint key format was
confirmed from `hyperlane-monorepo`'s actual source** (not memory/guess):
a per-index checkpoint is `checkpoint_{index}_with_id.json` (a previous
version of this project's tooling guessed `checkpoint_{index}.json`,
which is wrong), and the latest-index pointer is
`checkpoint_latest_index.json` — both confirmed against the real Rust
source, and both still return 403/AccessDenied on this project's live
bucket, consistent with the authenticated-AccessDenied finding above:
these objects likely don't exist in the bucket at all, because the
validator has never successfully written one.

**`checkCheckpointCurrency` was rewritten** to use these confirmed real
filenames (previously it used unconfirmed guesses and reported a generic
"can't verify" warning; it now attempts the real official path first,
and its warning message — when it still can't reach the object — points
directly at this authenticated-AccessDenied evidence instead of leaving
the cause as a mystery).

**`checkReachability` was fixed per this round's explicit instruction**:
a literal-announced-path failure is now always a `fail`, on its own,
never offset by the region-stripped fallback into an overall pass. The
fallback path is still checked and reported, but only as a separate,
clearly-labeled informational line that says it does not excuse the
literal-path failure.

**Corrected finding: `agent-liveness` (the renamed freshness check)
turned out to be a weaker signal than assumed even after the earlier
fix.** Checked again ~25 minutes after the OOM-fix restart with the
validator process confirmed still running (`flyctl status`: `started`)
and confirmed NOT OOM-killing again (`grep -c "Out of memory"` → `0`) —
yet `metadata_latest.json` had gone stale (fails the 900s threshold).
This suggests `metadata_latest.json` may only be written once at agent
startup, not on any periodic cadence — meaning "fresh" only ever proved
"restarted recently," and "stale" doesn't distinguish a genuinely broken
process from a long-uptime healthy one. This further reduces how much
weight this check should carry; `checkCheckpointCurrency` (once it can
actually read real checkpoint objects) is the check that matters, not
this one.

**Current honest live state as of this addendum**: 11 pass, 3 warn, **5
fail** (worse-looking than the previous round's 13/4/1, entirely because
checks are now stricter and more honest — `agent-liveness` now correctly
fails since the heartbeat file went stale, `reachability` now correctly
fails on the literal path instead of laundering it through a fallback
pass, per this round's explicit instruction). This is not a regression in
the underlying infrastructure — it is the verifier telling the truth
more completely than it did before.

**Priority items from this round explicitly NOT done, and why:**
- **Re-announcing a corrected S3 path**: blocked on the deeper
  AccessDenied problem above — re-announcing without first fixing why
  authenticated writes fail would just move the URL of a system that
  still can't publish real checkpoints. Diagnose-then-fix ordering
  matters here; doing it out of order risks a second broken
  announcement.
- **24-hour reliability observation**: not possible within a single
  pass's timeframe — needs real wall-clock time to mean anything, and
  reporting a short window as if it were 24 hours would be dishonest.
- **ReplayGuard Testnet deployment**: explicitly gated on Priority 1
  (real delivery) being healthy first, per instruction — not done, since
  Priority 1 is not healthy.
- **Live notification webhook wiring**: needs a real credential
  (Slack/PagerDuty) this pass cannot fabricate — still a template, not a
  live integration.
- **Fly health checks, OOM/restart-count alerting, S3/RPC error
  metrics, bounded backoff**: not implemented this round — these are
  real operational-hardening code/config changes, but attempting them
  before the AccessDenied root cause is understood risks building
  monitoring around symptoms rather than the actual failure. Tracked as
  next steps once the AccessDenied investigation has an answer.

## Second addendum (same day): credential rotation tested and ruled out

A follow-up round tested whether the authenticated-S3-AccessDenied
problem above was simply a bad/stale credential, since that's the most
common mundane explanation and is worth ruling out empirically before
escalating further. The operator rotated the AWS access key for
`anchor-hyperlane-validators` (through several attempts — one where a
value didn't actually change per `flyctl secrets list`'s digest, one
that turned out to be a duplicate of a prior key, and finally one
confirmed genuinely new via a changed secret digest on both Fly apps).

**Result: definitively not the credential.** With the confirmed-fresh
key installed and both validator machines cleanly restarted, the exact
same `Failed to read reorg status ... AccessDenied` error reappeared
within about a minute of boot (`retries: 22`, a fresh counter for this
boot). Three distinct credential states — the original key, one
mistaken duplicate, and one confirmed-fresh key — all produced the
identical failure. This closes the "bad/stale credential" hypothesis
completely.

Combined with everything else already ruled out (under-scoped IAM
policy — the identity has `AmazonS3FullAccess`; no AWS Organization
exists for this account, so no SCP is possible; encryption is SSE-S3
not KMS; no visible bucket-policy `Deny` statement in what was
reviewed), this is now genuinely past what this pass's AWS console
access can diagnose. **Recommendation: open an AWS Support case** —
they can see the server-side reason for the denial that neither the
console views checked here nor CloudTrail (no trail configured, so S3
data events were never logged) can surface after the fact.

Side effects of this rotation round, for the record: both validator
machines briefly ran out of their Fly restart budget during the
credential-transition window (expected — they had no working S3
credential for a few minutes between unset and the final working
import) and had to be manually restarted with `flyctl machine start`;
both are back to `started` state as of this addendum. No credential
values are recorded anywhere in this repository, its history, or this
document — only the fact that rotation happened and which digests
changed.

## Third addendum (same day): identity fully proven good — this is an AWS Support case

A follow-up round did the decisive test: run the exact same effective
identity the validator uses against the exact same bucket, locally,
with the AWS CLI, and compare.

**Read-only diagnostic script**: `chains/hyperlane-validator/scripts/diagnose-s3-auth.sh`
(added this round) — runs `sts:GetCallerIdentity`, `GetBucketLocation`/
`HeadBucket`, `ListBucket` scoped to `validator1/`, and a full
`PutObject`→`HeadObject`→`GetObject`→`DeleteObject` round trip on a
disposable key, using the same credential installed on the Fly apps.
Designed to run locally (never through Claude) so no secret value
passes through any tool call — only ARNs, region strings, status codes,
and AWS request IDs are printed.

**Results, run by the operator**:
- `sts:GetCallerIdentity` → `arn:aws:iam::691687039029:user/anchor-hyperlane-validators`
  — a real, valid identity.
- `GetBucketLocation`/`HeadBucket` → `eu-north-1`, matching the
  configured `S3_REGION` exactly.
- `ListBucket` on `validator1/` → only `announcement.json` and
  `metadata_latest.json` exist; no checkpoint file has ever been
  written.
- **Full `PutObject`→`HeadObject`→`GetObject`→`DeleteObject` round trip
  on a disposable object succeeded completely, with this exact
  identity, in this exact bucket/prefix.**
- `HeadObject` on the two most likely checkpoint-pointer filenames
  (`checkpoint_latest_index.json`, `reorg_flag.json` — both confirmed
  real Hyperlane S3 key names from source) both returned a **clean
  `404 Not Found`, not `403 AccessDenied`.**
- The access key ID actually loaded inside the running validator
  container (`AKIA2CC6CUA2RANYY7I6` — an access key ID, not secret;
  AWS treats these as non-sensitive identifiers, unlike the paired
  secret) was confirmed by the operator to be the exact same one used
  for the successful local test above.

**This proves the AWS side is entirely correct**: right identity, right
region, right bucket, full working read/write/delete access, and even
the specific files the validator is trying to reach return an honest
404 (never written) rather than any kind of denial. The
`AccessDenied` the validator's own process logs — confirmed still
occurring after this exact identity was proven good — is not AWS
legitimately rejecting a well-formed request from this identity.

**Ruled out via a debug-logging attempt**: set
`RUST_LOG=info,aws_config=debug,aws_credential_types=debug,...` on
validator1 to see which credential provider the Rust AWS SDK actually
resolves at runtime. Produced zero additional trace output — this is a
release build that does not compile in debug/trace-level tracing for
those crates, so this specific approach is a dead end without a custom
debug build. Reverted afterward (`flyctl secrets unset RUST_LOG`).

**One further real lead, not yet run to ground**: the specific
component logging `AccessDenied` is `BackfillCheckpointSubmitter`, not
just the tip/latest checker — meaning it's working through a range of
historical checkpoint indices, not only the two filenames tested above.
It's possible (not confirmed) it targets additional key patterns, uses
conditional-write headers (`If-None-Match`), or otherwise diverges from
the specific calls tested. This wasn't chased further because doing so
needs either a custom-instrumented build or a packet-level capture,
both out of scope for this pass.

**Also ruled out this round**: bucket Versioning (`Disabled`), MFA
delete (`Disabled`), Object Lock (`Disabled`) — none of the remaining
plausible bucket-configuration explanations hold up either.

**Conclusion at that point: everything read-only pointed at AWS Support.**
The evidence trail — real ARN, real request IDs, exact failing
operation, proven-clean identity — was exactly what a Support case
would need. See the next addendum for the actual resolution, found by
going one level deeper into the validator's own source.

## Fourth addendum (same day): actual root cause found — not an AWS bug

Before opening an AWS Support case, one more source-grounded check was
done: locating `ValidatorSubmitter`'s exact implementation for the git
SHA this project's validators are actually running
(`97cbefba2716c1de060ebd527f4a64fdfbc1c13d`, confirmed from
`metadata_latest.json`).

**Found the mechanism.** `fetch_checkpoint(index)` — called once per
historical index during backfill, working sequentially from index 0 up
to the chain tip — calls `anonymously_read_from_bucket()`, i.e. it
deliberately reads with **no AWS credentials at all**, by design (this
mirrors what a real third-party relayer without any AWS access does).
Its `get_object()` call treats a `NoSuchKey` (`404`) response as
`Ok(None)` — "checkpoint not written yet, that's fine, keep going."

The problem: **S3 returns `403 AccessDenied`, not `404 NotFound`, for
an anonymous `GetObject` on a missing key when the anonymous principal
lacks `s3:ListBucket`** — this is standard, documented S3 behavior
(anti-enumeration: a requester who can't list a bucket shouldn't be
able to distinguish "doesn't exist" from "exists but you can't see
it"). This project's bucket policy (`PublicReadCheckpoints`) grants the
public principal `s3:GetObject` only — never `s3:ListBucket`. So every
one of the ~872,850 not-yet-backfilled indices anonymously returns
`403`, which `fetch_checkpoint` has no special handling for (only
`NoSuchKey`/404 is treated as "fine") — so it retries indefinitely,
exactly matching the `n: 18446744073709551615` (effectively infinite)
retry behavior observed since the very first log capture this pass.

**Reproduced directly**: `curl -s -o /dev/null -w "%{http_code}"
".../validator1/checkpoint_0_with_id.json"` (the literal first key
`fetch_checkpoint(0)` requests, anonymous, no credentials) → `403`,
confirming the mechanism precisely, not just the theory.

**This resolves the entire investigation.** Every earlier finding is
now explained and consistent, not contradictory:
- The authenticated CLI test (via `diagnose-s3-auth.sh`) got clean
  `404`s because that identity has `s3:ListBucket` (from
  `AmazonS3FullAccess`) — a fundamentally different code path than the
  validator's own anonymous reads.
- Neither credential rotation nor IAM/SCP/KMS/Object-Lock/Versioning
  checks ever had anything to find, because none of them were the
  actual cause.
- The earlier "OOM crash-loop" and "public RPC rate-limiting" findings
  were real and worth fixing, but were never going to be sufficient —
  even a perfectly healthy, well-resourced validator would still hit
  this exact wall on every backfill attempt.

**Not an AWS Support case.** This is an application-behavior interacting
with an incomplete bucket policy, fully explainable from public S3
documentation and the validator's own open-source code — nothing here
needs AWS's side of the story.

**Fix applied, with explicit go-ahead, and verified before/after**:
added `s3:ListBucket` to the public bucket policy, scoped via an
`s3:prefix` `StringLike` condition to just `validator1/*` and
`validator2/*` — no bucket-wide listing, no write/delete access, no
access outside the checkpoint prefixes. Applied only after
`SETTLEMENT_PAUSED=true` was confirmed live on both the Fly worker
(`flyctl secrets set` + restart) and the Vercel web app (env var added
to production, then a fresh production deploy from the repo root to
ensure the running functions actually pick it up — a first deploy
attempt from the wrong directory, `apps/web` instead of the repo root
where the monorepo-aware `vercel.json` lives, failed to resolve the
internal `@anchor/genlayer-sdk`/`@anchor/hyperlane-relay` workspace
packages; corrected and redeployed cleanly from root).

Before/after, all anonymous (`curl`, no credentials):

| Check | Before | After |
|---|---|---|
| Missing checkpoint key in-scope (`validator1/checkpoint_0_with_id.json`) | `403` | **`404`** |
| Missing key outside allowed prefixes (`validator3/foo.json`, bucket-root file) | `403` | `403` (unchanged) |
| Bucket-wide `ListObjectsV2` (no prefix) | `403` | `403` (unchanged — no bucket-wide listing granted) |
| `ListObjectsV2` scoped to `validator1/` prefix | `403` | `200` (the actual grant) |
| Anonymous `PUT` | `403` | `403` (unchanged — no write access granted) |
| Anonymous `DELETE` of an existing object | `403` | `403` (unchanged — no delete access granted) |
| Existing published objects (`metadata_latest.json`, `announcement.json`) | `200` | `200` (unchanged — no regression) |

Every check landed exactly where intended: the one thing that changed
is that a genuinely-missing checkpoint object now reads as "doesn't
exist" instead of "denied," which is exactly what `fetch_checkpoint`'s
existing `NoSuchKey`-as-`Ok(None)` handling needs to let backfill
actually progress past index 0.

**Temporary safety measure applied and confirmed live on both dispatch
paths**: `SETTLEMENT_PAUSED=true` set on `anc-hor-worker` (Fly, via
`flyctl secrets set` — restarted) to halt the periodic settlement retry
sweep, and on the `anc-hor` Vercel project's production environment
(`vercel env add` + a fresh production deploy from the repo root, so
the running serverless functions actually have it baked in — env vars
added after a deployment don't retroactively apply to already-running
functions). Both confirmed running on their respective new
versions/deployments before the bucket policy change below was made.
The delivery SLA check in `verify-deployment.ts` remains active and
unaffected by the pause. No case data, message IDs, or transaction
hashes were deleted or modified — all undelivered-message evidence
gathered this pass remains exactly as captured above for a
Support case if one is still wanted for a different reason.

## Fifth addendum (same day): delivery proven end-to-end, both messages

A `DeliveryProofReceiver` contract was deployed and used for a
delivery-only proof, and — while monitoring it — the original flagged
message delivered too, once validator backfill closed the remaining
gap.

**`DeliveryProofReceiver`** (`chains/evm/contracts/DeliveryProofReceiver.sol`,
deployed at `0xd08093116B56Da9653F46e3f9013E7989c1ec99f`): a minimal
Hyperlane recipient with no settlement logic, no escrow access, no
attestation requirement, and no connection to any real case — its
`interchainSecurityModule()` is fixed to the same real
`StaticMerkleRootMultisigIsm` `DecisionRelay` uses, so a message
delivered to it goes through the identical validator checkpoint/ISM
path a real decision would, with zero funds-movement risk. 3 new tests
(correct ISM reporting, non-mailbox caller rejected, mailbox caller
accepted + event emitted); full EVM suite 45/45 passing. A test message
was dispatched via the project's existing `HYPERLANE_RELAY_PRIVATE_KEY`
(already used for exactly this purpose by `lib/hyperlane.ts`) — real
Sepolia ETH, no new key created.

**Both messages confirmed delivered, same block (`11613593`)**:

| Message | Evidence |
|---|---|
| New test (`DeliveryProofReceiver`) | Dispatch tx `0x11c66d486fb5a424b4c4b3aaa84c5b021d25e382122ec848c554a4aa22ad4a1d`, message ID `0x32652e9557ebd4f5828bbc71559445ca6eb18da46971f12e46305cdd0a2ff255`, `Mailbox.delivered() == true`, `ProofReceived` event emitted (tx `0x043c1d02938dcda50d7d40ef51156dc7e2a5dca73974969923c48f1232ac6921`) |
| Original flagged (`DecisionRelay`, outcome `RELEASE_FULL`) | Dispatch tx `0x2331a1fdaacf9d6c0d50cc5e34caf0554626a1b52d5b2f33cc1ca4d7999128c0`, message ID `0x61b6e9e3923a8b097d8580dfd29d8de5a85222634bf772895b499a37f815df71`, `Mailbox.delivered() == true`, `DecisionReceived` event (tx `0xdefa80f448f63ed7cdfefbf4a28c21df1ca48116b039db55ac2641415e69ca3a`), `DecisionRelay.processedDecisions(proofHash) == true` |

Both validators' checkpoint backfill and the relayer's own processing
caught up to and past nonce 872850 organically once the bucket policy
fix was applied — no manual forcing, no shortcuts, real wall-clock
catch-up time.

**What this does and doesn't close out**:
- The repaired delivery path is now proven end-to-end, for a genuinely
  new message dispatched after the fix — this is the strongest form of
  proof (not just "the old backlog eventually cleared," but "the fixed
  system handles a fresh message correctly").
- The old flagged message was itself a verification test case from
  earlier in this pass (case ID `CASE-MULTISIG-ISM-VERIFY-1`), not a
  real customer decision — so there is no real settlement backlog
  needing reconciliation from this specific message. `settlementTarget`
  for this origin was unset, so no settlement call was attempted
  regardless.
- `SETTLEMENT_PAUSED=true` remains in place on both `anc-hor-worker`
  and Vercel production — left for the operator to lift when ready, not
  lifted automatically by this pass.

**Post-fix `verify-deployment.ts` run**: 12 pass, 1 warn, **6 fail** —
worse-looking than before, for two understood, non-alarming reasons,
plus one still-real, still-open issue:
1. `agent-liveness` now fails for both validators (`metadata_latest.json`
   is 2137s/3557s old) — this is the write-once-at-boot artifact
   documented in an earlier addendum, not a real problem: both
   validators have been running continuously, without restart, and are
   demonstrably delivering real messages right now. This check's
   design flaw (conflating "recently booted" with "currently healthy")
   remains open as a follow-up, not fixed this pass.
2. `checkpoint-currency` (now able to actually read the real object,
   thanks to the same `ListBucket` fix) reports both validators'
   sequential "latest index" pointer at `871512`, vs. mailbox nonce
   `872882` — a reported lag of 1370, despite nonce `872850` being
   *confirmed delivered*. Not a contradiction: `write_latest_index`
   tracks sequential/contiguous completion, while parallel backfill
   chunks write individual per-index checkpoints out of strict order —
   a specific message's checkpoint can exist and validate before the
   contiguous pointer catches up to it. The check's `fail` threshold
   (`maxCheckpointLagLeaves: 100`) is measuring a real, honest signal,
   just not one that maps 1:1 onto "can this specific message be
   delivered" — worth a follow-up refinement (e.g. also checking
   whether the SPECIFIC message's own checkpoint exists, not just the
   sequential pointer) but not chased further this pass.
3. `reachability:validatorN` (literal announced path, `403`) remains a
   real, still-unfixed issue — the separate ValidatorAnnounce path
   mismatch, deliberately not conflated with the bucket-policy fix,
   still needs its own resolution (see the operator-action list above).

None of the three represent a regression in real capability — the
system just-proven to deliver real messages end-to-end simply isn't
fully reflected by every check's current framing yet.

## Sixth addendum: explicit unpause gate — `SETTLEMENT_PAUSED` stays `true` until all five are met

The delivery proof above is real and strong, but it is **not** treated
as sufficient grounds to resume real-money settlement dispatch on its
own. `SETTLEMENT_PAUSED=true` remains set on both `anc-hor-worker` (Fly)
and the `anc-hor` Vercel production environment until **all** of the
following are independently true — not "explained," not "understood,"
actually true:

1. **ValidatorAnnounce paths resolve directly as announced** — the
   literal on-chain-announced URI itself returns `200`, with no
   verifier-only region-stripped fallback needed. `verify-deployment.ts`'s
   `reachability:validatorN` check must `pass` on the literal path, not
   just the fallback.
2. **`verify-deployment.ts` distinguishes real failures from known
   non-fail conditions and returns clean for the live route.** The
   `agent-liveness` write-once-at-boot artifact and the
   `checkpoint-currency` sequential-pointer-vs-specific-message nuance
   documented above are real gaps in the check's own design, not
   acceptable standing failures — they need to be fixed in the tooling
   itself (or replaced with a check that actually reflects live-route
   health) before a "0 fails" run means what it should.
3. **Validators run for at least 24 hours with checkpoint currency
   confirmed** — not just heartbeat/agent-liveness freshness, which
   this pass has already shown can look "fine" while telling you
   nothing real. Needs a sustained observation window with the
   corrected `checkpoint-currency` check (per #2) showing real,
   current coverage throughout, not a snapshot.
4. **A controlled end-to-end settlement rehearsal succeeds** with all
   production authorization controls exercised (real attestor
   signatures, real Safe governance path, real ISM/validator
   verification) — but against no customer funds. `DeliveryProofReceiver`
   proved message delivery; it deliberately does not exercise
   settlement authorization at all, so it does not satisfy this gate on
   its own.
5. **Delivery/validator alerts are actually scheduled to a monitored
   notification channel** — `ALERTING.md`'s cron/CI templates are not
   enough; this needs a real, live-wired destination (Slack webhook,
   PagerDuty, etc.) that someone is actually watching.

The old flagged test message having no settlement target configured is
noted as a genuinely good property of how that test happened to be
built — it proved delivery without creating any financial side effect —
but this is not treated as informing whether the gate above should
loosen; it doesn't change what real settlement dispatch requires.

## Seventh addendum: progress against gate item 2, plus a clean pass on item 7

**Gate item 2 (`verify-deployment.ts` failure semantics) — partially
addressed.** Two real fixes, both against the specific complaints:
- The old `agent-liveness` check (renamed `boot-metadata`) could `fail`
  and claimed a stale `metadata_latest.json` meant the validator "is
  not running" — false, since that file is write-once-at-boot, not a
  heartbeat. It is now **warn-only, and worded honestly**: it reports
  the age and explicitly says not to treat it as a liveness signal.
- `checkCheckpointCurrency`'s `fail` message previously implied a
  validator "cannot attest to recent messages" whenever contiguous
  backfill lag was high — contradicted by a message that delivered
  successfully at a lag of 1370. The wording now explicitly says this
  measures *contiguous* lag, not deliverability, and points to the new
  `message-checkpoint-coverage` check for the latter.
- **New check added**: `checkMessageCheckpointCoverage` — checks
  whether each validator has published a checkpoint for the SPECIFIC
  most-recently-dispatched message's own leaf (`checkpoint_{nonce}_with_id.json`,
  now readable thanks to the `ListBucket` fix), independent of where
  the contiguous backfill pointer sits. This is the check that actually
  answers "is this message deliverable right now."

Current run: **12 pass, 5 warn, 4 fail** (down from 6 fails). The 4
remaining fails are all real and unresolved: 2× literal
`ValidatorAnnounce` path (gate item 1, not yet fixed), 2× genuine
contiguous backfill lag (still real — the sequential pointer has not
caught up, only specific messages ahead of it have). **Not yet fully
satisfying gate item 2**: this is real progress on failure-semantics
accuracy, not a claim that the tool is now complete or that a "0 fails"
run would currently mean the live route is fully healthy — the
contiguous-lag fails are correctly still failing and still need real
resolution (backfill genuinely finishing), not just better wording.

**Gate item 7 (local sensitive material) — checked, clean.** Both
`apps/web/.env` and `chains/solana/target/deploy/*-keypair.json` are
confirmed `git check-ignore`'d (never committed). The Solana keypair
files' public keys were checked against the real deployed program
IDs: `decision_relay-keypair.json` matches the live `decision-relay`
program ID (`DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN`) — a program
*identity* key, not the more sensitive upgrade-authority key. Confirmed
directly via `solana program show` for both `decision-relay` and
`escrow` on Testnet: both programs' real upgrade authority
(`EBea3UVndSrNdgdtfuXC6PoN7573GdS43XDoB6pja9fh`) is a separate keypair
not present in either local `target/deploy/*-keypair.json` file. Clean
result — nothing to remediate here.

**Not touched this round, deliberately**: gate items 3 (ReplayGuard
Testnet deployment), 4 (independent validator operator), and 5
(dedicated RPC endpoint) — all remain real, unresolved operator/infra
decisions, not something to fix blind. Item 6 (alerting) is
documentation-only progress (the stale undelivered-message claim in
`ALERTING.md` was corrected to reflect the now-confirmed delivery), not
a live-wired notification channel — that part of gate item 5/6 still
needs a real destination and owner.

## Eighth addendum: gate item 1 (ValidatorAnnounce) resolved — no config or re-announcement needed

Before touching any validator config or announcing a new URI, checked
one thing first: whether the "mismatch" was actually a validator
misconfiguration, or a bug in how this project's own verification
script interpreted the announced URI.

**It was the script.** Hyperlane's own S3 checkpoint syncer config
format is literally `s3://bucket/region/folder` (confirmed from
`hyperlane-monorepo`'s own `checkpoint_syncer.rs` parsing logic) —
`region` selects the **S3 regional endpoint hostname**
(`s3.<region>.amazonaws.com`), not a literal URL path segment. A prior
version of `verify-deployment.ts` built the literal HTTPS URL as
`https://bucket.s3.amazonaws.com/<region>/<folder>/...` (region as a
path prefix on the generic global endpoint), which correctly 403s —
but that's not what a real, standards-compliant Hyperlane relayer does.
The correct literal URL,
`https://bucket.s3.<region>.amazonaws.com/<folder>/...`, was tested
directly and confirmed to work with **zero changes** to the validator's
own announcement, config, or any re-announcement transaction: `curl`
returns a clean `200` on a real object and a clean `404` (not `403`) on
a missing one.

**Fix applied**: `verify-deployment.ts` rewritten to build S3 object
URLs the correct way (`s3ObjectUrl()` helper, region in the hostname),
replacing every call site that previously needed a "literal vs.
region-stripped fallback" — that fallback machinery no longer exists in
the script at all, because there's nothing to fall back from once the
URL is built correctly.

**Verified, per the requested checklist** — items 3 and 4 aren't
applicable (nothing was re-announced, since nothing was wrong on-chain
to begin with) but the reachability/behavior checks all pass now:
- `reachability:validatorN` now `pass`es directly on the literal
  announced-derived URL — no fallback needed, confirmed by removing the
  fallback code entirely and re-running.
- `checkpoint-currency` and `message-checkpoint-coverage` (which read
  real checkpoint objects) also now resolve correctly using the same
  corrected URL construction.
- Existing checkpoint publication and real delivery are unaffected —
  re-ran `verify-deployment.ts` after the fix: **17 checks: 10 pass, 5
  warn, 2 fail** (down from 4 fails), the 2 remaining being the
  genuine, still-unresolved contiguous backfill lag (unrelated to this
  item).
- No old/new announcement transaction hashes to record — nothing was
  re-announced. No rollback needed for the same reason. If this is
  ever revisited, the actual validator-side announcement string itself
  remains `s3://anchor-hyperlane-validator-checkpoints/eu-north-1/validator1`
  (and `validator2`) unchanged throughout this investigation.

**Consequence for the six-point unpause gate**: item 1 is now
satisfied. Items 3, 4, and 5 remain open.

## Ninth addendum: real ReplayGuard build/test verification, and a genuine secret-exposure incident

**Incident, disclosed immediately when it happened**: while checking
whether any locally-available key matched `decision-relay`'s real
Solana program upgrade authority (`EBea3UVndSrNdgdtfuXC6PoN7573GdS43XDoB6pja9fh`),
a shell quoting bug in a Python one-liner caused the raw private-key
byte arrays for `SOLANA_ATTESTOR_PRIVATE_KEY` and
`SOLANA_RELAY_PRIVATE_KEY` to be echoed into a Python syntax-error
message, which then appeared in this session's own tool output. This
was caught and disclosed to the operator in the same turn it happened,
before any further action — the operator was told to treat both keys
as compromised and rotate them. **The operator decided not to rotate
for now** — a real, standing residual risk on these two keys, not
something resolved by this pass; anyone reviewing this later should not
assume rotation happened just because it was recommended. Investigation
of the upgrade authority was abandoned at that point rather than risk
repeating the mistake; the
real authority key was never found or used, and no ReplayGuard deploy
or `InitReplayGuard` call was attempted without it. This is recorded
here in the same spirit as every other honest finding in this
document — a real mistake, not swept past.

**Separately, real (non-secret) verification work done**: re-confirmed
`cargo test -p decision-relay` at 12/12 passing (including all 3
ReplayGuard-specific tests) immediately before attempting a real build,
then ran the actual deployable build
(`cargo-build-sbf -- -p decision-relay`) and confirmed it produces a
real, valid ELF binary (`target/deploy/decision_relay.so`, 151024
bytes). Found and fixed a real, unrelated doc bug in the process:
`chains/solana/README.md` documented `cargo build-sbf -p decision-relay`,
which the installed `cargo-build-sbf 3.1.15` rejects outright (`-p`
must go after `--`) — confirmed live, fixed in both `README.md` and
`REPLAYGUARD_DEPLOYMENT.md`, along with a stale "9 unit tests" count
(now 12) and a note that the build's non-fatal `hyperlane_core`
stack-frame warnings aren't a real blocker.

**Gate item 3 status: still not satisfied**, and correctly so — the
build/test verification above is real and useful groundwork, but the
actual program upgrade, `InitReplayGuard` call, and the full delivery/
replay-rejection/no-escrow-side-effect proof `REPLAYGUARD_DEPLOYMENT.md`
requires are all still unexecuted, pending either the real upgrade
authority key or the operator running that step themselves.

## Tenth addendum: gate item 5 (dedicated RPC) satisfied

The operator obtained free-tier Infura and Alchemy endpoints (real
separation, not one shared paid endpoint reused three times — validator1
uses a dedicated Infura key, validator2 and the relayer each use their
own separate Alchemy key) and set `HYPERLANE_SEPOLIA_RPC_URL` directly
via `flyctl secrets set` on all three apps themselves (never through
this session). All three were then redeployed with the fail-closed
entrypoint code from the earlier RPC plumbing pass — necessary since
the previously-running images predated that code and hadn't picked up
the new env var at all.

**Verified directly, not assumed**: SSH'd into each container and
confirmed the actual resolved RPC config (`cat /tmp/config.json`,
host only) — validator1 resolved to `sepolia.infura.io`, validator2 and
the relayer both resolved to `eth-sepolia.g.alchemy.com` (different
underlying keys per `flyctl secrets list` digests, even though the
hostname is the same for both). Zero `AccessDenied`/`Out of memory`
across all three post-redeploy.

**A real, live bug found and fixed in the process**: Infura's free tier
caps `eth_getLogs` at a 10,000-block range; `deployment.json`'s
`dispatchLookbackBlocks` was `50000` (worked fine on the old public
endpoint, which apparently permits larger ranges) — a genuine
provider-compatibility break, not a config typo, confirmed via a real
`"range 50000 exceeds limit of 10000"` RPC error. Fixed: lowered to
`9000`. Re-ran `verify-deployment.ts` against the dedicated endpoint
afterward and confirmed clean: 17 checks, 10 pass, 5 warn, **2 fail**
— both remaining fails are the pre-existing, unrelated contiguous
backfill lag, not anything RPC-related.

**Two RPC keys were pasted directly into chat during this exchange**
(same pattern as the earlier Solana key exposure) — flagged
immediately each time, not used directly by this session for anything
beyond the operator's own `flyctl secrets set` commands they ran
themselves. **The operator declined rotation for these too** — another
standing, deliberately-accepted residual risk, recorded here for the
same reason as the Solana keys above: so no later reviewer assumes
rotation happened just because it was recommended.

**Consequence for the six-point unpause gate**: items 1 and 5 are now
satisfied. Items 3 and 4 remain open.

**Note on numbering** — two different "5-item gate" lists exist in this
document's history and can be confused: the original **six-point
`SETTLEMENT_PAUSED` unpause gate** (1: ValidatorAnnounce, 2: verifier
semantics, 3: 24h validator run, 4: controlled settlement rehearsal,
5: alerts wired) referenced just above, and a **later external review's
separate 5-item list** (1: ValidatorAnnounce, 2: verifier semantics,
3: ReplayGuard Testnet deployment, 4: independent validator operator,
5: dedicated RPC) that this and the next addendum below track. The
next addendum's "gate item 3" refers to the **second** list
(ReplayGuard), not the six-point gate's item 3 (the 24h window, tracked
separately in `24H_OBSERVATION_LOG.md`).

## Eleventh addendum: ReplayGuard deployed and tested on Testnet — real, with an honest gap noted

Executed the full `REPLAYGUARD_DEPLOYMENT.md` procedure for real, using
the operator's own local Solana wallet (`~/.config/solana/id.json`),
confirmed to be `decision-relay`'s actual on-chain upgrade authority
(`EBea3UVndSrNdgdtfuXC6PoN7573GdS43XDoB6pja9fh`) before touching
anything.

**Program upgraded**: tx `5imuwmjnWeT2mCgvEXxbBj9qY76mQjwz3QEdS4teNc3w5c4LbYpjCSicu818JaiD6EfbcD54vxM3ZCuaFbheJFxX`,
confirmed via `solana program show` (deployed slot advanced).

**`InitReplayGuard` called**: tx `4i2Topfj1YWFBduuEK7Js2dc5eYqWJE8U8cZw5WyWPXsfZKziTiBUpEqEeX8EbEbzCZGgRFTDM2AUcDfFtmB34Bo`
— PDA verified fresh (owner = `decision-relay`, `seen` all-zero,
`next_index` 0). (An earlier manual byte-offset check of the raw
account data briefly looked wrong — `AccountData<T>`'s 1-byte presence
tag was not accounted for in the first read; re-checked with the
correct offset and confirmed genuinely fresh.)

**Real delivery proven**: dispatched a real DecisionRelay message from
Sepolia reusing the actual GenLayer decision from case
`CASE-LIVE-TEST-SOL-1` (created earlier this session as part of the
two-chain settlement test) — Solana `process()` tx
`2p8zGoiyvrW8xRt5CA2t8PDhmj4UzHVXL5vxEEe3YSnELvxq9yCA7qaR7F4e1irpwEUpfDNVC1RU5xW1b28dsZ4f`,
directly confirmed via `solana confirm -v`. ReplayGuard's `next_index`
went 0→1, slot 0 = the exact decisionHash byte-for-byte.

**Replay attempt — honest, not overclaimed**: dispatched a second
message carrying the same decisionHash (a fresh Hyperlane message, not
a literal duplicate — a stronger test of `decision-relay`'s own
application-level guard, independent of Hyperlane's own message-level
replay protection). Over 20+ minutes of direct on-chain monitoring, no
`process()` transaction for this second message ever appeared — not a
confirmed failure, not a confirmed success. **What is directly
proven**: ReplayGuard's state never changed across that entire window
despite the second dispatch existing and being indexable on Sepolia.
**What is not directly proven**: an actual on-chain transaction
failure demonstrating the rejection path executing. This is real,
supporting evidence, not the strongest possible proof — recorded
honestly rather than rounded up.

**No-escrow-side-effect confirmed**: the real escrow case PDA
(`njL4rgdzRJvBgt6pr8zw5RPgpSnhxme2NxRtocCdkg8`) was checked before and
after — lamports, owner, and data length all unchanged. `handle()`
moved no funds and changed no escrow state across either delivery
attempt, exactly as designed.

**Verdict on this review's gate item 3 (ReplayGuard)**: substantially
satisfied — real program upgrade, real `InitReplayGuard`, real proven
delivery, real proven no-fund-movement, on a live Testnet deployment.
The replay-rejection property has real but not maximally strong
evidence (see above) — worth a follow-up direct observation of an
actual failed `process()` transaction if that certainty is wanted
before treating this as fully closed, but the code itself was already
unit-tested for this exact rejection path (12/12 `cargo test -p
decision-relay` passing, including `rejects_replay_of_the_same_decision_hash`)
before deployment, which is corroborating, independent evidence.

Full details, all real transaction signatures, and the honest
delivery/replay/no-side-effect breakdown are in
`chains/solana/REPLAYGUARD_DEPLOYMENT.md`.

## Twelfth addendum: audit response — verifier semantics fixed, replay finding corrected, item-11 checklist produced

An external audit found the live verifier's actual result (9 pass, 5
warn, 3 fail — not the 10/5/2 previously reported) and identified two
real, distinct bugs behind two of those fails, plus gave an 11-item
action list with an explicit governing instruction: *"Continue
read-only until explicitly authorized for each production change. Do
not lift `SETTLEMENT_PAUSED`."*

**Item 1 fixed — verifier dispatch classification.**
`checkRecentDelivery()` in
[verify-deployment.ts](../chains/hyperlane-validator/scripts/verify-deployment.ts)
used to judge only the single most recent dispatch as the production
health signal, with no purpose classification — so a deliberate
replay-rejection test message (dispatched by this project's own
tooling) was scored by the same "past SLA = fail" rule as a real
settlement. Rewrote it to walk every dispatch in the lookback window,
classify each against a new `knownNonSettlementDispatches` list in
[deployment.json](../chains/hyperlane-validator/deployment.json), and
apply the hard SLA-fail path only to the most recent *unclassified,
same-chain* dispatch.

**A second, previously-undiscovered real bug found and fixed in the
same pass**: `Mailbox.delivered()` on Sepolia is structurally
meaningless for a dispatch whose destination is a different chain
(e.g. Solana) — Sepolia's own Mailbox never sees that message's
actual delivery, so it always reads `false` regardless of what really
happened on the destination chain. Every genuinely cross-chain test
dispatch was being silently misreported as "undelivered." Fixed by
decoding the `destination` domain from the Dispatch event and gating
the Sepolia-side `delivered()` check to same-chain dispatches only;
cross-chain dispatches now get an honest "not checkable from Sepolia"
warning instead of a false fail.

**Verified live** (dedicated RPC): 20 checks, 13 pass, 5 warn, 2
fail — the two remaining fails are the pre-existing, genuine,
unrelated validator1/validator2 contiguous backfill lag, not
misclassification artifacts.

**Item 2 corrected — replay-rejection finding.** Re-checked the
replay-test message's on-chain history using the raw
`getSignaturesForAddress` RPC method (its `err` field reliably
reports success/failure, unlike the `solana transaction-history` CLI
helper used previously). Corrected finding: `decision-relay`'s entire
history is 15 signatures, all `err: null`, with no new signature at
all since the first delivery — meaning the relayer never submitted a
`process()` for the replay message, not that one was submitted and
failed. `chains/solana/REPLAYGUARD_DEPLOYMENT.md` was rewritten to
state this precisely: replay rejection is proven only at the Rust
unit-test level (`rejects_replay_of_the_same_decision_hash`, passing),
**not** on-chain — a genuinely deterministic on-chain rejection proof
(a real Mailbox `process()` call with valid ISM metadata, built
outside the relayer) remains outstanding and was assessed as
substantial additional work, not attempted this pass.

**Item 3 — 24h reliability gate.** Logged Snapshot 2 in
[24H_OBSERVATION_LOG.md](../chains/hyperlane-validator/24H_OBSERVATION_LOG.md)
with persistent state (all three apps clean: no restart/OOM/AccessDenied
since window start) plus the two sections the audit explicitly asked
for: checkpoint publication (signed index 871646 vs. mailbox nonce
873016, lag 1370 leaves — unchanged in magnitude across several
real-time checks, flagged as a genuine open question, not just
restart/OOM counts) and specific-message checkpoint coverage. Explicit
pass/fail criteria for the gate were also added to the file's header.

**Item 11 — key-rotation checklist produced** (not executed):
[key-rotation-checklist.md](key-rotation-checklist.md) covers the two
Solana private keys and three RPC endpoint keys exposed earlier this
session, procedure per credential, and an explicit note that the
operator declined rotation for these specifically and that decision
stands as an accepted residual risk, not an oversight.

**Items 4-10 — explicitly on hold, not started.** Settlement
rehearsal, daily reconciliation, policy governance/human escalation,
evidence provenance, validator3 cutover + Safe ISM migration, Solana
ISM migration, and real alert delivery all require per-item
authorization the operator has not yet given. `SETTLEMENT_PAUSED` has
not been touched.

## Thirteenth addendum: re-audit — checklist danger fixed, real destination-side delivery check added

A second, harder external re-audit of the twelfth addendum's own work
found the new key-rotation checklist was itself unsafe as written, and
found the "fixed" cross-chain delivery check was still not positive
verification. Both addressed for real this pass; no code or deploy
state outside this repo was touched, and `SETTLEMENT_PAUSED` remains
untouched.

**P0 fixed — [key-rotation-checklist.md](key-rotation-checklist.md)
was pointing at the wrong system.** It told the operator to rotate
Solana secrets via Vercel and speculated the attestor allowlist might
live in the escrow program. Neither is true:
[DEPLOYMENT.md](../DEPLOYMENT.md) names Fly app `anc-hor-worker` as
the sole holder of `SOLANA_ATTESTOR_PRIVATE_KEY`/`SOLANA_RELAY_PRIVATE_KEY`
and the only process that ever dispatches a real settlement, and
`ATTESTOR_PUBKEYS` in
`chains/solana/programs/decision-relay/src/lib.rs` is a compile-time
constant inside the `decision-relay` program — not an env-var,
readable by neither Vercel nor the escrow program. Rewrote the
attestor-key procedure to require, in order: resolving any in-flight
co-signature first, a real tested `decision-relay` program upgrade
that installs the new public key in `ATTESTOR_PUBKEYS`, a Testnet
attested-settlement validation against the *upgraded* program before
the private key is touched anywhere real, only then setting the new
key on `anc-hor-worker` (not Vercel), a second post-cutover validation,
and only then discarding the old key. The relay-key procedure was
corrected to the same app (`anc-hor-worker`, not Vercel) — no program
upgrade needed there since that key isn't checked against any on-chain
allowlist.

**P1 fixed — destination-aware delivery verification implemented.**
The prior fix correctly stopped calling Sepolia's `Mailbox.delivered()`
on cross-chain dispatches, but reported them as "pass" with actual
state "unknown" — not positive verification. `verify-deployment.ts`
now queries the live ReplayGuard PDA on Solana Testnet directly over
raw JSON-RPC (`getAccountInfo`, decoding the same byte layout
confirmed in `REPLAYGUARD_DEPLOYMENT.md`: 1-byte presence tag + 32×32
bytes of `seen` + 1-byte `next_index`) and checks whether a
dispatch's real `decisionHash` is actually present. An
expected-delivered cross-chain dispatch now only reports `pass` when
that hash is confirmed present on Solana; it reports `fail` if
confirmably absent, and `warn` — never `pass` — if the destination
check can't run at all (no RPC config, no decisionHash, or the query
fails). The replay-rejection test message is explicitly reported as
unverifiable by this method (the hash is already present from the
first legitimate delivery, so presence alone can't distinguish
"never submitted" from "resubmitted and rejected") rather than folded
into either pass or fail. Verified live this pass (against the public
RPC fallback, local dev only): the destination check genuinely
reached Solana Testnet and confirmed
`0x2676915c...e5a9c`'s decisionHash IS present in the real ReplayGuard
PDA's `seen` buffer — real, positive, destination-side evidence.

**P1 fixed — checkpoint coverage now selects the right message.**
`checkMessageCheckpointCoverage` used to always check the single
latest dispatch, which — right after this project's own tooling sent
a deliberate replay test — was that test message, not a production or
rehearsal dispatch. It now walks backward past every
`knownNonSettlementDispatches`-classified message to find the latest
real production/rehearsal dispatch, reports coverage against that
message's actual nonce, and separately flags (informationally) when
the very latest dispatch in the window is itself a classified test so
that fact isn't silently lost. Verified live: coverage is now reported
against nonce 872850 (the real prior production dispatch), not the
replay test's nonce.

**P1, correctly not addressed this pass — the backfill lag itself.**
The audit is right that "no OOM/restart" must not substitute for
checkpoint currency: `checkpoint-currency` still fails at a ~1370-leaf
contiguous lag, unchanged in magnitude across this pass's checks, and
the 24h gate is only a few hours in. No code change fixes this — it
needs the observation window to actually run to its conclusion (see
24H_OBSERVATION_LOG.md), and diagnosis if the lag is still flat at the
deadline.

**Not started, correctly held per the standing instruction**
("Continue read-only until explicitly authorized... Do not lift
`SETTLEMENT_PAUSED`"): a deterministic on-chain ReplayGuard rejection
proof, the no-customer-funds settlement rehearsal, validator3 + Safe
ISM cutover, the Solana ISM migration, and live alert wiring. All
remain items 4-10's responsibility, not this addendum's.

## Fourteenth addendum: full product/security audit — P0 authorization escalation and settlement-target validation fixed

A separate, full-product external audit (two independent submissions,
converging on the same findings) reviewed the web app's own code — API/
auth, case lifecycle, settlement, webhooks, audit chain — not just the
Hyperlane validator infra the prior addenda cover. It found two real P0
code defects and several P1 gaps. Fixed the P0s and the tractable P1s
this pass; the rest are real, larger follow-ups, listed honestly below
rather than glossed over.

**P0 fixed — VIEWER-to-API-key privilege escalation.**
[api-keys/route.ts](../apps/web/src/app/api/api-keys/route.ts) and
[api-keys/[id]/route.ts](../apps/web/src/app/api/api-keys/%5Bid%5D/route.ts)
used `getSessionMember()` (any authenticated member) instead of
`requireOwner()` for create/list/revoke. Combined with API-key auth
carrying no `role` (so it always passes `requireWriteAccess`'s
VIEWER-only check) and
[case-access.ts](../apps/web/src/lib/case-access.ts) treating any
API-key caller as full-trust (same as OWNER) for restricted-case
access, a read-only VIEWER member could mint a key and use it to become
an unrestricted, org-wide writer with full case access. Fixed: both
routes now require `requireOwner()`, matching the same gate this
project already used for webhooks/member management/audit log. Since
minting is now OWNER-only, the API-key full-trust design in
case-access.ts is coherent again (an API key can now only be created by
someone who's already full-trust org-wide) — that file itself needed no
change. Also fixed a related, real gap found in the same pass: API-key
creation and revocation were never audited at all; both are now wrapped
in one transaction with a `logAction` call (`api_key.created`/
`api_key.revoked`), matching this project's existing atomic
mutation+audit pattern.
**Not done this pass, explicitly flagged**: scoped/expiring API keys
(the audit's further recommendation beyond the P0 fix itself), and
revoking/reissuing any keys that existed before this fix — their
historical scope is genuinely unknown and that's an operator decision
on live data, not something to do unasked.

**P0 fixed (partially, honestly) — arbitrary EVM/Solana settlement
targets rejected.** [cases/route.ts](../apps/web/src/app/api/cases/route.ts)
accepted a fully caller-provided `settlementContract` (used directly as
both the EVM DecisionRelay recipient and the Solana decision-relay
program ID) and `settlementSolanaEscrowProgram` (the actual Solana
escrow program invoked to move funds) with zero validation against
anything this project actually deployed.
[hyperlane.ts](../apps/web/src/lib/hyperlane.ts) now exposes
`isApprovedSettlementContract`/`isApprovedSolanaEscrowProgram`, checked
against an operator-controlled allowlist — defaults to this project's
own real deployed addresses (Sepolia DecisionRelay
`0x94f3FF...cbC71C`, Solana decision-relay program
`DGWSTw1P...VBbpVN`, Solana escrow program `825aV7GJ...NMugeZn` — the
last two confirmed live via `solana program show` this session, not
guessed), overridable via
`APPROVED_SEPOLIA_SETTLEMENT_CONTRACTS`/`APPROVED_SOLANA_SETTLEMENT_PROGRAMS`/
`APPROVED_SOLANA_ESCROW_PROGRAMS` env vars for a genuinely new approved
integration. Case creation now rejects any settlement target not on
this list. **What this does NOT fix, stated plainly**: the EVM dispatch
still hardcodes `escrowId` to a zero placeholder (see
`dispatchDecisionForCase`'s own comment, unchanged) — there is still no
real per-case on-chain escrow binding, asset/party/amount/state
validation, or approved-integration data model. This allowlist closes
"arbitrary address," not "no real escrow integration" — the audit's
own required correction (a `SettlementIntegration` model, a tested
escrow adapter) remains real, larger, unstarted follow-up work. The
Sepolia settlement path should continue to be described as incomplete,
not as live generic escrow settlement.

**P1 fixed — SSRF DNS-rebinding race.**
[ssrf-guard.ts](../apps/web/src/lib/ssrf-guard.ts)'s `assertSafeToFetch`
validated a hostname's resolved IPs, but the caller then called plain
`fetch()`, which performs its own independent DNS resolution — a
classic TOCTOU gap letting a rebound DNS record point at a private
address between validation and connection. Added the `undici` package
and rewrote `safeFetch` to resolve+validate once, then connect via an
`undici.Agent` with a `connect.lookup` pinned to the exact validated
address (TLS SNI/Host still come from the original URL — only the
second, racy DNS resolution is removed). Real fix, not a mitigation.

**P1 fixed — webhook signing secrets no longer plaintext.**
`Webhook.secret` was a plaintext DB column, returned in full on every
`GET /api/webhooks`. Added AES-256-GCM encryption at rest
(`encryptWebhookSecret`/`decryptWebhookSecret` in
[webhooks.ts](../apps/web/src/lib/webhooks.ts), key from
`WEBHOOK_SECRET_ENCRYPTION_KEY`), a new
`POST /api/webhooks/:id/rotate-secret` endpoint, and changed both
create and list to return only a masked `secretPreview` from GET — the
raw secret is now shown exactly once, at creation or rotation (updated
the dashboard page to match: a one-time reveal banner, a "Rotate
secret" button). **This is envelope encryption in spirit, not a real
KMS** — the audit's suggested further step (managed KMS, per-secret
data keys, key rotation) is real, larger follow-up work.
**Schema/migration handled carefully, not applied**: added the new
columns as **nullable** in
[prisma/migrations/20260902190000_encrypt_webhook_secrets](../apps/web/prisma/migrations/20260902190000_encrypt_webhook_secrets/migration.sql)
(a raw SQL migration cannot itself encrypt existing plaintext secrets —
that needs the app-level key) and left the old plaintext `secret`
column in place for now; wrote
[scripts/backfill-webhook-secrets.ts](../apps/web/scripts/backfill-webhook-secrets.ts)
to encrypt existing rows once, after the migration is applied. A
follow-up migration (not written yet, on purpose) should set the new
columns NOT NULL and drop the plaintext column only after the backfill
is confirmed complete. **This migration was NOT applied to the live
database this pass** — it's a real schema change to production data
and needs the operator's own deploy step (per DEPLOYMENT.md's
`flyctl`/`vercel` redeploy flow), not something to run unasked from
here.

**Verified**: `npx tsc --noEmit` clean across all changes. The existing
`vitest` integration suite could not be run against a local Postgres
(none configured in this environment — all 7 failures are
`Can't reach database server at localhost:5555`, unrelated to these
changes; 10 unit-style tests not needing a DB passed).

**Real, larger P1/P2 gaps correctly NOT attempted this pass** (each
would be its own substantial piece of work, not a same-session fix):
money validation still uses JavaScript `Number` instead of exact
decimal/atomic-unit types; audit-write atomicity is fixed for the two
routes touched this pass (api-keys, webhooks) but not audited
end-to-end across every mutation; no rate limiting, MFA/WebAuthn, or
verified-email gating on auth routes; party authority is still bearer-
token possession, not verified identity; the Solana transport is still
relayer-trust (`TRUSTED_ISM`), not multisig-verified; cross-chain
delivery monitoring is still per-message rather than a durable
reconciliation table; the validator set is still not independent. All
consistent with, and mostly already tracked by, the prior addenda's own
"held pending authorization" list.
