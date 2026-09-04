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
while it remains unacknowledged. This posts to **two independent
channels**, in parallel (`Promise.allSettled` — a real failure in one
must not hide a real success in the other):

1. The same Slack webhook at `OPS_ALERT_WEBHOOK_URL` used for every
   other alert.
2. A real phone push via `lib/alerts.ts`'s `sendNtfyAlert`, posted to
   the [ntfy.sh](https://ntfy.sh) (or self-hosted ntfy) topic at
   `NTFY_TOPIC_URL` — used only for escalations, not every routine
   alert. ntfy needs no signup or credential; anyone who has
   subscribed to the topic in the ntfy app (or web/desktop client)
   gets a real push notification. Because ntfy topics are public by
   default, **the topic name itself is the only secret** — use a
   random, hard-to-guess one (e.g. `anchor-ops-<random hex>`), never
   something guessable like `anchor-alerts`.

Both channels are optional independently — escalation still works
with just one configured, and `lastEscalatedAt` only advances (so the
next escalation waits the full repeat interval) once at least one
channel confirms real delivery. Acknowledging the finding (via
`/settings/reconciliation-findings`) stops further escalation
immediately, on both channels.

## What is NOT yet built

- No PagerDuty/Opsgenie-style on-call rotation, scheduling, or
  acknowledgement-via-the-paging-tool — ntfy is a push notification,
  not an on-call system. `/settings/reconciliation-findings` remains
  the only place a finding is actually acknowledged.
- `PLATFORM_ADMIN_EMAILS` is a flat allowlist, not a role hierarchy —
  anyone on it sees every finding across every organization.

## Subscribing to escalation pushes

Install the [ntfy app](https://ntfy.sh/) (iOS/Android) or use the web
client at `https://ntfy.sh/<topic>`, and subscribe to the exact topic
configured in `NTFY_TOPIC_URL` on the worker. Anyone who knows the
topic name can subscribe or post to it — treat it like a shared
secret, not a public channel name.

## Filling in real names

Set the env vars above (`OPS_ALERT_OWNER_CRITICAL`, `_WARNING`, `_INFO`,
or just `OPS_ALERT_OWNER` as a catch-all) via `flyctl secrets set` on
`anc-hor-worker`, and update the table in this doc to match — the doc
and the deployed env vars should never disagree about who's actually
on the hook for what.
