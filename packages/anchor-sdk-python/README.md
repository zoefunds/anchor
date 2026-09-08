# anchor-sdk (Python)

A typed Python client for Anchor's REST API — real HTTP calls (via
`requests`) against the actual routes under `apps/web/src/app/api/**`,
not stubs. Mirrors `packages/anchor-sdk` (the TypeScript SDK) field for
field and route for route; where that package documents a real gap
(no pagination, no idempotency), this one documents the same gap
instead of papering over it.

**Dependency:** this package depends on
[`requests`](https://pypi.org/project/requests/) (`>=2.31`), declared
in `pyproject.toml`. Nothing here uses `urllib`/`http.client` directly.

Covers: case creation/listing/reads, evidence submission, adjudication
requests, org policies (read), analytics, receipts/statements, and the
org settlement export. Also ships `verify_webhook_signature`, matching
`apps/web/src/lib/webhooks.ts`'s real HMAC-SHA256-over-`timestamp.body`
scheme exactly.

**Not covered / explicitly out of scope for this pass** (same boundary
as the TypeScript SDK — see `packages/anchor-sdk/README.md`): decisions
(review/appeal), org-policy writes, settlement-integrations, webhook
management, api-keys management, members/invites, ops-console,
reconciliation-findings. These routes exist and work — call them
directly with `requests` if you need them before this SDK grows to
cover them.

## Parity with the TypeScript SDK

| Capability | TS SDK | Python SDK |
|---|---|---|
| `createCase` / `create_case` | yes | yes |
| `listCases` / `list_cases` | yes | yes |
| `getCase` / `get_case` | yes | yes |
| `submitEvidence` / `submit_evidence` | yes | yes |
| `requestAdjudication` / `request_adjudication` | yes | yes |
| `listOrgPolicies` / `list_org_policies` | yes | yes |
| `getAnalytics` / `get_analytics` | yes | yes |
| `getDepositReceipt` / `get_deposit_receipt` | yes | yes |
| `getSettlementReceipt` / `get_settlement_receipt` | yes | yes |
| `getCaseStatement` / `get_case_statement` | yes | yes |
| `getProofBundle` / `get_proof_bundle` | yes | yes |
| `getSettlementsCsv` / `get_settlements_csv` | yes | yes |
| `getReconciliationExport` / `get_reconciliation_export` | yes | yes |
| `verifyWebhookSignature` / `verify_webhook_signature` | yes | yes |
| Strongly-typed `CaseRecord`/`EvidenceRecord` | yes (interfaces) | yes (dataclasses) |
| Contract test against real route handlers | yes (`test/contract.test.ts`, TS-only — Python can't import a Next.js route handler) | no — see below |

This is a 1:1 method mirror of the TS SDK's current surface. Nothing in
the TS SDK's public API is missing here, and nothing is added on top of
it. The one real asymmetry: the TS SDK has `test/contract.test.ts`,
which calls the actual Next.js route handlers in-process to catch
type drift; that's only possible from the same language/runtime as the
routes, so there is no equivalent Python contract test — this package's
types are kept in sync by hand against `packages/anchor-sdk/types.ts`
and the route handlers, same manual-sync risk the TS SDK's own header
comment already discloses for its own types.

## Quickstart

```python
from anchor_sdk import AnchorClient, CreateCaseRequest, SubmitEvidenceRequest

client = AnchorClient(
    base_url="https://anchor-testnet.example.com",  # TESTNET — no real value
    api_key="ak_live_...",  # minted via POST /api/api-keys
)

created = client.create_case(CreateCaseRequest(
    claim="Package not delivered",
    amount="1250.50",  # MUST be a decimal string, not a float
    claimant_ref="claimant-pseudonym-1",
    respondent_ref="respondent-pseudonym-1",
))

# claimant_token/respondent_token are only ever returned here, once.
print(created.claimant_token, created.respondent_token)

client.submit_evidence(created.id, SubmitEvidenceRequest(type="task_spec", content="..."))
client.request_adjudication(created.id)  # async — poll or subscribe a webhook

kase = client.get_case(created.id)
```

## Auth

Same model as the TS SDK: `Authorization: Bearer ak_live_...`, one key
per organization, optionally case-restricted and/or time-limited, rate
limited at **120 requests/minute per key**. There is no per-key
read/write scope split enforced beyond the (Phase 5) scope vocabulary
in `apps/web/src/lib/api-scopes.ts` (`cases:read`, `cases:write`,
`evidence:write`, `settlements:read`, `settlements:write`,
`settlements:export`, `analytics:read`, `policies:read`,
`organizations:read`) — pre-existing keys with no recorded scopes
default to full access, per `docs/api/README.md`.

## Error model

Every non-2xx response is JSON: `{"error": "<message>", ...extra}`.
This SDK raises `AnchorApiError` (`.status`, `.body`) for any non-OK
response, including 429 (rate limited — `.body["retryAfterSeconds"]` is
set, matching the `Retry-After` header). See `docs/api/README.md`'s
error-code reference table for the real status codes each route
returns.

## Idempotency and pagination

Identical gaps to the TypeScript SDK, because they're gaps in the
server, not the client:

- **Idempotency:** `POST /api/cases` has no server-side idempotency-key
  mechanism. A retry after a network error/500 can create a duplicate
  case. Dedupe on your own side if you need this.
- **Pagination:** `GET /api/cases` returns the caller's entire case
  list in one response. `list_cases()` reflects that as-is.

## Webhooks

```python
from anchor_sdk import verify_webhook_signature

ok = verify_webhook_signature(
    raw_body=raw_body,  # exact request body bytes/string, not re-serialized JSON
    timestamp_header=request.headers.get("X-Anchor-Timestamp"),
    signature_header=request.headers.get("X-Anchor-Signature"),
    secret=os.environ["ANCHOR_WEBHOOK_SECRET"],
)
```

Event vocabulary (`WEBHOOK_EVENTS`, matching
`apps/web/src/lib/webhooks.ts`'s `WEBHOOK_EVENTS`): `case.status_changed`,
`case.decided`, `case.appealed`, `case.relay_dispatched`,
`case.emergency_refund_prepared`, `case.emergency_refund_settled`.

## Testnet environment

Anchor is testnet-only. Every settlement this API can produce runs on
Sepolia (EVM) or Solana devnet/testnet — `settlement_chain` only accepts
`"sepolia"` or `"solanatestnet"`. There is no mainnet mode, no real
money moves, and no production deployment target for this codebase.

## Installation (local/dev)

This package is not yet published to PyPI. Install it editable from a
checkout:

```bash
pip install -e packages/anchor-sdk-python
```

## Verification performed for this package

`python3 -m py_compile` was run against every `.py` file in
`anchor_sdk/` — see the repository's dev notes for the exact command
and output. No `mypy`/`pyright` type-check was run beyond that unless
noted alongside it, since this environment may not have either
installed; if you have `mypy` available, `mypy anchor_sdk` is a
reasonable follow-up (the codebase uses plain type hints throughout).
