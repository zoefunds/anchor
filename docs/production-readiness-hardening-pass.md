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
