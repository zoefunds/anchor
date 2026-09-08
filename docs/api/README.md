# Anchor API

Anchor is **testnet-only**. Every case created through this API settles
(if at all) on Sepolia or Solana devnet/testnet — there is no mainnet
mode, and nothing built here moves real value. Label anything built on
top of this API "TESTNET — no real value" the same way the dashboard
and public case page already do.

This document covers auth, the error model, rate limits, and a
quickstart. For the full route list, see
`apps/web/src/app/api/**/route.ts` — this doc and the SDK
(`packages/anchor-sdk/`) currently wrap a subset (case lifecycle +
reporting); see that package's README for exactly which routes.

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

There is no API-key scope/permission system today beyond org and
optional case restriction — an unexpired, unrevoked key can call any
route its org/case restriction allows, both reads and writes.

## Error model

Every non-2xx response body is `{ "error": "<message>", ...extra }`.

| Status | Meaning |
|---|---|
| 400 | Bad request body |
| 401 | Missing/invalid API key or session |
| 403 | Policy/role block (risk `BLOCK`, session `VIEWER` write attempt, OWNER-only route) |
| 404 | Not found, or exists but not visible to this caller (deliberately indistinguishable) |
| 409 | Conflicting state transition |
| 429 | Rate limited (see below) |

## Rate limits

API-key callers: **120 requests/minute per key**, Redis-backed fixed
window (`apps/web/src/lib/auth.ts:checkApiKeyRateLimit`). A 429 carries
a `Retry-After` header (seconds) and
`{ "error": "rate limit exceeded", "retryAfterSeconds": <n> }`. Session
(dashboard) callers are not rate-limited by this mechanism.

## Webhooks

See `packages/anchor-sdk/README.md`'s Webhooks section — the signing
scheme (HMAC-SHA256 over `timestamp.body`) and event vocabulary are
documented there in full, matching `apps/web/src/lib/webhooks.ts`
exactly.

