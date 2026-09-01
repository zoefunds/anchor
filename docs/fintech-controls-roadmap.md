# Fintech controls roadmap

Status: roadmap document. Items marked **[implemented]** below have real,
tested code in this repo as of this pass; everything else is design only.
Per the brief this responds to: implement only what's genuinely testable
locally — this is explicitly not a claim that Anchor provides regulated
financial services, and nothing here should be read as one.

## 1. Evidence provenance

Goal: distinguish "a party told us this" from "we independently verified
this," with enough metadata that a later reviewer or auditor can check the
claim without trusting Anchor's own database.

- **Typed external evidence attestations** — a record type (separate from
  a party's own submitted `Evidence` row) carrying: source identity (who/what
  system produced this — a webhook, an API the backend called out to, a
  signed party statement), retrieval time, content hash, a signature over
  that hash where the source can produce one (webhook HMAC, API response
  signature), and a `verificationResult` enum (`VERIFIED`,
  `UNVERIFIED_SOURCE`, `SIGNATURE_INVALID`, `PARTY_ASSERTION_ONLY`).
- **Party assertion vs. independent evidence** — today's `Evidence` model
  (`apps/web/prisma/schema.prisma:378`) doesn't structurally distinguish
  these; a new `sourceType` field (`PARTY_SUBMITTED` vs
  `EXTERNALLY_SOURCED`) plus the attestation record above would let policy
  logic (and human reviewers) weight evidence accordingly, e.g. requiring
  at least one `EXTERNALLY_SOURCED` `VERIFIED` record before certain
  outcomes.
- **Priority**: code-now-able once a concrete external source integration
  exists to attest from (webhook payment/delivery confirmations are the
  natural first case, since `Webhook`/`WebhookDelivery` already exist in
  the schema — see `apps/web/prisma/schema.prisma:106`). Building the
  attestation *shape* now without a real source to populate it would be
  speculative schema, which the project's own conventions avoid.
- **Category**: code-now for the schema/type work once a first real source
  is chosen; regulated-decision-required for which external sources count
  as sufficiently independent for higher-stakes policy decisions.

## 2. Policy governance

Goal: a decision must be traceable to an exact, immutable policy version —
no retroactive edits, no ambiguity about what rules applied.

- **Tenant-scoped immutable policy versions** — policies already have
  `policy_id`/`policy_version` referenced throughout (see
  `docs/policy-v1.md`, `Decision.policyId`/`policyVersion` if present in
  schema) but a dedicated `PolicyVersion` table (organization-scoped,
  content-hashed, `frozenAt` timestamp, no update path — only insert new
  versions) would make "no retroactive edits" structurally enforced rather
  than a convention.
- **Approval workflow + audit records** — a policy version transitions
  `DRAFT` → `PENDING_APPROVAL` → `ACTIVE`, each transition an immutable
  audit event (reuses the existing `AuditLog` pattern —
  `apps/web/prisma/schema.prisma:145` — rather than inventing a parallel
  mechanism).
- **Decisions bind policy ID/version/code hash permanently** — `Decision`
  rows should store not just `policyId`/`policyVersion` but a hash of the
  actual policy logic/prompt content that was live at decision time, so a
  later policy edit (even a bugfix) can never be retroactively implied to
  have applied to a past decision.
- **Category**: code-now for the schema + binding logic; regulated-decision
  required for who is authorized to approve a policy version in production
  (that's an organizational control, not a code gate).

## 3. Human escalation

Goal: cases the automated adjudication genuinely can't resolve need a real
queue, not silent fallthrough.

- **Structured UNDETERMINED/exception queue** — cases where
  `Decision.consensus` isn't `ACCEPTED` (or the policy itself yields
  `UNDETERMINED`) should land in a queryable queue, not just sit as an
  unresolved `Decision` row a human has to know to look for.
- **Reviewer assignment + reasoning + dual control** — an escalated case
  gets an assigned reviewer, the reviewer's decision + written reasoning is
  itself an immutable audit record (same `AuditLog` pattern), and
  high-value cases (threshold configurable, see §4) require two distinct
  reviewers to agree before the decision is final — mirrors the 2-of-2
  pattern already used for on-chain attestation, applied to the human
  layer.
