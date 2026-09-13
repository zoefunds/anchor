# Sepolia settlement delivery incident — 2026-09-12

## Status: OPEN (transport/delivery unresolved as of the original snapshot below) — SUPERSEDED for payout purposes by the 2026-09-13 architecture change, see the Update section at the end of this file.

Do not treat this incident as closed until the full chain has been observed
end-to-end for a real (or minimal-probe) message:

```
Dispatch → 2-of-3 valid checkpoint coverage → relayer process tx →
Mailbox.delivered(messageId) → DecisionRelay.processedDecisions(proofHash) → Escrow settled
```

Progress (checkpoints existing, a Merkle replica advancing, a message reaching
`AwaitingValidatorSignatures`) is evidence of partial function, not proof of
the full chain above.

## Configuration snapshot (frozen at time of writing, 2026-09-12)

- Source of truth for all addresses below: `apps/web/src/lib/deployment-registry.ts`

| Component | Value |
|---|---|
| Source/destination domain | 11155111 (Sepolia self-notify route) |
| Mailbox | `0x345E7246631ceb0300427caB75eacA10c326BB09` |
| MerkleTreeHook | `0xA32341dc796DB6C51c0D1695751aC9AA2Dd77aBB` |
| ValidatorAnnounce | `0x198A6ec048C665d7E4dc2b40Cb2c715Db1cEC6F5` |
| ISM (StaticMerkleRootMultisigIsm) | `0xd916b90858B8bF7Cc7E111D3C7923ab4Fe0FCcf0` |
| DecisionRelay (Phase 1, at time of writing) | `0x100720fe9f0bFc83E6FdEA392Cb3a0905A5acEa9` |
| Escrow (Phase 1, at time of writing) | `0xd848A7CA77CcaA3718d430F7D0DB62174e7a3DfC` |
| Trusted sender (domain 11155111) | `0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb` |
| SettlementMode (domain 11155111) | `SETTLEMENT` (1) — set 2026-09-12, after being unconfigured since redeploy |
| Validators / threshold | `0x2ffFd80d...`, `0xf171c236...`, `0x4dbc8704...` / 2-of-3 |
| Relayer whitelist | `chains/hyperlane-relayer/entrypoint.sh` — DecisionRelay + DeliveryProofReceiver (`0xC28f88a063fEb0A5abbE4bA787799c9D181D26b9`) |
| Relayer Fly app / machine | `anc-hor-relayer` / `8714ddc01541e8` |
| Relayer `index.from` | `11651800` (full history — required for Merkle-proof reconstruction; a narrower value was tried and found to break proof construction entirely) |
| Relayer RocksDB | wiped and rebuilt from scratch 2026-09-12 (previously held state from 2026-08-31, corrupting discovery through every subsequent config change) |

### Retired (do not use — see `RETIRED_SEPOLIA_ADDRESSES` in the registry)

- Old canonical shared Mailbox: `0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766` (default hook never routes through a real Merkle tree — permanent dead end)
- Old DecisionRelay bound to it: `0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2`
- Old Escrow: `0x4C7765A6823dc27Eca1DE174FceeAE5048d403e7` — holds 0.002 ETH from a pre-incident test deposit, locked under its own contract-enforced 30-day `emergencyRefund` timeout (eligible ~2026-10-12); not recoverable before then regardless of any other fix.

## Real, confirmed root causes found and fixed (chronological, 2026-09-12)

