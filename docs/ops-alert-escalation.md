# Ops alert escalation path

Real, minimal, and honest about what's actually configured today — this
is the mechanism, not a claim that a 24/7 rotation exists.

## Severity → response target

| Severity | Meaning | Response target | Env var |
| --- | --- | --- | --- |
| `critical` | Real funds at risk or already-misdirected: zero/mismatched settlement target, escrow version mismatch, dispatched-but-DB-stale drift. | **[fill in: named person or on-call rotation]** | `OPS_ALERT_OWNER_CRITICAL` |
| `warning` | Operationally real but not immediately fund-moving: overdue deposit, audit-anchor staleness. | **[fill in]** | `OPS_ALERT_OWNER_WARNING` |
| `info` | Resolution notices (a finding closing) and ordinary status. | **[fill in, or leave unset]** | `OPS_ALERT_OWNER_INFO` |

Any severity without its own env var falls back to `OPS_ALERT_OWNER` — a
single-operator deployment can set just that one.

## What actually happens today

1. `lib/reconciliation.ts`'s sweep runs every 15 minutes, checks live
   on-chain state against the database, and opens/resolves
   `ReconciliationFinding` rows.
2. `lib/alerts.ts`'s `sendOpsAlert` posts to the Slack webhook at
   `OPS_ALERT_WEBHOOK_URL` (see `.env.example`). A finding is never lost
   even if this fails or isn't configured — the DB row is the durable
   record regardless.
3. A person sees the Slack message, opens
   `/settings/reconciliation-findings` (platform-admin-only — see
   `PLATFORM_ADMIN_EMAILS`), and clicks **Acknowledge** with an optional
   note. This does not resolve the finding — only the sweep, by
   re-checking the real condition, can do that.
4. Further remediation notes can be added to the same finding as work
   continues, producing a real, queryable history.

## Auto-escalation (now built)

A **critical** finding that's been alerted but sits unacknowledged
past `RECONCILIATION_ESCALATION_THRESHOLD_MS` (default 30 minutes)
gets a distinctly-labeled `[ESCALATION]` alert, repeated every
`RECONCILIATION_ESCALATION_REPEAT_INTERVAL_MS` (default 30 minutes)
while it remains unacknowledged. This still posts to the same
`OPS_ALERT_WEBHOOK_URL` — there is no separate escalation channel or
paging integration yet (see below). Acknowledging the finding (via
`/settings/reconciliation-findings`) stops further escalation
immediately.

## What is NOT yet built

- No paging/on-call integration (PagerDuty, Opsgenie, etc.) — Slack
  only, including for escalations.
- `PLATFORM_ADMIN_EMAILS` is a flat allowlist, not a role hierarchy —
  anyone on it sees every finding across every organization.

## Adding a real paging integration (free tier available)

If you want escalations to actually page someone (not just post another
Slack message), the lowest-effort real option is **PagerDuty's free
plan** (up to 5 users, unlimited alerts) or **Opsgenie's free tier**
(now part of Jira Service Management, 3 agents). Either works the same
way from this codebase's side:

1. Sign up, create a service/integration of type "Events API v2"
   (PagerDuty) or "API Integration" (Opsgenie).
2. Copy the generated integration/routing key — **not a password**, a
   scoped API credential safe to hand over and store as an env var.
3. Give that key here and ask to wire it in — `lib/alerts.ts` would
   gain a second delivery path alongside Slack (real HTTP POST to the
   provider's Events API, same real-delivery-confirmation discipline
   `sendOpsAlert` already has for Slack), triggered specifically for
   the escalation path above, not every info-level alert.

## Filling in real names

Set the env vars above (`OPS_ALERT_OWNER_CRITICAL`, `_WARNING`, `_INFO`,
or just `OPS_ALERT_OWNER` as a catch-all) via `flyctl secrets set` on
`anc-hor-worker`, and update the table in this doc to match — the doc
and the deployed env vars should never disagree about who's actually
on the hook for what.