- **Category**: code-now for the queue/assignment/audit-record mechanics;
  regulated-decision-required for who is authorized to be a reviewer and
  what qualifies someone for dual-control sign-off on real-money cases.

## 4. Operational controls

- **Configurable settlement limits** [implemented — see below].
- **Emergency pause** [implemented — see below]: halts new dispatches while
  preserving read access to evidence/appeals (a pause must never look like
  data loss to a party mid-appeal).
- **Daily reconciliation** — a scheduled job comparing: finalized
  `Decision` rows with `relayTxHash` set, their corresponding on-chain
  dispatch (`Dispatch` event on EVM / equivalent on Solana), and — where
  checkable — the destination chain's actual settlement state (escrow
  balance change, a `DecisionReceived`/settlement event). Any decision
  finalized without a matching on-chain artifact past a freshness window
  is an alertable reconciliation gap. This naturally extends the existing
  `retryFailedSettlements`/`checkForMissedAnchors` pattern
  (`apps/web/src/lib/adjudication-service.ts`, `apps/web/src/lib/audit-anchor.ts`)
  rather than inventing a new one.
- **Category**: settlement limits and emergency pause are code-now (done
  this pass); reconciliation is code-now as a follow-up (same shape as
  existing sweep jobs, not built this pass due to scope); what
  reconciliation gap severity requires human intervention vs. automated
  retry is an operational judgment call, not purely code.

## 5. Privacy / retention

- **Evidence retention schedules** — a per-organization (or per-policy)
  retention period after which `Evidence` content (not the audit trail of
  *that evidence existed and what decision it fed*) is eligible for
  deletion.
- **Legal-hold support** — a flag on a `Case` or `Evidence` row that
  suppresses retention-driven deletion regardless of schedule, itself
  settable only via an audited action (who placed the hold, when, why).
- **Deletion workflow preserving audit integrity** — deleting evidence
  content must not delete the `AuditLog`/`AuditAnchor` record that
  referenced its hash; the audit chain's hash-linking already means
  content deletion doesn't break the chain (the chain never stored raw
  content, only hashes/references) — this needs a deletion path that's
  explicit about deleting *content* while leaving the *hash record* intact,
  not a blanket cascade delete.
- **Access-log retention/export** — who viewed a case's evidence, when;
  currently not modeled at all. A minimal `EvidenceAccessLog` table
  (viewer, case/evidence ID, timestamp) would need to exist before any
  export capability is meaningful.
- **Category**: entirely regulated/business-decision-required for what
  retention periods and legal-hold triggers are actually appropriate —
  Anchor is not in a position to invent regulatory retention schedules;
  the code-now part is only the *mechanism* (a schedule field, a hold flag,
  a deletion path that respects both), not any specific default period.

## What was actually implemented this pass

Two pure, locally-testable operational gates were added to
`apps/web/src/lib/adjudication-service.ts`'s settlement dispatch path
(`dispatchSettlementForDecision`), both fail-closed and both covered by
new unit tests:

1. **Configurable settlement limits** — `getSettlementLimitAtto(chain)`
   reads a per-chain limit from environment config
   (`SETTLEMENT_LIMIT_ATTO_DEFAULT` / `SETTLEMENT_LIMIT_ATTO_<CHAIN>`);
   `dispatchSettlementForDecision` refuses to dispatch (logs and returns,
   same "refuse rather than fabricate" pattern already used for missing
   proof hashes) if the case's total settlement amount exceeds the
   configured limit for its `settlementChain`. This is explicitly an MVP
   shape — env-var configuration, not the tenant/policy-scoped DB table
   described above — flagged in the code's own comment as the first real
   step toward §4's full design, not the finished version.
2. **Emergency pause** — `isSettlementPaused()` reads a single
   `SETTLEMENT_PAUSED` environment flag; when set,
   `dispatchSettlementForDecision` refuses to dispatch new settlements
   while leaving every other code path (evidence access, appeals, decision
   read APIs) completely unaffected — the function only gates the dispatch
   call itself, nothing upstream of it.

Both are covered by `apps/web/tests/unit/settlement-controls.test.ts`.
