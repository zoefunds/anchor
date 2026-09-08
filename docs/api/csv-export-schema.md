# Settlements CSV/JSON export schema

Schema version: **1.1** (adds `reconciliation_id` / `decision_id`; see
Changelog below). Source of truth: `buildSettlementsCsv` and
`buildReconciliationExport` in `apps/web/src/lib/receipts.ts`, exposed via
`GET /api/organizations/settlements/export?format=csv|json`
(`apps/web/src/app/api/organizations/settlements/export/route.ts`).

One row / array entry per `CaseSettlement`, ordered by `createdAt` ascending.

## Stability guarantee

- Column **order and names** are a stable public contract once shipped.
  A new column may be appended to the end of the CSV header (additive,
  non-breaking). Renaming, removing, retyping, or reordering an existing
  column is a breaking change and must bump the version above.
- `reconciliation_id` is **deterministic**: recomputing it from the same
  `case_id` + `decision_id` + settlement tx hash always yields the same
  value (sha256 of the pipe-joined triple, truncated to 32 hex chars —
  see `computeReconciliationId` in `receipts.ts`). It is stable across
  repeated exports of the same period and safe to use as an
  idempotency/dedup key when importing into an external ledger.
- Every numeric amount is exported both as a raw atomic-unit integer
  string (`expected_amount_atto`, never a JS number, to avoid precision
  loss) and a human-decimal string (`expected_amount_human`) — see
  `asset_decimals`/`asset_is_token` for how to interpret them correctly.

## CSV columns

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | `reconciliation_id` | string (32 hex chars) | Deterministic idempotency key — see above. |
| 2 | `case_id` | string | Anchor's internal case id. |
| 3 | `decision_id` | string (nullable) | The most recent Decision bound to this case, empty string if none. |
| 4 | `policy_version_id` | string (nullable) | The immutable PolicyVersion this case was bound to at creation. |
| 5 | `status` | string | `CaseSettlement.status` enum value. |
| 6 | `chain` | string | `sepolia` \| `solanatestnet`. |
| 7 | `asset_symbol` | string | e.g. `USDC`, `ETH`, `SOL`. |
| 8 | `asset_is_token` | `"true"` \| `"false"` | `true` for an ERC-20/SPL token (has `token_address`), `false` for a native asset. |
| 9 | `token_address` | string (nullable) | Empty for a native asset. |
| 10 | `asset_decimals` | number | Required to interpret `expected_amount_atto` — do not assume 18 or 6. |
| 11 | `expected_amount_atto` | string (integer) | Raw atomic-unit amount, exact — never parse as a float. |
| 12 | `expected_amount_human` | string | Decimal-formatted per `asset_decimals`, for display only. |
| 13 | `deposit_tx_hash` | string (nullable) | |
| 14 | `deposit_confirmed_at` | ISO 8601 (nullable) | |
| 15 | `settled_tx_hash` | string (nullable) | |
| 16 | `settled_at` | ISO 8601 (nullable) | |
| 17 | `case_amount` | string | The case's own claimed amount, in `case_currency` — independent of the settlement asset (e.g. a USD-denominated case settled in USDC). |
| 18 | `case_currency` | string | ISO currency code for `case_amount`. |

**Do not sum `expected_amount_atto` across rows with different
`asset_symbol` values** — different assets have different decimals and
units; group by `asset_symbol` (or `asset_is_token` + `token_address`)
before aggregating.

## JSON export (`?format=json`)

Same underlying rows, plus the organization's audit-anchor hash-chain
tail (`auditAnchor: { lastAnchoredHash, lastAnchoredAt, lastAnchorTxHash }`)
for independently verifying the export wasn't tampered with after
generation. Each entry carries `reconciliationId`, `decisionId`,
`decisionHash` (the full decision-content fingerprint, not just the tx
hash) in addition to the CSV's fields, structured rather than
flattened (`asset` is a nested object).

## Changelog

- **1.1** (Track 5, item 4): added `reconciliation_id` (CSV col 1, JSON
  `reconciliationId`) and `decision_id` (CSV col 3, JSON `decisionId`).
  Prior to this version, a design partner had no stable per-row key to
  dedupe against on re-import, and no way to join a settlement row back
  to the specific Decision that produced it without a separate API call.
- **1.0**: initial export (Phase 4).