1. **Old DecisionRelay permanently unfixable** — immutable `mailbox` binding to a mailbox with no functioning Merkle hook. Fixed by deploying a new DecisionRelay/Escrow against Anchor's own working mailbox.
2. **`checkAutoSignEligibility` hard-required `currency === "USD"`** — made automated attestor signing impossible for every real (ETH/SOL) case. Fixed to use native-currency caps.
3. **`Case.currency` never set at case creation** — silently defaulted to schema's `"USD"`. Fixed to derive from `settlementChain`.
4. **`authorizeDepositOnChain` didn't wait for its own tx to confirm** — real race condition. Fixed.
5. **Solana deposit confirmation had no timeout** — could hang indefinitely against public RPC. Fixed with bounded polling, later consolidated into a shared helper (`solana-confirm.ts`).
6. **Relayer's hardcoded whitelist only allowed the old DecisionRelay.** Fixed.
7. **Validator2's dedicated RPC silently died Sept 9** (Alchemy monthly cap). Fixed by switching to a public endpoint.
8. **Validator2's deployed config was stale**, missing mailbox/hook/announce overrides. Fixed by redeploying from current repo config.
9. **Relayer's RocksDB held indexing state from Aug 31.** Wiped.
10. **Validator1's second announced S3 location (`validator1-mailbox2`) had no bucket-policy grant** — relayer choking on `AccessDenied` here dropped validator1 entirely, capping usable signatures at 1 of 3. Bucket policy corrected.
11. **Validator1's `checkpoint_latest_index.json` pointer was stale** (pointed at an ancient index from the old canonical-mailbox era). Overwritten with the correct value. **Auditor caution, correctly raised**: this is diagnostic state, not a durable repair.
12. **`reliability-monitor.ts` hardcoded every retired address** — dashboard could report the retired system healthy while the active one failed. Fixed via `deployment-registry.ts`, a single versioned source of truth.
13. **New DecisionRelay was missing `trustedSender` and `settlementMode` configuration** — `handle()` requires both and would revert without them, independent of any relayer/checkpoint issue. Fixed 2026-09-12 via direct governance calls.

## Open items as of the 2026-09-12 snapshot (superseded below — see Update)

- Full delivery chain not yet observed end-to-end for any message on the active Sepolia route.
- Same-domain (Sepolia→Sepolia) relay support unproven from the pinned Hyperlane agent version.
- Registry migration incomplete across all consumers.
- No CI/startup invariant enforcing topology agreement.
- Checkpoint verification not independently automated.
- Old escrow recovery record not yet created.

---

## Update 2026-09-13: third audit round, architecture change, Phase 2 shipped

A third audit round, after reviewing the above, identified the real
architectural problem underneath every symptom listed so far: the EVM
settlement route dispatches from Sepolia domain `11155111` to Sepolia domain
`11155111` — a same-domain Hyperlane self-loop. Whether that pattern is
supported at all by the pinned `agents-v2.3.0` relayer was never proven, only
assumed. The auditor's explicit recommendation: for same-chain settlement,
stop depending on Hyperlane transport for availability at all. Use direct
attestor-authorized settlement (2-of-3 signatures) as the real payout path,
and demote Hyperlane to a notification-only, best-effort audit trail. (Solana's
`attested_settle()` already worked this way; only the EVM side had the
self-loop dependency.)

The user authorized this in stages — architecture proposal, then
implementation/testing, then a separate explicit go-ahead for Sepolia
deployment — per this doc's own standing instruction not to deploy, wipe
state, or lift `SETTLEMENT_PAUSED` without a reviewed plan per phase.

### What shipped

**1. `attestedSettle()` — new same-chain settlement function, `chains/evm/contracts/DecisionRelay.sol`**

- Same cryptographic pattern `emergencyRefund()` already used (M-of-N
  attestor signatures are the ENTIRE authority — no `onlyMailbox`, no
  `onlyOwner`), generalized from an escape hatch to the normal settlement
  path.
- Domain-separated by hash-scheme string: `"ANCHOR_DIRECT_SETTLE_V1"` vs.
  `handle()`'s `"ANCHOR_DECISION_ATTESTATION_V2"` vs. `emergencyRefund()`'s
  `"ANCHOR_EMERGENCY_REFUND_V1"`.
- `directSettlementTarget` storage slot, deliberately separate from the
  Hyperlane-domain-keyed `settlementTarget`/`settlementMode`.
- Shares the `processedDecisions` replay-guard mapping with `handle()`/`emergencyRefund()`.
- **Second deploy, same day, external-audit fix**: the first version's
  signed digest was missing `block.chainid`, a deadline, and an explicit
  binding of the settlement target address. All three fixed — see
  `attestedSettle()`'s own doc comment in the contract. 3 additional Foundry
  tests added (expired-deadline rejection, tampered-deadline rejection,
  target-mismatch rejection).
- **Full contract test suite: 112/112 passing** (97 pre-existing + 12 initial
  + 3 audit-fix tests).

**2. Deployment history — three DecisionRelay/Escrow generations in two days**

