# Cross-chain adjudication relay (Hyperlane)

Anchor's decisions are produced on GenLayer. Most parties in a dispute hold
funds/escrow on other chains (EVM chains, Solana). Hyperlane is the
interchain messaging layer that gets a finalized decision — and an
execution instruction — from GenLayer's side of the system to whichever
chain actually needs to act on it, and lets case data flow the other
direction too.

**Status: live, auto-dispatch wired.** `chains/evm/contracts/SolanaCaseReceiver.sol`,
`chains/evm/contracts/DecisionRelay.sol`, and `chains/solana/programs/decision-relay`
are all deployed. Two things are proven separately:

1. **CaseOriginate dispatch->relay->handle()**, Solana -> Sepolia: fully
   proven, including delivery and correct decode on the destination
   contract. See `chains/hyperlane-relayer/README.md` for message IDs and
   tx hashes.
2. **DecisionRelay auto-dispatch**: `apps/web/src/lib/adjudication-service.ts`
   now calls `dispatchDecisionForCase` (`src/lib/hyperlane.ts`)
   automatically whenever a case with a `settlementChain`/`settlementContract`
   configured reaches an ACCEPTED decision - no manual/scripted trigger
   needed anymore. Proven live: creating a case with a real settlement
   target and running it through real GenLayer consensus produced a real
   Sepolia dispatch transaction and Hyperlane message ID, recorded on the
   `Decision` row (`relayTxHash`/`relayMessageId`), with zero manual
   intervention.

3. **Real Solana settlement destination**: `packages/hyperlane-relay` now
   also has `dispatchDecisionRelayToSealevel` (Borsh-encoding matching
   `decision-relay`'s `DecisionRelayBody` exactly) — a real DecisionRelay
   message was dispatched from Sepolia to `decision-relay`'s Solana
   Testnet program, targeting a real escrow case (created via
   `chains/solana/tests/run-create-case-for-relay-test.ts`) with
   `decision-relay`'s escrow-authority PDA as its adjudicator, so a
   successful `handle()` would genuinely CPI into `escrow.settle()` —
   not a synthetic test target.

**What "the ISM aggregation threshold" problem actually was, and the
fix**: Sepolia's *default* recipient ISM (used whenever a recipient
doesn't implement its own `interchainSecurityModule()`) is a 2-of-2
aggregation ISM requiring independent checkpoints from two separate
canonical validator sets — confirmed live via `modulesAndThreshold()`.
Our self-hosted relayer could only assemble one of the two, so any
message relying on that default sat permanently undeliverable. **Fix**:
`DecisionRelay.sol` now overrides `interchainSecurityModule()` with
`TrustedRelayerIsm.sol`, a minimal custom ISM under Anchor's own control
— this sidesteps needing cooperation from Abacus's canonical validator
set entirely, at the cost of a real security tradeoff (documented in
that contract) appropriate only while Anchor is both the sole dispatcher
and sole relayer for these messages. Proven live: a self-dispatched
message through the new ISM was successfully delivered and decoded
(`DecisionReceived` event, correct case ID/outcome) — see
`chains/hyperlane-relayer/README.md` for the tx hash.

A second, unrelated bug was found and fixed on the Solana side:
`decision-relay`'s ISM-query handler returned no data at all instead of
an explicitly Borsh-encoded `None`, which the relayer's Sealevel client
treats as an error rather than "use the default." Fixed and redeployed
(same program ID); confirmed correct via direct on-chain simulation. See
`chains/hyperlane-relayer/README.md`'s "Known issues fixed" for both, and
its "Known issue NOT fixed" for what's still unreliable (automatic
delivery of fresh Sepolia-origin messages by this relayer — the one
DecisionRelay delivery proven above was submitted manually with
`cast send` after the program-level bugs were confirmed fixed, not
auto-delivered).

## Why Hyperlane specifically

Hyperlane's Mailbox/ISM model lets Anchor:
- send a message from one chain's Mailbox to a recipient contract on another
  chain, permissionlessly, without needing a specific bridge per chain pair
- configure security (which validators/ISM must attest) per route, so
  Anchor can tighten requirements for higher-value cases
- add new destination chains (an EVM chain, or Solana via Hyperlane's
  Sealevel Mailbox) without redesigning the message format

## Two message types

### 1. `DecisionRelay` — GenLayer → destination chain

Sent once a case's `adjudicate()` call finalizes on GenLayer. Per your
answer, this carries **decision + execution instruction**, not just the
decision — the destination contract should be able to act on it directly
(e.g. call `release()`/`refund()` on an escrow contract at a known address)
rather than requiring a second round-trip to figure out what to do.

