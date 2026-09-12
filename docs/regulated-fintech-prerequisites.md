# Regulated-fintech prerequisites (Phase 6 — design only)

Documentation only. No legal, licensing, or compliance decision made here
is binding — these are the prerequisites to work through with actual
counsel before any mainnet pilot, framed against what this codebase
actually does today.

## Legal/custody model

### What the contracts actually do (verified against source, not assumed)

`chains/evm/contracts/Escrow.sol` holds deposited funds in the contract
itself; its `settle()` and `emergencyRefund()` functions are gated
`onlyDecisionRelay`, and `DecisionRelay.sol` requires an M-of-N attestor
threshold before it will call either — no single key, including the
contract owner's, can move funds unilaterally (source comments in
`Escrow.sol` around its `settle`/`emergencyRefund` functions state this
trust boundary explicitly, and it matches the actual `onlyDecisionRelay`
modifier and M-of-N gating in the deployed contract). The Anchor operator
does not hold a private key that alone can withdraw user funds.

This supports a **non-custodial framing** — Anchor facilitates and
attests to dispute outcomes but does not unilaterally control settlement
— contingent on the caveat already stated plainly in
`docs/mainnet-custody-design.md`: today's attestor/Safe independence is
not yet real (all keys effectively trace to one operator on testnet).
Non-custodial framing is only true in substance once attestor
independence in that document's target design is achieved; claiming it
today, on testnet, with today's key concentration, would be a legal
mischaracterization if this were mainnet.

### Two paths, to decide with counsel

1. **Non-custodial facilitator**: once attestor independence is real,
   Anchor's role is closer to an oracle/arbitration-attestation service
   than a money transmitter — it never independently holds keys able to
   move user funds. This likely reduces money-transmitter licensing
   exposure but is not a guarantee; several U.S. states and other
   jurisdictions have taken varying positions on whether M-of-N attestor
   arrangements still constitute "control" of funds for licensing
   purposes, and this varies by jurisdiction and is genuinely unsettled
   in places — a real open legal question, not a technicality this
   document can resolve.
2. **Custodial money transmitter**: if the operating entity chooses to
   hold a subset of attestor keys itself (rather than fully independent
   third parties) for operational simplicity, it likely takes on
   money-transmitter licensing obligations in relevant jurisdictions
   (state-by-state in the U.S., or equivalent frameworks elsewhere),
   which is a materially heavier compliance lift (capital requirements,
   bonding, state-by-state licensing).

**This document does not choose between them** — that is exactly the
"legal/custody decision" item in `docs/mainnet-readiness-gate.md`, item 6,
requiring counsel, not an engineering session.

## KYC/KYB/AML/sanctions policy (outline)

Assuming disputes involve identifiable counterparties (claimant/respondent
addresses tied to real users, not anonymous on-chain actors — consistent
with how cases are created via `apps/web/src/app/api/cases/route.ts`'s
existing settlement-target validation):

- **Screening triggers**: account creation, first deposit above a defined
  threshold, and any settlement above a defined threshold — modeled on
  standard AML transaction-monitoring triggers, thresholds to be set with
  counsel/compliance input, not engineering judgment.
- **Data collected**: at minimum, for accounts above the deposit
  threshold — legal name, government ID verification, and sanctions-list
  screening (OFAC SDN list and equivalent regional lists) at onboarding
  and periodically thereafter.
- **What's already collected today, honestly**: the current system
  collects wallet addresses and case metadata (see the `Case`/`Deposit`
  Prisma models) but no KYC-grade identity data — a real gap between
  today's testnet system and what a mainnet regulated deployment requires.
- **Retention**: identity/KYC records retained per applicable AML
  recordkeeping requirements (commonly 5 years post-relationship-end in
  many jurisdictions, but jurisdiction-specific and to be set with
  counsel), stored separately from on-chain case data with access
  controls distinct from the application database.
- **Sanctions**: real-time or near-real-time sanctions screening on both
  parties to a case before settlement dispatch — a gate that would need
  to sit in front of `apps/web/src/lib/hyperlane.ts`'s settlement dispatch
  path, not built in this phase.

## Stablecoin strategy — tried and reverted

A USDC-first settlement path (a real `EscrowUSDC.sol` deployment,
ERC-20 deposit/approve flow, and version-detection wiring) was built
and briefly deployed to Sepolia, then removed. The volatility argument
below was the original motivation and remains true in the abstract,
but the actual blocker that killed it was architectural, not
regulatory: `DecisionRelay` only supports a single settlement target
per chain, and fighting that limitation to support a second (token)
settlement path per chain was judged not worth it relative to simply
staying on native ETH/SOL settlement, which this system already
supports on both chains it operates on. The deployed `EscrowUSDC`
contract (Sepolia, `0x87e94aac03f1a032b264e035fd41a76bcdc802e2`) is
immutable and was left in place on-chain — Anchor's application layer
no longer references it — and still holds a small amount of real
testnet USDC from a test that was never dispatched because of the same
limitation. A future revisit of stablecoin settlement should design
around DecisionRelay's per-chain single-target constraint from the
start, rather than bolting a second target onto it after the fact.

**The volatility problem** (why a stablecoin was considered at all):
a dispute's claimant/respondent amounts are denominated at
case-creation time, and if settlement in raw ETH/SOL is delayed (which
`docs/mainnet-readiness-runbook.md`'s retry/escalation logic explicitly
allows for), the settled value can diverge materially from the
disputed value by the time settlement executes. This remains a real
user-experience and fairness consideration for a dispute-resolution
product, and should be weighed again before any future mainnet
launch — just not solved by USDC specifically given the architectural
cost above.

**Environment-registry hook (real, added this phase)**: once a stablecoin
path exists, its per-environment contract address belongs in
`apps/web/src/lib/environment-registry.ts`'s `addresses` field for the
relevant environment, keeping it subject to the same
`isApprovedForEnvironment` environment-isolation property as every other
settlement contract added this phase.

## Reconciliation, accounting, and customer-funds safeguarding

**What exists today**: `apps/web/src/app/api/organizations/settlements/export/route.ts`
(Phase 4) already produces a CSV export of settlement records per
organization — a real, working reconciliation input, not aspirational.

**What mainnet regulated operation adds on top of that export**:

- **Daily reconciliation**: an automated job comparing the CSV export's
  settlement totals against actual on-chain balance movements in the
  Escrow/DecisionRelay contracts (and their stablecoin equivalents, once
  built), flagging any discrepancy for human review before end-of-day
  close — not built in this phase, a real follow-up item.
- **Customer-funds safeguarding**: if the legal/custody decision above
  lands on a custodial model, funds held pending dispute resolution
  likely need to be held in a manner satisfying customer-funds
  safeguarding rules analogous to those for money transmitters (e.g.
  segregated from operating capital, or held in permissible investments
  only) — an accounting and legal requirement, not a smart-contract one,
  though the smart contract's escrow design (funds held in the contract,
  not swept to an operator wallet) is a reasonable technical starting
  point consistent with a segregation requirement.
- **Accounting treatment**: whether disputed funds held in escrow are
  recognized as a liability on Anchor's books (if custodial) or not
  recognized at all (if genuinely non-custodial, per the legal/custody
  decision above) is an accounting policy question for counsel/auditors,
  directly downstream of the same legal/custody decision this whole
  document repeatedly defers to item 6 of the mainnet readiness gate.
