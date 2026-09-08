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