```json
{
  "message_type": "DECISION_RELAY",
  "case_id": "CASE-84921",
  "policy_id": "agent_data_task_v1",
  "policy_version": "1.0.0",
  "outcome": "REFUND_PARTIAL",
  "claimant_share_bps": 6500,
  "respondent_share_bps": 3500,
  "reason_codes": ["SPEC_PARTIALLY_MET", "DATA_INCOMPLETE"],
  "proof_hash": "0x...",
  "execution": {
    "target_chain": "evm:8453",
    "target_contract": "0x...",
    "action": "settle",
    "params": {
      "escrow_id": "0x...",
      "claimant_amount_atto": "650000000000000000",
      "respondent_amount_atto": "350000000000000000"
    }
  }
}
```

- `execution.target_chain` uses `evm:<chainId>` or `solana:<cluster>` so one
  schema covers both chain families.
- `proof_hash` lets the destination contract's ISM/verification step tie the
  relayed message back to the GenLayer decision it's executing, independent
  of trusting Anchor's backend.

### 2. `CaseOriginator` — origin chain → GenLayer (bidirectional, as requested)

Lets a case (and its evidence references) originate from activity on an EVM
or Solana chain rather than only through Anchor's API — e.g. an on-chain
escrow contract itself raises a dispute when a claim function is called.

```json
{
  "message_type": "CASE_ORIGINATE",
  "origin_chain": "evm:8453",
  "origin_ref": "0x... (originating contract/tx)",
  "claim": "SERVICE_NOT_DELIVERED",
  "amount_atto": "1000000000000000000",
  "claimant_ref": "party_7F82A",
  "respondent_ref": "party_2C41E",
  "policy_id": "agent_data_task_v1",
  "policy_version": "1.0.0",
  "evidence_refs": ["ipfs://... or Anchor evidence IDs, resolved by the backend"]
}
```

Anchor's backend listens for these (via a relayer/indexer watching the
GenLayer-side Mailbox), creates the Case record, and evidence collection
proceeds normally from there — this message only *opens* the case, it
doesn't carry full evidence payloads (those stay off-chain per Anchor's
evidence plane, hashed and referenced same as any other case).

## Chain scope

Targeting **EVM chains generically + Solana**, no specific chain committed
yet. Concretely:

- `chains/evm/contracts/DecisionRelay.sol` — one contract deployable to any
  EVM chain, implements Hyperlane's `IMessageRecipient.handle()` to receive
  `DecisionRelay` messages and dispatch to a configurable settlement target;
  also can originate `CaseOriginator` messages via the local Mailbox.
- `chains/solana/programs/anchor-decision-relay/` — Solana program skeleton
  for the same role via Hyperlane's Sealevel Mailbox program. Solana support
  in Hyperlane is newer/less mature than EVM — validate current program
  conventions and available ISMs before building this out; do not assume
  parity with the EVM side.

## Open questions to resolve before implementation

These aren't blocking the current MVP work, but need answers before
`chains/` becomes real code:

1. Does GenLayer itself have a Hyperlane Mailbox deployed on its chain, or
   does the relay originate from an EVM chain Anchor's backend controls
   (i.e. backend watches GenLayer for finalized decisions, then dispatches
   the Hyperlane message from an EVM chain on GenLayer's behalf)? This
   determines whether `DecisionRelay` dispatch is itself a GenLayer
   Intelligent Contract action or an off-chain-triggered EVM transaction.
2. Who pays Hyperlane's interchain gas for relaying to Solana/each EVM
   chain — Anchor, or the party requesting settlement?
3. Security model per route: does every destination chain get the same ISM
   requirement, or do higher-value cases need stricter validator attestation?
4. For `CaseOriginator`, which specific escrow/contract patterns on the
   origin chain are expected to trigger case creation — is there a
   reference escrow contract Anchor provides, or does Anchor need to
   support arbitrary third-party contracts emitting this message?

## Sequencing (build in parallel with the MVP, per your call)

1. Message schemas above — done, this doc.
2. `chains/evm/contracts/DecisionRelay.sol` skeleton — scaffolded now.
3. Anchor backend: a relay dispatcher service that watches GenLayer for
   finalized `Adjudicator.get_decision()` and dispatches `DecisionRelay` —
   built alongside `apps/web`'s decision service.
4. EVM testnet round-trip (e.g. Sepolia → Sepolia or two testnets) proving
   dispatch + handle() before touching Solana.
5. Solana Sealevel side once EVM path is proven and question #1 above is
   answered.
