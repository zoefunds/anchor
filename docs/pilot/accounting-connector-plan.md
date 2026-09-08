# Accounting integration plan (Track 5, item 4)

## Decision: CSV-with-stable-schema now, one real connector later

Anchor ships a stable, versioned CSV/JSON settlements export today (see
`docs/api/csv-export-schema.md`) with a deterministic `reconciliationId`
per row. **No QuickBooks, Xero, or NetSuite connector is built as part
of this track**, and none should be built until a real design partner
has chosen one.

## Why not build all three (or any) speculatively

- Anchor currently has zero live design-partner integrations with any
  accounting system. Building a connector without a real counterparty
  to validate it against means guessing at auth flows, chart-of-accounts
  mapping conventions, and error-handling expectations that differ
  meaningfully between QuickBooks Online's REST API, Xero's OAuth2 +
  webhook model, and NetSuite's SuiteTalk/RESTlet surface — three
  genuinely different integration shapes, not one connector with three
  skins.
- Each of the three has its own OAuth app review process, sandbox
  account requirements, and ongoing API-version maintenance burden.
  Maintaining three speculative connectors triples that ongoing cost
  for a testnet-only product with no confirmed pilot customer need yet.
- The CSV/JSON export already lets any design partner reconcile today,
  by hand or via their own lightweight import script, using
  `reconciliationId` as the dedup key — this is a real, functioning
  reconciliation path, not a placeholder waiting on a connector.

## What actually triggers building a connector

1. A design partner signs on with commercial terms (see
   `docs/pilot/design-partner-package` and related Track 4 artifacts).
2. That partner names the specific accounting tool they actually use.
3. Anchor builds **one** direct connector for that tool, scoped to what
   that partner's workflow actually needs (e.g. push settlement rows as
   journal entries or bills, keyed by `reconciliationId` for
   idempotency) — not a generic multi-tenant "accounting integrations"
   platform speculatively covering tools no confirmed customer uses.
4. A second connector is only justified once a second design partner
   with a different tool and confirmed commercial terms exists — same
   reasoning, applied again, not front-loaded.

## Out of scope for this track (explicitly)

- Any QuickBooks, Xero, or NetSuite OAuth app registration or API
  client code.
- Any generic "accounting adapter" abstraction layer built ahead of a
  second real connector needing it — that abstraction should be
  extracted from two real connectors' actual shared code, not designed
  up front from guesses about what they'll have in common.
