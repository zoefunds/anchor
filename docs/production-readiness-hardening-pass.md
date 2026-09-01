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
  produced before the fix).

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
- Investigate the root cause of the ~2h14m `AccessDenied` streak found on
  the validator write path this pass (fixed pragmatically via machine
  restart; underlying cause — likely an IAM credential caching/rotation
  issue on the Fly side — was not identified within this pass's budget).
  A second, distinct staleness incident recurred later in this same pass
  (both validators stale again — one from S3 connect timeouts in
  `TipCheckpointSubmitter`, one from an outright-stopped Fly machine),
  fixed the same way (restart) but with its own root cause also
  undiagnosed. Two separate real incidents with the same symptom in one
  pass is itself a signal this needs real operator attention, not just
  another restart next time.
- Correct the validator announcement path — both validators announce a
  URI with a spurious `eu-north-1/` region segment that 403s; only the
  real object path (without it) is reachable. Requires either a
  validator-agent config change (`checkpointSyncer.region`/`.folder`
  flags) or a corrected re-announcement (its own on-chain transaction,
  signed by the validator key) — deliberately not done blind mid-pass
  given the risk of silently changing the real write path.
- Diagnose relayer indexing lag against the specific confirmed-undelivered
  message flagged above (`0x61b6e9e3...15df71`) — `verify-deployment.ts`
  now proves this is a real fail, not a false alarm; the underlying cause
  still needs a human to look at the relayer's own sync cursor.
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
- **Fixed — validators had actually gone stale.** The verifier's first
  real run this pass showed 2 genuine `fail`s: both validators' latest
  checkpoints were 1100-1900+ seconds old (threshold 900s). Root cause
  found in `flyctl logs`: `TipCheckpointSubmitter` stuck retrying S3
  connections that were timing out (`hyperlane-base/src/types/s3_storage.rs:128`,
  "HTTP connect timeout occurred after 3.1s") — separate from the earlier
  `AccessDenied` incident documented below, a different failure mode with
  the same symptom. validator2's Fly machine had also stopped outright.
  Fixed pragmatically (machine restart both validators) — freshness
  confirmed recovered (34s/64s old immediately after). **Root cause of
  the S3 connect timeouts themselves is still not diagnosed** — flagged
  in the residual risk register below, not swept under a "0 fails" claim.
- **Not fixed — the flagged dispatch is genuinely undelivered.** Message
  `0x61b6e9e3923a8b097d8580dfd29d8de5a85222634bf772895b499a37f815df71`
  (tx `0x2331a1fdaacf9d6c0d50cc5e34caf0554626a1b52d5b2f33cc1ca4d7999128c0`)
  is confirmed **not delivered** — `delivered()` returns `false`, checked
  both via the script and directly via `cast call`. This is a real `fail`
  in the current run, not a false alarm from an under-built check. Likely
  cause: the self-hosted relayer's forward-sync cursor was still well
  behind this message's nonce as of this pass's earlier investigation
  (871493 vs 872850) — a relayer indexing-lag issue, the same category
  `ALERTING.md` already documents as having no direct on-chain check.
  Left unresolved (not force-delivered or hand-waved) since diagnosing
  relayer indexing lag is a distinct operator-action item, not something
  to paper over in this verification pass.
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
3. **Relayer indexing lag has no direct on-chain check, and is confirmed
   causing at least one real undelivered message right now.**
   `verify-deployment.ts`'s delivery check now calls
   `Mailbox.delivered()` directly (fixed this pass — see above) and
   confirms message `0x61b6e9e3...15df71` is genuinely undelivered past
   SLA. `ALERTING.md` documents a log-grep fallback for indexing lag
   specifically; there is still no automated alert on the lag itself,
   only this after-the-fact delivery-confirmed SLA check.
4. **Validator staleness has recurred twice in this pass alone, from two
   different causes, both worked around rather than diagnosed.** First
   incident: ~2h14m of `AccessDenied` on the checkpoint write path.
   Second, later incident: S3 connect timeouts in `TipCheckpointSubmitter`
   plus one validator's Fly machine stopped outright. Both fixed the same
   way (machine restart) with no root-cause diagnosis. A pattern of
   "restart fixes it" without understanding why is itself a risk — the
   next occurrence might not resolve as easily, and nothing currently
   catches it faster than the SLA-based delivery check above.
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
