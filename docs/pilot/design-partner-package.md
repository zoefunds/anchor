# Anchor design-partner pilot package

TESTNET ONLY. Read this whole document before integrating — it defines
exactly what a pilot is, and (just as important) what it explicitly is not.

## What this pilot is, and is not

- **No customer funds.** Anchor on this pilot runs against Sepolia
  (EVM) and/or a Solana testnet cluster only. Every asset moved during
  the pilot is testnet-only and has no real-world value. Do not point
  a pilot integration at any mainnet contract, mainnet RPC endpoint, or
  real payment processor. See `docs/mainnet-readiness-gate.md` for what
  is actually gating a future mainnet launch — this pilot does not
  cross that gate.
- **No production SLA.** There is no uptime commitment, no incident
  response SLA, and no guaranteed data-retention window. The reliability
  observation window described in `docs/reliability-observation-window.md`
  is an internal measurement exercise, not a service-level agreement
  offered to pilot partners.
- **No legal dispute-resolution or arbitration claim.** Anchor's
  decision engine and attestor flow produce a recorded, hash-verifiable
  *outcome* for a simulated dispute. That outcome is not a legally
  binding arbitration award, is not enforceable in any court or
  arbitral forum, and does not substitute for a real dispute-resolution
  clause in the design partner's own terms of service. See
  `docs/regulated-fintech-prerequisites.md` for the (unresolved,
  counsel-requiring) legal/custody questions this depends on.
- This pilot package is scoped to **one use case: marketplace delivery
  disputes** (buyer says "item not delivered / not as described",
  seller disputes the claim, marketplace wants a neutral recorded
  resolution). Other dispute types are out of scope for this pilot;
  ask your Anchor contact before generalizing.

## Onboarding checklist

1. **Create an org.** Sign up in the Anchor dashboard and create an
   organization — this is the unit that owns API keys, webhooks, and
   policies.
2. **Generate a scoped API key.** Dashboard → Settings → API Keys →
   New Key (`apps/web/src/app/api/api-keys/route.ts`). Notes on what's
   real today:
   - Key management is OWNER-role-only and dashboard-session-only — an
     API key cannot mint another API key.
   - Keys default to a 90-day expiry; pass `expiresInDays: null`
     explicitly if you want a non-expiring key (not recommended for a
     pilot — rotate on the default schedule instead).
   - You can pass `scopes` (see `apps/web/src/lib/api-scopes.ts`) to
     restrict the key to only the routes your integration needs, and
     `restrictedToCaseIds` to scope a key to specific cases (useful for
     a sample-case walkthrough key you hand to a third party).
   - The raw key is shown once, at creation. Store it in your own
     secrets manager — Anchor does not display it again.
3. **Configure one policy.** Dashboard → Settings → Policy Engine
   (`apps/web/src/app/api/org-policies` / `apps/web/src/app/api/policies`).
   For the marketplace-delivery-dispute use case, a minimal policy
   needs: an evidence window, a decision rule set, and — if you're
   testing the real KYC-gate integration from this session's prior
   work — `kycRequired` set according to whether you want the pilot's
   sample cases to exercise that path.
4. **Run one sample case end-to-end.** Use
   `apps/web/scripts/seed-pilot-sample-cases.ts` (see below) to create
   a handful of realistic marketplace-delivery-dispute cases against
   your own org via the real API, then open them in the dashboard to
   see intake → evidence → decision → (optionally) appeal → settlement.
5. **Subscribe to webhooks.** Dashboard → Settings → Webhooks
   (`apps/web/src/app/api/webhooks/route.ts`), OWNER-only. Point it at
   an endpoint you control and pick from the real event set — see
   `docs/api/README.md`'s webhook reference for the exact event names,
   payload shape, and signature-verification scheme
   (`apps/web/src/lib/webhooks.ts`).

## Supported API/webhook workflow (marketplace delivery disputes)

1. Marketplace's backend calls `POST /api/cases` when a buyer opens a
   delivery dispute, using the claimant/respondent references your
   system already has (Anchor does not store real names/emails — see
   the PII note below).
2. Both sides submit evidence via `POST /api/cases/[id]/evidence`
   (photos, tracking numbers, messages — whatever your policy's
   evidence window accepts) before the window closes.
3. The decision engine (or human review queue, depending on policy)
   produces a decision; your webhook receives `case.decided`.
4. If either side disputes the outcome, `POST /api/cases/[id]/appeal`
   fires `case.appealed`.
5. If the policy triggers a testnet settlement, your webhook receives
   the relay/settlement events (`case.relay_dispatched`,
   `case.emergency_refund_prepared`/`case.emergency_refund_settled`
   for the refund path).
6. Pull the human-readable case statement (`GET
   /api/cases/[id]/statement`) and machine-readable receipt (`GET
   /api/cases/[id]/receipt`) for your own records — see the PDF variants
   added in this track for a shareable document form.

## Sandbox credentials

Anchor does not run a separate credential-provisioning system for
pilots — a "sandbox credential" is a real API key (above) scoped to
your org, used against the real (testnet-only) deployment. To fund
testnet activity yourself:

- **Sepolia ETH**: use a public Sepolia faucet (e.g. the one listed at
  `https://sepoliafaucet.com` or your RPC provider's own faucet — Anchor
  does not operate a faucet itself).
- **Solana testnet SOL**: `solana airdrop` against `https://api.testnet.solana.com`,
  or the public web faucet at `https://faucet.solana.com` (select
  "Testnet").

Neither faucet involves real value; do not send real funds to any
address used in this pilot.

## Sample cases and test data

`apps/web/scripts/seed-pilot-sample-cases.ts` creates a small set of
realistic marketplace-delivery-dispute cases (buyer claims non-delivery,
seller disputes with a tracking number, one case with an appeal) in a
target org via the real `POST /api/cases` / evidence / adjudicate API —
not test fixtures baked into the test suite. Run it once per new pilot
org so the org's dashboard has real, inspectable data from day one:

```
ANCHOR_API_BASE_URL=http://localhost:3000 \
ANCHOR_API_KEY=ak_live_your_pilot_key \
npx tsx apps/web/scripts/seed-pilot-sample-cases.ts
```

## Support channel and feedback process

- **Support channel**: the design-partner's assigned Anchor contact
  (named at pilot kickoff) via email or the shared Slack/Discord
  channel set up per partner — there is no ticketing system in this
  codebase to point to, so this is a real named-human channel, not a
  product feature.
- **Feedback process**: weekly async check-in (email or the shared
  channel above) covering integration blockers, API/webhook gaps found,
  and any documentation errors — file documentation/API bugs the same
  way you'd file any other bug against this repo. There is no in-app
  feedback widget in this pilot.
- **Escalation**: for anything security-relevant, follow the same
  escalation path as `docs/ops-alert-escalation.md`; pilots do not get
  a different (faster) security escalation path than production.

## PII discipline

Anchor's case model stores opaque claimant/respondent references and
on-chain addresses, not names, emails, or physical addresses. Do not
push your marketplace's real customer PII (legal name, email, physical
address, payment instrument) into any Anchor field, especially
`claimantRef`/`respondentRef` or evidence text — those fields are only
one hop from webhook payloads and public verification pages. Keep the
mapping between an Anchor case ID and your own customer identity in
your own system.