A hard architectural constraint: `Escrow.decisionRelay` is `immutable`, set
once at construction. Adding `attestedSettle()` (and later, fixing its
digest) each required a full new DecisionRelay + Escrow pair.

| Generation | DecisionRelay | Escrow | Status |
|---|---|---|---|
| Phase 1 (pre-attestedSettle) | `0x100720fe9f0bFc83E6FdEA392Cb3a0905A5acEa9` | `0xd848A7CA77CcaA3718d430F7D0DB62174e7a3DfC` | Retired — still holds a real, currently-unsettled deposit only its own `handle()`/`emergencyRefund()` can reach |
| Phase 2, first deploy (pre-audit-fix) | `0x2d5E63ea1F83f6BF5a438c354454b100904896EE` | `0x891C38cd2E4a92b0ae9b63b55bd2aa6883381A5d` | Retired — never used for a real case, nothing stranded |
| **Phase 2, second deploy (ACTIVE, submission topology)** | **`0x56bf62F9F4C2C316D956F9C35DD1B15BE5ae9834`** | **`0x5a7a2F3553f147a6D2BE4b23CB36D693e12e98bD`** | **Active — frozen for submission, do not redeploy** |

Mailbox, ISM, attestor set (3 attestors, 2-of-3 threshold), and owner
(`0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb`, a known/tracked EOA, not the
Safe) are unchanged across all three generations — verified live on-chain
before each deploy, not assumed from stale documentation. All four
post-deploy config calls (`setTrustedSender`, `setSettlementTarget`,
`setSettlementMode`, `setDirectSettlementTarget`) confirmed and independently
re-read back from chain each time.

**3. App integration — `attestedSettle()` is the real settlement path for Sepolia**

- `packages/hyperlane-relay/index.ts`: `computeDirectSettleAttestationHash`
  (now including chainId/target/deadline) and `submitAttestedSettle` (calls
  `attestedSettle()` directly — no Mailbox, no fee quote, no messageId).
- `apps/web/src/lib/hyperlane.ts`: the Sepolia branch of
  `dispatchDecisionForCase` calls `submitAttestedSettle` as the real
  fund-moving call, then fires the existing Hyperlane `handle()` dispatch
  afterward as a best-effort, non-blocking notification. Shared
  `processedDecisions` idempotency means a redundant Hyperlane delivery,
  if it ever arrives, is a harmless no-op.
- Pre-dispatch invariant checks added: `assertSettlementTargetMatchesIntegration`
  (pre-existing, checks the Hyperlane-path `settlementTarget`) plus a NEW
  `assertDirectSettlementTargetMatchesIntegration` (checks the ACTUAL
  payout path's `directSettlementTarget`, and the reverse binding —
  `Escrow.decisionRelay()` — both directions).
- Real bug found and fixed the same day: the signed deadline was
  recomputed fresh on every dispatch retry, meaning signatures from
  different retries could never combine to reach quorum (deadline is
  signed content, so a changed deadline changes the whole hash). Fixed by
  persisting the first-chosen deadline per decision (`Decision.directSettleDeadline`)
  and reusing it across retries until it actually expires.
- No changes needed to `auto-attestor-sign.ts`, the pending-attestation API
  route, or the Prisma schema's core attestation fields — that entire
  workflow is hash-scheme-agnostic.

**4. Runtime topology enforcement added**

- `startup-checks.ts`: `assertManifestMatchesRegistry()` — static,
  no-RPC check that the committed manifest agrees with
  `deployment-registry.ts`'s `ACTIVE_SEPOLIA_TOPOLOGY`. Wired into both
  `assertEvmSignerRegistered` (every attestor signer process) and
  `assertEnvironmentSafeToBoot` (every worker boot for the sepolia
  environment) — refuses to start on drift.
- `scripts/verify-active-topology.ts` — one command, live chain reads,
  12/12 checks passing with zero drift as of the active (third) pair.
- `tests/unit/topology-drift.test.ts` — CI-enforced, static: fails if the
  manifest, the standalone validator `deployment.json`, or any active
  source file disagrees with the registry, or if a retired address is
  referenced outside an allowlisted historical/test context.

**5. Controlled automation rehearsal (item 3 of the 2026-09-13 remediation plan)**

