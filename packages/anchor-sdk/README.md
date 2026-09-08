# @anchor/sdk

A typed TypeScript client for Anchor's REST API — real `fetch` calls
against the actual routes under `apps/web/src/app/api/**`, not stubs.

Covers: case creation/listing/reads, evidence submission, adjudication
requests, org policies (read), analytics, receipts/statements, and the
org settlement export. Also ships `verifyWebhookSignature`, matching
`apps/web/src/lib/webhooks.ts`'s real HMAC-SHA256-over-`timestamp.body`
scheme exactly.

**Not covered / explicitly out of scope for this pass:** decisions
(review/appeal), org-policy writes, settlement-integrations, webhook
management, api-keys management, members/invites, ops-console,
reconciliation-findings. These routes exist and work — this SDK's first
pass wraps the case lifecycle + reporting surface a typical integrator
needs first. See `apps/web/src/app/api/` for the full route list.

**No Python SDK.** Out of scope for this pass — TypeScript only.

## Quickstart

```ts
import { AnchorClient } from "@anchor/sdk";

const client = new AnchorClient({
  baseUrl: "https://anchor-testnet.example.com", // TESTNET — no real value
  apiKey: process.env.ANCHOR_API_KEY!,            // ak_live_... minted via POST /api/api-keys
});

const created = await client.createCase({
  claim: "Package not delivered",
  amount: "1250.50", // MUST be a decimal string, not a JSON number
  claimantRef: "claimant-pseudonym-1",
  respondentRef: "respondent-pseudonym-1",
});

// claimantToken/respondentToken are only ever returned here, once.
console.log(created.claimantToken, created.respondentToken);

await client.submitEvidence(created.id, { type: "task_spec", content: "..." });
await client.requestAdjudication(created.id); // async — poll or subscribe a webhook

const kase = await client.getCase(created.id);
```

## Auth

Every route below the dashboard-session path authenticates via
`Authorization: Bearer ak_live_...` (see
`apps/web/src/lib/auth.ts:getApiKeyAuth`). A key is:

- scoped to exactly one organization,
- optionally restricted to a specific set of case IDs (`restrictedToCaseIds`),
- optionally time-limited (`expiresAt` — an expired key is rejected the
  same as a revoked one),
- rate-limited (see **Rate limits** below).

There is currently no per-key scope/permission system enforced on the
server (e.g. "read-only" vs "write" API keys) beyond the dashboard's
session-based `VIEWER` role (`requireWriteAccess` rejects a session
VIEWER's write attempts, but this does not apply to API keys — every API
key can both read and write everything its org/case restriction allows).
Document this honestly rather than implying scopes that aren't enforced.

## Error model

Every non-2xx response is JSON: `{ "error": "<message>", ...extra }`.
The SDK throws `AnchorApiError` with `.status` and `.body` for any
non-OK response. Common statuses actually returned by the routes above:

| Status | Meaning |
|---|---|
| 400 | Bad request body (missing/invalid field — e.g. non-decimal-string `amount`, unknown `policyId`) |
| 401 | No/invalid API key or session |
| 403 | Blocked by policy (e.g. risk engine `BLOCK`), or session VIEWER attempting a write, or OWNER-only route called by a non-owner |
| 404 | Not found, OR not visible to this caller — Anchor deliberately returns the same 404 for "doesn't exist" and "exists but you can't see it," to avoid leaking case existence |
| 409 | Conflicting state transition (e.g. adjudicating a case not in `EVIDENCE_COLLECTION`) |
| 429 | Rate limited — see below |

## Rate limits

API-key callers are limited to **120 requests/minute per key**, a
Redis-backed fixed window (`apps/web/src/lib/auth.ts:checkApiKeyRateLimit`).
A 429 response carries `Retry-After` (seconds) and
`{ "error": "rate limit exceeded", "retryAfterSeconds": <n> }`. Session-
cookie (dashboard) callers are not subject to this limit.

## Idempotency and pagination

- **Idempotency:** `POST /api/cases` has no server-side idempotency-key
  mechanism today. This SDK does not fabricate one client-side — a retry
  after a network error/500 can create a duplicate case. If you need
  this, dedupe on your own side (e.g. your own reference ID stored
  alongside the returned case ID) until the server adds real support.
- **Pagination:** `GET /api/cases` returns the caller's entire case list
  in one response — no cursor or offset parameters exist server-side.
  This SDK's `listCases()` reflects that as-is.

## Webhooks

Anchor signs webhook deliveries with HMAC-SHA256 over
`${timestamp}.${rawBody}`, using the org's per-webhook secret (see
`apps/web/src/lib/webhooks.ts`). Verify with:

```ts
import { verifyWebhookSignature } from "@anchor/sdk";

const ok = verifyWebhookSignature({
  rawBody, // exact request body bytes, not re-serialized JSON
  timestampHeader: req.headers.get("x-anchor-timestamp"),
  signatureHeader: req.headers.get("x-anchor-signature"),
  secret: process.env.ANCHOR_WEBHOOK_SECRET!,
});
```

Event vocabulary (`WEBHOOK_EVENTS` in `apps/web/src/lib/webhooks.ts`):
`case.status_changed`, `case.decided`, `case.appealed`,
`case.relay_dispatched`, `case.emergency_refund_prepared`,
`case.emergency_refund_settled`.

## Testnet environment

Anchor is testnet-only. Every settlement this API can produce runs on
Sepolia (EVM) or Solana devnet/testnet — `settlementChain` only accepts
`"sepolia"` or `"solanatestnet"`. There is no mainnet mode, no real
money moves, and no production deployment target for this codebase.
Label any UI or docs built on top of this SDK accordingly (e.g.
"TESTNET — no real value").

## Contract test

`test/contract.test.ts` asserts the SDK's request/response types stay
structurally compatible with what the real route handlers actually
accept and return, by calling the route handlers directly (this repo's
existing integration-test convention — see
`apps/web/tests/integration/*.test.ts`) against a local Postgres/Redis,
rather than importing Zod schemas (the routes validate manually; there
are none to import). See that file's own header for exactly what it
checks and how to run it.
