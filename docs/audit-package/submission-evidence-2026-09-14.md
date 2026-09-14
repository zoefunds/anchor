# Submission evidence index — 2026-09-14

Produced in response to an external re-review of the 2026-09-14 Solana
Devnet migration work. Collects, in one dated place, exactly what was
run and verified before submitting Anchor as a testnet prototype, and
what the submission should and should not claim. See
`docs/incidents/2026-09-14-solana-devnet-migration.md` for the full
narrative this evidence supports.

## What to say in a submission

> Anchor is a testnet adjudication-as-a-service prototype. GenLayer
> produces appealable, evidence-bound decisions. Sepolia and Solana
> payouts use independent 2-of-3 attestor-authorized direct settlement,
> preventing same-chain funds from depending on Hyperlane delivery.
> Hyperlane is retained as an asynchronous notification/audit channel.
> Sepolia self-loop transport is intentionally not used for payout
> because it was not proven supported.

## What NOT to say

- "Hyperlane currently delivers all settlements end to end."
- "Cross-chain delivery is proven on both Sepolia and Solana."
- "Ready for mainnet/customer funds."
- "Validators are required for every payout."

## Test suite results (this pass)

| Suite | Command | Result |
|---|---|---|
| EVM contracts | `cd chains/evm && forge test` | 112/112 passed, 0 failed |
| Solana decision-relay | `cd chains/solana && cargo test -p decision-relay` | 12/12 passed, 0 failed |
| Solana escrow | `cd chains/solana && cargo test -p escrow` | 1/1 passed, 0 failed |
| TypeScript (app) | `cd apps/web && npx tsc --noEmit -p tsconfig.json` | 0 errors outside `tests/` (pre-existing implicit-`any`/Prisma-type noise in test files only, unrelated to this pass's changes) |
| Solana full workspace | `cd chains/solana && cargo test` | all passed (decision-relay, escrow, ism_localnet_tests) |
| Web integration/unit (Vitest) | `cd apps/web && npx vitest run` | 273 tests total; 3 initially failed, all directly caused by this pass's own P0/P1 fixes (see below), fixed by updating the tests to the corrected behavior — full suite re-run to 0 real failures across two subsequent runs (a different, unrelated test timed out in each of the two full-suite re-runs: `audit-chain.test.ts` once, `sdk-contract.test.ts` once — both are pre-existing DB-connection-pool-contention flakiness under this suite's `fileParallelism: false` sequential full-suite load, already documented in `vitest.config.ts`'s own comments, not caused by anything in this pass; both pass reliably in isolation) |

### The 3 tests that initially failed, and why (all expected, all fixed)

- `tests/unit/solana-settlement-identifiers.test.ts` (2 tests) — explicitly
  mocked `caseSettlement.findUnique` to return `null` ("no bound
  CaseSettlement — skip deposit gate") and asserted the old
  messageId-falls-back-to-settle-signature behavior. Both are exactly
  the two behaviors finding #1 and finding #3 (below) intentionally
  changed. Updated to mock a real bound, DEPOSITED CaseSettlement and to
  assert `messageId` is `null` on notification failure instead.
- `tests/unit/solana-settle-regressions.test.ts` (1 test) — its fake
  Solana `Connection` mock had no `getGenesisHash` method, so the new
  cluster-identity check (finding #2) threw before the test's actual
  target code (the ALT-extension call) ever ran. Added a mocked
  `getGenesisHash` returning the real Devnet hash.
- `tests/integration/solana-cosign.test.ts` (2 tests, real Postgres) —
  its fixture never created a `CaseSettlement` row at all, relying on
  the exact legacy fallback finding #1 removed, and didn't mock
  `assertSolanaEscrowDepositMatches` (which now always runs). Added a
  real `SettlementIntegration`/`CaseSettlement` fixture and a mock for
  the deposit-match assertion (this suite is about the co-signing
  wiring, not live Solana RPC connectivity, matching its own stated
  scope).

## Live on-chain proof already on record

- **Sepolia direct `attestedSettle()` payout**: proven live prior to this
  pass (see `docs/audit-package/test-evidence.md` and the incident docs
  for the specific transactions) — architecture correction from
  Hyperlane-mediated to direct same-chain settlement, not re-verified
  from scratch in this pass since no EVM contract code changed.
- **Solana Devnet direct `attested_settle()` payout**: proven live during
  this pass, case `sol-devnet-test-3` (DB id
  `cmu0xelfd000u6sh8rrl5kskz`) — full pipeline (case creation → escrow
  binding → real GenLayer adjudication → real on-chain deposit → 2-of-2
  attestor signatures → `attested_settle()` confirmed on-chain, `err:
  null` → respondent balance independently verified to have received
  the full deposit amount via direct RPC `getBalance` call, not just the
  app's own UI). See `docs/incidents/2026-09-14-solana-devnet-migration.md`'s
  "Verification" section for the exact command sequence and values.

**Caveat, stated plainly**: this pass's re-review of the app-level code
(the P0/P1/P2 fixes below) happened in a workspace without the ability
to re-run a full new live Devnet settlement from scratch (would require
funded keypairs, a live worker connection, and time the fix pass didn't
budget for). The claim "Solana Devnet direct attestor-authorized payout
is proven" rests on the transaction/verification record already on file
from earlier the same day, not on a fresh re-run after these code
changes. The code changes below (the Solana legacy-fallback removal, in
particular) were checked against the live database for any currently-
pending case that would be affected (`0` found) rather than re-proven
against a brand new live settlement.

## P0/P1/P2 findings addressed this pass

1. **P0 — Solana legacy settlement bypass removed.** `dispatchDecisionForCase`'s
   Solana branch (`apps/web/src/lib/hyperlane.ts`) previously only
   verified an on-chain deposit when a `CaseSettlement` happened to
   exist; now requires one unconditionally (active integration, DEPOSITED
   status, both party addresses, on-chain deposit match) — matching the
   EVM branch's existing requirement exactly, with no fallback. Verified
   no currently-pending Solana case would be broken by this (checked
   directly against the live database: 0 affected).
2. **P0 — Devnet cluster identity now explicitly checked at signing
   time.** `solana-settle.ts`'s `TESTNET_GENESIS_HASH` domain-separator
   tag is left unchanged (redeploying `decision-relay` with a new tag
   would require re-collecting every external attestor's signature under
   a new message format — disclosed as a deliberate choice, not an
   oversight). Instead, `assertConnectedToExpectedSolanaCluster` now
   calls `connection.getGenesisHash()` and refuses to sign or submit if
   it doesn't match the real, confirmed-live Devnet genesis hash — called
   before every `submitAttestedSettle` dispatch and once at worker boot.
   `environment-registry.ts` gained an explicit `solana-devnet` entry
   with the real genesis hash; `solana-testnet` is marked retired
   (`live: false`), kept as a historical record. Two stale Solana
   explorer-link and script defaults (pointing at Testnet, one at the
   wrong-cluster claim entirely) were also found and fixed along the way.
3. **P1 — `hyperlaneMessageId` no longer mislabels a settlement tx
   hash.** Both EVM and Solana branches of `dispatchDecisionForCase`
   used to fall back to the settlement transaction hash when no
   Hyperlane notification was ever dispatched — a field literally named
   for a Hyperlane message ID silently holding an unrelated hash. Now
   returns/persists `null` (the schema column was already nullable) in
   that case. Propagated the already-existing three-way split
   (`relayTxHash` / `relayMessageId` / `relayNotificationTxHash`) into
   the two remaining places that were missing `relayNotificationTxHash`
   (`receipts.ts`, the public decision-verify API route, PDF documents).
4. **P1 — README/architecture/Solana program comments corrected.** The
   trust-boundary diagram, the decision-to-settlement pipeline steps, and
   `decision-relay/src/lib.rs`'s own module header all described the
   superseded Hyperlane-mediated settlement architecture. Rewritten to
   show direct attested-settlement as the funds-moving path and Hyperlane
   as parallel, best-effort notification — with the precise nuance that
   Sepolia's `handle()` is still configured `settlementMode = SETTLEMENT`
   (not disabled) and only never reaches `settle()` in practice because
   `attestedSettle()` always marks the decision processed first
   (idempotency, not configuration, is what prevents double-settlement);
   Solana's `handle()` by contrast has no settlement code path at all,
   verified directly against `decision-relay/src/lib.rs`.
5. **P1 — Topology registry partially advanced, not fully migrated.**
   `environment-registry.ts` now has an accurate Devnet entry with a real
   genesis hash (see #2). A full migration of every signer/dispatcher/RPC
   config call site onto this registry, with startup checks refusing to
   boot on any mismatch, remains real, disclosed follow-up work — the
   registry's own header comment already said as much before this pass;
   this pass added the one concrete piece (live genesis-hash enforcement)
   that closes the actual safety gap without the full migration's risk.
6. **P2 — EVM owner-is-an-EOA claim checked and found inaccurate.**
   Verified live on Sepolia: `DecisionRelay.owner()` returns
   `0xc200534F7Debf2816C085c5a156AbD686FA19f4C`, which has deployed
   bytecode (a real Safe contract), matching the README's existing
   "Governance Safe owners (2-of-2)" table exactly. No change made — the
   reviewer's finding here does not match live on-chain state as of this
   verification.
7. **P2 — Solana key-rotation-requires-redeploy now explicitly
   disclosed** in `chains/solana/README.md` as a stated operational
   constraint (previously implied by `multisig-attestor-setup.md`'s
   wording but not called out as plainly).
8. **P2 — Unbounded `confirmTransaction()` calls consolidated.** The two
   remaining call sites outside the already-bounded settlement path
   (`SolanaDeposit.tsx`'s browser wallet-connect deposit flow, and
   `scripts/claimant-deposit-solana-devnet.ts`'s CLI script) now use the
   same `confirmTransactionBounded` helper the settlement path already
   used, closing the same class of hang the 2026-09-12 incident found.
