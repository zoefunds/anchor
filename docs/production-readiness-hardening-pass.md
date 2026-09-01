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
Required evidence for a clean bill of health: 0 `fail` results. Current
real run: 0 fails, 4 warns (2 announced-path-vs-region-stripped-path
reachability notes, 1 honest operator-independence warning, 1 past-SLA
dispatch with a documented likely cause) — all expected and already
explained above.

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
3. **Relayer indexing lag has no direct on-chain check.** `ALERTING.md`
   documents a log-grep fallback; there is no automated alert if the
   relayer's own indexing cursor falls behind, only a downstream SLA
   proxy (`checkRecentDelivery`) that fires after the fact.
4. **The ~2h14m validator `AccessDenied` incident's root cause is
   unresolved.** It was worked around (machine restart), not diagnosed.
   If it recurs and isn't caught quickly, checkpoint freshness — and
   therefore real message delivery — silently degrades again.
5. **Settlement limits and emergency pause are MVP-shaped.** Env-var
   configuration, not tenant/policy-scoped DB rows with an approval
   workflow — an operator with deploy access can change a limit with no
   audit trail beyond a deploy log. Adequate as a first real gate, not as
   a durable control for real-money operation.
6. **No daily reconciliation job exists yet.** A finalized decision with
   a dispatch that silently fails downstream (destination-chain issue,
   not caught by this pass's SLA check) has no automated cross-check
   against actual on-chain settlement state.
7. **No human escalation / dual-control queue exists yet.** Cases that
   don't reach ACCEPTED consensus have no structured reviewer workflow;
   they're just unresolved `Decision` rows today.
8. **No evidence retention/legal-hold/access-log mechanism exists yet.**
   All evidence is retained indefinitely with no export/deletion
   workflow and no record of who viewed what.

None of these are regressions introduced this pass — they're the honest
state of what's still missing, stated the way this pass's own tooling
(`verify-deployment.ts`'s independence check) already insists on: no
silent "looks secure enough," only what's actually verified.