`scripts/rehearse-controlled-settlement.ts` — a test-only, single-case,
single-use CLI that calls the REAL `dispatchSettlementForDecision` (the
exact function `retryFailedSettlements`/`finalizeExpiredAppealWindows`/
`runAdjudicationJob` call in production), with a narrow, decision-scoped
bypass of the `SETTLEMENT_PAUSED` check — authorized only via a one-time
token (`Decision.testRehearsalAuthToken`) a human operator explicitly
generates for one specific already-finalized decision, consumed the
moment a real dispatch succeeds (never on a mere retry), never reusable
without a fresh `--authorize` run. Every other real caller in the
codebase calls `dispatchSettlementForDecision` with no bypass argument,
so the global pause continues to apply to every other case exactly as
before. Proves the real worker/application path (canonical payload
construction, the real 2-of-3 attestor flow via the live external
attestor service, real `attestedSettle()` submission, real payout,
correct replay rejection) without ever lifting the global pause.

**6. Known, documented governance gap — unchanged, not newly introduced**

The active DecisionRelay's `owner()` is `0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb`
(an EOA), not the Safe (`0xc200534F7Debf2816C085c5a156AbD686FA19f4C`) — the
same pragmatic testnet shortcut as every prior deploy, correctly flagged by
the regenerated manifest's `flags` array and caught by
`checkGovernanceDrift()`'s periodic reconciliation sweep if it ever changes
further.

### Real proofs produced

1. **Isolated payout mechanism proof** (fabricated decision, real deposit,
   real 3-of-3 signatures, real `attestedSettle()`, real replay rejection)
   — `artifacts/submission/sepolia/`. Settlement tx:
   `0xd8b4455802b0747c4a50e5d57c365d40ebe59090b622c3d6f7fe0e95963e292c`.
2. **Full real chain: GenLayer adjudication → appeal → FINALIZED → (pause
   correctly blocks automated dispatch) → manual authorized `attestedSettle()`**
   — `artifacts/submission/sepolia-full-chain/`. Settlement tx:
   `0xcba98da7a511f5373ea2030d61308371b07bfb23b4ccec9c2bfb54775ed781e7`.
3. **Controlled worker-path rehearsal**: real `dispatchSettlementForDecision`
   call, real attestation collection via the live external attestor
   service, real payout, real replay no-op, global pause held throughout
   — `artifacts/submission/sepolia-controlled-rehearsal/`. Settlement tx:
   `0x9526503dec2a1e6bb5468e0274762f089da38e0ef240f3ddb95245011704272c`.
4. **Sepolia→Sepolia self-loop probe** (Phase 5): one message dispatched to
   `DeliveryProofReceiver`, polled 10 minutes, **not delivered** —
   `artifacts/submission/hyperlane/self-loop-probe.json`. Per the
   remediation plan's explicit instruction, this is now labeled
   unproven/unsupported for this deployment and permanently out of the
   payout critical path — no further relayer restarts or self-loop tests
   planned.

### Updated open items (supersedes the 2026-09-12 list above)

- **Solana equivalent proof is blocked by an external Solana Testnet
  outage** (two independent RPC providers both show a completely frozen
  slot number for the full duration of this work) — script is
  code-complete (`scripts/e2e-solana-attested-settle.ts`), untested live,
  ready to run the moment the cluster recovers.
- **Full delivery chain on the Hyperlane route itself remains
  unobserved** — no longer the payout-availability dependency for Sepolia
  (superseded by `attestedSettle()`), but still the only viable path
  (short of `emergencyRefund()`) for the Phase 1 pair's stuck deposit.
- **Governance**: EOA owner, not the Safe — tracked, deferred past
  submission per the auditor's explicit guidance not to risk another live
  configuration change before completing both chain proofs.
- **Phase 1 stuck deposit** (0.002 ETH) unaffected by any of this —
  `emergencyRefund()`-eligible 2026-10-12, gated on separate governance
  approval.
- **Phases 3/4/6 of the third audit's broader remediation brief**
  (real delivery-proof verifier, relayer observability/recovery runbook,
  agent-backed integration test harness) — not started, explicitly
  out of scope for this submission round.
- **`verify-checkpoint-quorum.ts`'s known gaps** — unchanged, unaddressed.
