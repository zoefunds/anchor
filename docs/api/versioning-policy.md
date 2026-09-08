# API versioning and deprecation policy

## Current state: unversioned

As of this writing, Anchor's API has **no version identifier at all**:

- No `/v1/` (or any `/vN/`) path prefix — every route lives directly
  under `/api/...` (`apps/web/src/app/api/**/route.ts`).
- No version request header (checked: no route reads or requires an
  `Api-Version`/`X-Api-Version`-style header; `apps/web/src/lib/auth.ts`
  and the individual route handlers were grepped for this and found
  nothing).
- No version field in any response body.

This document is written to be honest about that rather than describe
a versioning scheme that doesn't exist yet. If you're integrating
today: you are integrating against "the API as it currently behaves,"
full stop — there is no `v1` to pin to and no way to opt into or out of
a specific version.

## What this means for you today

- **Breaking changes are possible without a version bump**, because
  there's no version to bump. `docs/api/CHANGELOG.md` is the actual
  source of truth for what changed and when — read it, don't assume
  stability an unversioned API hasn't promised.
- A real example of the kind of breaking change that can land this way:
  `POST /api/cases`'s `amount` field used to accept precision-losing
  JSON numeric literals; it now requires a decimal string and rejects a
  JSON number with a 400. That shipped as a behavior change to the
  existing route, not a new `v2` route.
- The webhook event vocabulary
  (`apps/web/src/lib/webhooks.ts`'s `WEBHOOK_EVENTS`) and the API-key
  scope vocabulary (`apps/web/src/lib/api-scopes.ts`'s `API_SCOPES`)
  are both append-only in practice so far, but neither is contractually
  guaranteed stable by a version marker — same caveat applies.

## What happens when versioning is introduced

This is a statement of intent for when (not if — the surface is growing
past what an unversioned API can responsibly keep changing under
integrators) real versioning is added, not a description of something
already built:

1. **Path-based versioning**, matching the most common convention for
   REST APIs of this shape: new routes would appear under `/api/v1/...`
   while the current unversioned `/api/...` paths continue to work,
   frozen at their current behavior, for a defined deprecation window.
2. **The deprecation window** for any endpoint slated for removal would
   be a minimum of 90 days from the date it's first marked deprecated
   in `docs/api/CHANGELOG.md`, with a `Deprecation` response header
   (RFC 8594-style) added to the deprecated endpoint's responses during
   that window so automated clients can detect it without reading docs.
3. **No silent breaking changes to a versioned endpoint.** Once `v1`
   exists, a breaking change to a `v1` route ships as `v2` (or a new
   route), not as an in-place behavior change — the in-place changes
   this document describes above are exactly what versioning is meant
   to stop.
4. **The unversioned `/api/...` paths would be treated as an implicit
   "current" alias** during any transition period, but new integrations
   would be steered toward the explicit version path via docs and the
   SDK's default `baseUrl`/`base_url` guidance.
5. **SDK alignment:** both `packages/anchor-sdk` (TypeScript) and
   `packages/anchor-sdk-python` (Python) would gain a version-pinned
   release cadence once server-side versioning exists — today, both
   SDKs simply track whatever `/api/...` currently does, released
   without semantic versioning guarantees of their own beyond normal
   npm/PyPI package versions.

## Practical guidance until then

- Watch `docs/api/CHANGELOG.md` — it's the only changelog that exists.
- Don't assume a route's request/response shape is frozen; validate
  defensively (both SDKs already do this — `AnchorApiError`/
  `AnchorApiError` surface the real response body on any failure rather
  than assuming a fixed shape).
- If you need contractual stability before real versioning ships, pin
  to a specific commit/tag of this repository's routes rather than
  relying on an implicit "the API won't change" assumption this
  document explicitly does not make.
