# UNDETERMINED cases had no working recovery path — 2026-09-18

## Summary

A case that lands on `UNDETERMINED` (GenLayer consensus not reached, or the
adjudication job itself failed) had exactly one recovery path on either
chain: `emergencyRefund()`, which pays 100% back to the claimant. There was
no way to get a real second verdict. Investigating that surfaced three
separate, real gaps — one design gap and two implementation bugs — all now
fixed and verified end-to-end on both Sepolia and Solana Devnet.

## Gap 1: no re-adjudication path at all

`POST /api/cases/:id/adjudicate` hard-requires `status === "EVIDENCE_COLLECTION"`.
Once a case reaches `UNDETERMINED` there was no instruction, button, or API
call that ever moves it back — a deliberate design choice (`UNDETERMINED`
meant "GenLayer genuinely couldn't decide, stop here"), not a bug, but one
that left `emergencyRefund()` as the only way forward even when better
evidence or a corrected submission might get a real decision.

**Fix**: `POST /api/cases/:id/reopen` (OWNER-only), capped at exactly one
use per case via `Case.reopenedFromUndeterminedAt` (a timestamp, not a
counter — a case that goes `UNDETERMINED` a second time after a real
re-adjudication attempt still falls back to `emergencyRefund()` rather than
looping indefinitely). See `apps/web/src/app/api/cases/[id]/reopen/route.ts`
and the case-detail page's "Reopen for adjudication (one-time)" button.

## Gap 2: Solana's escrow had no `emergency_refund` instruction, and its Config PDA was never initialized

The Solana `escrow`/`decision-relay` programs had no on-chain
`emergency_refund` path at all — added in this pass, mirroring EVM's
`Escrow.sol emergencyRefund()` exactly (adjudicator-only CPI boundary, real
on-chain `deposited_at` timeout, always 100% to claimant). Devnet's escrow
`Config` PDA (required by every `emergency_refund` call) had also never been
initialized — before this pass, the instruction could not have succeeded on
Devnet regardless of code correctness.

**Fix**: both programs upgraded on Devnet (same program IDs,
`825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn` /
`DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN`), `Config` initialized with a
1-hour timeout. Proven end-to-end against the real, unmodified production
escrow program using a throwaway 2-of-2 `test-attestors` build of
decision-relay (production attestor keys never touch this — see
`chains/solana/tests/run-emergency-refund-devnet-e2e.ts`): deposit → confirm
pre-timeout rejection → wait → real 2-of-3-equivalent attested
`emergency_refund` → verified claimant balance delta and `Case.status`.

### Sub-bug: `migrate_case_deposited_at` wrote to the wrong byte offset

Every Case account deposited before the above upgrade is 8 bytes short of
the current struct size (`deposited_at` didn't exist yet), which made
Anchor's typed `Account<'info, Case>` fail outright on those accounts —
`emergency_refund` would revert on every pre-upgrade case regardless of
timeout. `migrate_case_deposited_at` was added to fix this, but its first
version wrote the backfilled `deposited_at` to the physical tail of the
account buffer (`old_len..new_len`), wrongly assuming the buffer's real
content ended there. It doesn't: every Case account (old and new) is
allocated at `Case::MAX_SIZE`, sized for the worst-case `MAX_CASE_ID_LEN`
regardless of the actual case_id used, so for any shorter case_id the real
Borsh-serialized content — and therefore where Anchor's decoder actually
reads `deposited_at` from — ends well before the buffer's physical end.
Both already-migrated real cases (`Case-2`, `CASE-RELAY-2`) still decoded
`deposited_at` as `0` after the first migration run.

**Fix**: the instruction now computes the real offset from the case_id
length stored in the account's own data (`8 + 4 + case_id_len + 96 + 8 + 1 +
1`, right after `bump`), verified against real captured on-chain bytes via
Anchor's own `BorshAccountsCoder` before redeploying. Both real cases
corrected and reverified — `deposited_at` now decodes correctly and both
are genuinely `emergency_refund`-eligible (confirmed `now >= depositedAt +
config.emergencyRefundTimeoutSeconds` on-chain).

## Gap 3: Sepolia's escrow had a 30-day emergency-refund timeout

Not a bug — `emergencyRefundTimeoutSeconds` is `immutable` by design (see
`Escrow.sol`) — but 30 days made the escape hatch impractical to exercise or
rely on for anything but a genuine long-term stuck case.

**Fix**: new escrow deployed (`0x8634d8131dE3F16A33125266A2301DcBb72F30d7`,
same `DecisionRelay` reused as-is, `0x56bf62F9F4C2C316D956F9C35DD1B15BE5ae9834`)
with a 1-hour timeout. `deployment-registry.ts`'s `ACTIVE_SEPOLIA_TOPOLOGY`
updated; the old escrow retired to `RETIRED_SEPOLIA_ADDRESSES.escrowPreOneHourTimeout`
— see that field's own doc comment for why it is not pure history if it
holds an unsettled deposit. Proven end-to-end against the real, unmodified
production `Escrow.sol`/`DecisionRelay.sol` bytecode using a throwaway 2-of-2
attestor set and a disposable deploy (`chains/evm/scripts/test-emergency-refund-sepolia-e2e.sh`):
deposit → confirm pre-timeout revert → wait → real 2-of-2 ECDSA-attested
`emergencyRefund` → verified exact balance delta and `Deposit.status`.

## Real cases affected

Checked every `UNDETERMINED` case in the database against on-chain state
(2026-09-18): of 9 total, 6 had no on-chain funds at risk (no settlement
chain configured, or deposit never confirmed). Three had real deposits:

| Case | Chain | Status after this pass |
|---|---|---|
| `Case-2` | Solana Devnet | Migrated, fixed, verified `emergency_refund`-eligible now |
| `CASE-RELAY-2` | Solana Devnet | Migrated, fixed, verified `emergency_refund`-eligible now |
| Sepolia case (`cmu5r00t6...`) | Sepolia, old escrow (`0x5a7a2F33...`) | Still bound to that escrow's own 30-day timeout (deposited 2026-09-17, eligible ~2026-10-17) — unaffected by the new 1-hour escrow, since the deposit already happened on the old contract |

## Also fixed in passing

Settlement-integrations "Add an integration" form (`apps/web/src/app/settings/settlement-integrations/page.tsx`):
switching the chain dropdown never cleared `escrowContractAddress`/
`decisionRelayAddress`, so autofilling Solana's addresses and then switching
to Sepolia left Solana base58 program IDs sitting under a "Sepolia (EVM)"
label. Fixed by clearing both fields on every chain change.
