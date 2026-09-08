# Anchor API

Anchor is **testnet-only**. Every case created through this API settles
(if at all) on Sepolia or Solana devnet/testnet — there is no mainnet
mode, and nothing built here moves real value. Label anything built on
top of this API "TESTNET — no real value" the same way the dashboard
and public case page already do.

This document covers auth, the error model, rate limits, webhooks, the
embeddable widget, and versioning. For the full route list, see
`apps/web/src/app/api/**/route.ts` — this doc and the SDKs
(`packages/anchor-sdk/` for TypeScript, `packages/anchor-sdk-python/`
for Python) currently wrap a subset (case lifecycle + reporting); see
those packages' READMEs for exactly which routes.

**API versioning:** the API is currently unversioned (no `/v1/` prefix,
no version header). See `docs/api/versioning-policy.md` for what that
means today and what happens when real versioning is introduced.

## Quickstart

```bash
npm install # from apps/web, or wherever @anchor/sdk is a workspace dependency
```

```ts
import { AnchorClient } from "@anchor/sdk";

const client = new AnchorClient({
  baseUrl: "https://anchor-testnet.example.com",
  apiKey: process.env.ANCHOR_API_KEY!,
});

const created = await client.createCase({
  claim: "Package not delivered",
  amount: "1250.50",
  claimantRef: "claimant-pseudonym-1",
  respondentRef: "respondent-pseudonym-1",
});
```

Python integrators can use `packages/anchor-sdk-python` instead — same
route coverage, same field names (snake_case):

```bash
pip install -e packages/anchor-sdk-python
```

```python
from anchor_sdk import AnchorClient, CreateCaseRequest

client = AnchorClient(base_url="https://anchor-testnet.example.com", api_key=os.environ["ANCHOR_API_KEY"])
created = client.create_case(CreateCaseRequest(
    claim="Package not delivered",
    amount="1250.50",
    claimant_ref="claimant-pseudonym-1",
    respondent_ref="respondent-pseudonym-1",
))
```

See `packages/anchor-sdk-python/README.md` for the full method list and
an explicit parity table against the TypeScript SDK.

An API key is minted via `POST /api/api-keys` (dashboard-session
authenticated; see `apps/web/src/app/api/api-keys/route.ts`) and used
as `Authorization: Bearer ak_live_...` on every programmatic request
thereafter (see `apps/web/src/lib/auth.ts:getApiKeyAuth`).

## Auth

Two independent auth paths, both first-class (`resolveOrgFromRequest`
in `apps/web/src/lib/auth.ts`):

1. **API key** (`Authorization: Bearer ak_live_...`) — the
   agent/programmatic path. Scoped to one organization; optionally
   restricted to specific case IDs; optionally time-limited.
2. **Dashboard session cookie** — the human path. Additionally carries a
   role (`OWNER` / `MEMBER` / `VIEWER`); `VIEWER` is rejected on write
   routes.

