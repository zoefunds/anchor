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

## What is NOT yet built

- No paging/on-call integration (PagerDuty, Opsgenie, etc.) — Slack only.
- No automatic escalation if a critical finding goes unacknowledged for
  N minutes.
- `PLATFORM_ADMIN_EMAILS` is a flat allowlist, not a role hierarchy —
  anyone on it sees every finding across every organization.

## Filling in real names

Set the env vars above (`OPS_ALERT_OWNER_CRITICAL`, `_WARNING`, `_INFO`,
or just `OPS_ALERT_OWNER` as a catch-all) via `flyctl secrets set` on
`anc-hor-worker`, and update the table in this doc to match — the doc
and the deployed env vars should never disagree about who's actually
on the hook for what.
