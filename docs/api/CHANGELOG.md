# Anchor API changelog

Anchor is testnet-only — nothing in this changelog ever touched real
value. See `docs/api/README.md` and `packages/anchor-sdk/README.md`
for auth, error model, and scope details.

## 2026-09-08

First real changelog entry — Phase 5 wrap-up. Documents the current
API surface as of this date rather than every prior change.

### Routes covered by `@anchor/sdk` (`packages/anchor-sdk`)

- `POST /api/cases` — create a case (`cases:write`)
- `GET /api/cases` — list the caller's cases (`cases:read`)
- `GET /api/cases/:id` — read a case (`cases:read`)
- `POST /api/cases/:id/evidence` — submit evidence (`evidence:write`)
- `GET /api/org-policies` — read org policy configuration (`policies:read`)
- `GET /api/analytics?sinceDays=N` — dispute analytics (`analytics:read`)
- `GET /api/cases/:id/receipt?type=deposit|settlement` — case receipts (`cases:read`)
- `GET /api/cases/:id/statement?type=statement|proof-bundle` — case statements/proof bundles (`cases:read`)
- `GET /api/organizations/settlements/export?format=csv|json` — org settlement export (`settlements:export`)

### Not covered by `@anchor/sdk` (exist and work, called directly if needed)

`cases/:id/adjudicate`, `cases/:id/review`, `cases/:id/appeal`,
`cases/:id/party-tokens`, `cases/:id/settlement` (read + confirm-deposit),
`policies` (distinct from `org-policies`), `organizations/invoices`,
`organizations/usage`, `settlement-integrations`, `webhooks`,
`api-keys`, `members`, `invites`, `ops-console`,
`reconciliation-findings`.

### Scopes (`apps/web/src/lib/api-scopes.ts`)

`cases:read`, `cases:write`, `evidence:write`, `settlements:read`,
`settlements:write`, `settlements:export`, `analytics:read`,
`policies:read`, `organizations:read`. Pre-existing API keys with no
scopes recorded default to full access, as documented in
`docs/api/README.md`.

### New in this release

- `GET /api/status` — public, unauthenticated system status (component
  up/degraded/down, latest canary outcome, global incident history).
  Not part of `@anchor/sdk` — it carries no API surface an integrator
  authenticates against, just a status page backing endpoint.

## 2026-09-08 (developer experience)

- Added `packages/anchor-sdk-python` — a Python client mirroring
  `@anchor/sdk`'s route coverage 1:1 (cases, evidence, adjudication
  requests, org policies read, analytics, receipts/statements, org
  settlement export, webhook signature verification). Same honesty
  discipline as the TypeScript SDK: no fabricated idempotency or
  pagination. Depends on `requests`.
- Extended this file's neighbor, `docs/api/README.md`, with: a real
  webhook event-schema table (cited against
  `apps/web/src/lib/webhooks.ts`), an expanded error-code reference
  with real example bodies (cited against actual route handlers), an
  explicit idempotency-guidance section, and an embeddable widget
  quickstart matching `apps/web/src/app/public/widget/[id]/page.tsx`'s
  current `postMessage` behavior exactly.
- Added `docs/api/versioning-policy.md` — the API is currently
  unversioned (no `/v1/` prefix, no version header); the doc states
  that honestly and describes the intended policy for when versioning
  is introduced, rather than pretending it already exists.