As of Phase 5, API keys carry a real scope vocabulary
(`apps/web/src/lib/api-scopes.ts`'s `API_SCOPES`): `cases:read`,
`cases:write`, `evidence:write`, `settlements:read`,
`settlements:write`, `settlements:export`, `analytics:read`,
`policies:read`, `organizations:read`. A route calls `requireScope()`
with the scope it needs; a key missing that scope gets a 403. **Pre-
existing keys minted before scopes existed have no recorded scopes and
default to full access** — this default, not an enforced allowlist, is
what makes an older key able to call any route its org/case restriction
allows.

## Error model

Every non-2xx response body is `{ "error": "<message>", ...extra }` —
verified against the actual route handlers (e.g.
`apps/web/src/app/api/cases/route.ts`,
`apps/web/src/app/api/cases/[id]/adjudicate/route.ts`,
`apps/web/src/lib/auth.ts`'s `authErrorResponse`), not a generic guess.

| Status | Meaning | Real example body |
|---|---|---|
| 400 | Bad request body (missing/invalid field) | `{ "error": "claim, amount, claimantRef, respondentRef are required" }` (`api/cases/route.ts`); `{ "error": "missing required evidence", "missing": [...] }` (`api/cases/[id]/adjudicate/route.ts`) carries an extra field beyond `error` |
| 401 | Missing/invalid API key or session | `{ "error": "authentication required" }` (`authErrorResponse`) |
| 403 | Policy/role/scope block | risk `BLOCK`, a session `VIEWER` write attempt, an OWNER-only route called by a non-owner, or a key missing the required scope |
| 404 | Not found, or exists but not visible to this caller (deliberately indistinguishable) | `{ "error": "case not found" }` (`api/cases/[id]/route.ts`) |
| 409 | Conflicting state transition | `{ "error": "this case has no settlement binding" }` (`api/cases/[id]/emergency-refund/prepare/route.ts`) |
| 422 | Semantically invalid input that passed basic shape checks | `{ "error": "<validation message>" }` (`api/cases/[id]/emergency-refund/prepare/route.ts`, on a bad attestation) |
| 429 | Rate limited (see below) | `{ "error": "rate limit exceeded", "retryAfterSeconds": <n> }` |
| 502 | Upstream/chain verification failure | `{ "error": "could not verify escrow version: <detail>" }` (`api/cases/[id]/emergency-refund/prepare/route.ts`) |

Do not pattern-match only on status code — several routes attach
extra fields alongside `error` (e.g. `missing`, `retryAfterSeconds`);
both SDKs surface the full parsed body on `AnchorApiError.body` /
`AnchorApiError.body` rather than just the message string, specifically
so callers can read those extra fields.

## Idempotency

`POST /api/cases` has **no server-side idempotency-key mechanism** —
no `Idempotency-Key` header is read anywhere in
`apps/web/src/app/api/cases/route.ts`. A client-side retry after a
network error or 5xx can create a duplicate case. Neither SDK fabricates
idempotency on top of this; if you need it, dedupe on your own side
(e.g. store your own reference ID alongside the returned case ID and
check for an existing case with that reference before retrying a
create).

## Rate limits

API-key callers: **120 requests/minute per key**, Redis-backed fixed
window (`apps/web/src/lib/auth.ts:checkApiKeyRateLimit`). A 429 carries
a `Retry-After` header (seconds) and
`{ "error": "rate limit exceeded", "retryAfterSeconds": <n> }`. Session
(dashboard) callers are not rate-limited by this mechanism.

## Webhooks

Every webhook delivery is a `POST` to your registered URL with:

- Headers: `Content-Type: application/json`, `X-Anchor-Event: <event>`,
  `X-Anchor-Timestamp: <unix seconds>`,
  `X-Anchor-Signature: sha256=<hex hmac>`.
- Body (verified against `dispatchWebhookEvent`/`deliverWebhookAttempt`
  in `apps/web/src/lib/webhooks.ts`):
  ```json
  { "event": "<event name>", "createdAt": "<ISO 8601>", "data": { /* event-specific */ } }
  ```

**Signature verification:** HMAC-SHA256 over `${timestamp}.${rawBody}`
using the org's per-webhook secret, compared with a constant-time
check. Use the raw, unparsed request body — re-serializing JSON before
verifying will produce a different signature. Both SDKs ship a helper:

```ts
// TypeScript — packages/anchor-sdk
import { verifyWebhookSignature } from "@anchor/sdk";
verifyWebhookSignature({ rawBody, timestampHeader, signatureHeader, secret });
```

```python
# Python — packages/anchor-sdk-python
from anchor_sdk import verify_webhook_signature
verify_webhook_signature(raw_body, timestamp_header, signature_header, secret)
```

Both reject deliveries whose timestamp is more than 300 seconds old by
default (replay protection) — pass a different `toleranceSeconds`/
`tolerance_seconds` to change that.

**Event schemas** (`WEBHOOK_EVENTS` in `apps/web/src/lib/webhooks.ts`).
`data` is whatever the call site passes to `dispatchWebhookEvent` at
each firing point — the fields below are what those call sites actually
send today (grep `dispatchWebhookEvent(` under `apps/web/src` to
re-derive if this list needs updating; there is no shared Zod/pydantic
schema to import from, same manual-sync caveat as the SDKs' own types):

| Event | Fires when | `data` shape (typical fields) |
|---|---|---|
| `case.status_changed` | A case's `status` column changes (any transition) | `{ caseId, status, previousStatus }` — a status transition on the underlying `CaseRecord` |
| `case.decided` | Adjudication produces a decision | `{ caseId, decision, ... }` — the adjudication outcome recorded on the case |
| `case.appealed` | A party files an appeal within the appeal window | `{ caseId, ... }` — appeal filing details |
| `case.relay_dispatched` | An on-chain decision relay transaction is dispatched | `{ caseId, chain, txHash, ... }` — settlement-relay dispatch details |
| `case.emergency_refund_prepared` | `POST /api/cases/:id/emergency-refund/prepare` is called, **including ineligible calls** (no deposit found, timeout not elapsed) — this event does not mean the refund is guaranteed, only that a prepare attempt happened | `{ caseId, ... }` — prepare-attempt details |
| `case.emergency_refund_settled` | `checkEmergencyRefundsSettled` (in `apps/web/src/lib/reconciliation.ts`) observes the prepared refund actually settle on-chain | `{ caseId, ... }` — settlement confirmation details |

Anchor does **not** hold party email addresses (only opaque
`claimantRef`/`respondentRef` strings and payout addresses) — there is
no per-party email notification. What's real is notifying the
**organization's own registered webhook subscribers**, who are expected
to relay this to their respondent through whatever channel they already
use. Treat the field lists above as "known fields, not an exhaustive
contract" — a subscriber should tolerate additional fields appearing in
`data` without breaking.

A durable `WebhookDelivery` row is recorded for every attempt
(including ones still pending BullMQ retry), with up to 5 attempts and
exponential backoff on failure (non-2xx or network error) — see
`deliverWebhookAttempt` in `apps/web/src/lib/webhooks.ts`.

## Embeddable widget quickstart

`apps/web/src/app/public/widget/[id]/page.tsx` renders a chrome-free,
iframe-friendly view of a single case (no wordmark, no wallet/private-
key/chain selector — same `CasePanel` component the full public case
page uses, just `embed={true}`). Embed it directly:

```html
<iframe
  id="anchor-case"
  src="https://<host>/public/widget/<caseId>?token=<partyToken>"
  style="width:100%;border:0"
  title="Anchor case"
></iframe>
<script>
  window.addEventListener("message", (e) => {
    if (e.data && e.data.source === "anchor-widget" && e.data.type === "resize") {
      document.getElementById("anchor-case").style.height = e.data.height + "px";
    }
  });
</script>
```

The widget posts `{ source: "anchor-widget", type: "resize", height: <number> }`
to `window.parent` on load, on every `ResizeObserver` change to its
container, and on window resize — so the host page never has to guess
or hardcode an iframe height. `token` is a party token (claimant or
respondent) obtained from `POST /api/cases` (shown once, at creation)
or `POST /api/cases/:id/party-tokens`; it authenticates the embedded
view the same way it authenticates the full public case page.

This route intentionally exposes strictly less than the dashboard/API:
read-only case status and evidence, no settlement controls, no wallet
UI. Treat it as display-only.

