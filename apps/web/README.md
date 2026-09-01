# apps/web

The Next.js app: API routes, dashboard UI, Postgres via Prisma, BullMQ
job queue, and all settlement-dispatch logic. See the root `README.md`
for the full architecture, security model, live addresses, and
environment variable reference — this file is just a map of `src/`.

## `src/lib/` — the actual business logic

- **`adjudication-service.ts`** — the adjudication pipeline: runs a case
  through GenLayer (`runAdjudicationJob`), computes `computeDecisionHash`,
  finalizes expired appeal windows, and dispatches settlement
  (`dispatchSettlementForDecision`, `retryFailedSettlements`).
- **`appeal-service.ts`** — appeal submission and the atomic
  case-update + audit-log transaction behind it.
- **`genlayer.ts`** — wraps `@anchor/genlayer-sdk` with Anchor-specific
  contract-source hashing and evidence-URL signing.
- **`hyperlane.ts`** — EVM settlement dispatch: computes attestation
  hashes, signs with backend-held `ATTESTOR_PRIVATE_KEYS`, throws
  `InsufficientAttestorSignaturesError` when threshold isn't met,
  reconciles against the destination contract's own `processedDecisions`
  state before ever sending a transaction.
- **`solana-settle.ts`** — Solana settlement dispatch: builds the
  versioned (Address Lookup Table–based) transaction containing Ed25519
  verify instructions + `AttestedSettle`, submitted directly (not via
  Hyperlane).
- **`audit.ts`** — the tamper-evident audit-log hash chain
  (`logAction`, `verifyAuditChain`), with per-organization advisory-lock
  serialization to prevent concurrent writes from forking the chain.
- **`audit-anchor.ts`** — the periodic sweep posting each organization's
  audit-chain head to `AuditAnchor.sol` on Sepolia, plus the
  missed-anchor alert.
- **`internal-auth.ts`** — bearer-secret auth for platform-level
  (non-org-scoped) internal routes, currently just the M-of-N
  co-signing endpoints.
- **`auth.ts`**, **`party-auth.ts`**, **`party-signing.ts`** — dashboard
  session auth, API key auth, and per-case party capability tokens
  (claimant/respondent access without a full org session).
- **`webhooks.ts`** — outbound webhook delivery with retries.
- **`pii-redaction.ts`**, **`evidence-validation.ts`**,
  **`ssrf-guard.ts`** — evidence-handling safety: structured PII
  redaction before evidence reaches GenLayer, evidence-type/size
  validation, and SSRF protection on any URL the backend fetches on a
  caller's behalf.
- **`queue.ts`**, **`jobs.ts`**, **`worker.ts`** — BullMQ setup, job
  enqueueing, and the actual Worker process (shared between the
  in-process dev-server worker and the standalone `npm run worker`
  process — see `src/worker.ts`'s own header comment for which is
  which).
- **`app-env.ts`** — the `APP_ENV` guard preventing a worker process
  from accidentally consuming jobs meant for a different environment.
- **`prisma.ts`**, **`storage.ts`**, **`case-access.ts`**, **`policies.ts`**,
  **`email.ts`**, **`genlayer-rate-limit.ts`**, **`pdf-extract.ts`** —
  supporting infrastructure (DB client, Cloudinary evidence storage,
  case visibility rules, policy registry, Brevo email, GenLayer API
  rate limiting, PDF text extraction for evidence).

## `src/app/api/` — routes

- **`cases/`** — case CRUD, adjudicate, appeal, access control, party
  tokens.
- **`public/cases/`** — the party-token-authenticated public surface
  (no org session needed) for claimants/respondents.
- **`internal/`** — platform-level routes not scoped to any
  organization: `pending-attestations` (the M-of-N co-signing API —
  see root README's "Co-signing" section).
- **`members/`**, **`invites/`**, **`auth/`** — org membership and
  dashboard auth.
- **`api-keys/`**, **`webhooks/`** — programmatic-access credentials and
  webhook subscriptions.
- **`policies/`** — read-only policy listing.
- **`audit-log/`** — audit-chain read/verify endpoint.

## Running it

See the root `README.md`'s "Local development" and "Testing" sections —
this file doesn't repeat those to avoid the two drifting apart.
