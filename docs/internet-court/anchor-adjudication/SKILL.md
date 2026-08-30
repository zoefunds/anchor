---
name: anchor-adjudication
description: Internet Court connector for Anchor — a hosted Adjudication-as-a-Service API backed by GenLayer Intelligent Contracts. Use when two agents need a commerce dispute (not an agent-permission/mandate review) settled by policy and evidence rather than by writing a bespoke GenLayer contract: payment disputes, data/API task delivery disputes, escrow release disagreements. Complements, does not replace, integrations/genlayer-intelligent-contracts — that connector is for ERC-7710 mandate supervision (continue/warn/constrain/revoke agent authority); this connector is for settling a specific transaction dispute between two parties (release/refund/split funds) via Anchor's own case/evidence/policy pipeline, which already runs on real GenLayer consensus.
---

# Anchor Adjudication

Anchor is a policy-driven adjudication API: create a case, submit evidence
against a named policy, submit for adjudication, get back a structured
decision. Every adjudication runs through a real GenLayer Intelligent
Contract with independent validator consensus — not a single LLM call
rubber-stamping an outcome. See the parent repo's `genlayer/README.md` for
the contract this connector's decisions actually run on, including the real
findings from getting it working (float-in-calldata, header-parsing, ASCII
constraints) — link this when a user wants proof it's real, not just a spec.

Use this connector instead of writing a raw GenLayer contract when the
dispute is a **transaction outcome** (who gets paid, how much) rather than
an **agent-permission decision** (should this agent keep its delegated
authority). For the latter, use
`../genlayer-intelligent-contracts/SKILL.md` instead — the two are
complementary, not alternatives, and a single Internet Court deal can use
both (e.g. Anchor settles a specific milestone payment dispute; the
mandate-supervision connector separately decides whether the agent keeps
its spending authority going forward).

## Core Model

```text
Two agents strike a deal (via A2A negotiation, ERC-7710 mandate, x402
payment, or any other layer above) and name Anchor as the adjudicator if
something goes wrong.
  -> Claim opened as a Case under a named policy
  -> Both sides submit evidence (task spec, delivery, statements)
  -> Case submitted for adjudication
  -> GenLayer Intelligent Contract runs the policy, independent validators
     reach consensus
  -> Structured Decision: outcome + claimant/respondent share (bps) +
     reason codes
  -> Caller executes settlement (release escrow, trigger refund, etc.) —
     Anchor does not move funds itself; see Settlement Effect Path below
```

## When to Use

Use this skill when:
- Two agents disagree about whether a paid task was actually delivered to
  spec (the concrete policy this connector currently supports —
  `agent_data_task_v1`, see below).
- The dispute needs an auditable, consensus-backed verdict rather than one
  party's own LLM judging its own counterparty.
- The outcome needs to be a structured, machine-actionable split (not a
  free-text ruling) so a downstream escrow/payment system can act on it
  directly.

Do not use this skill for:
- Agent-permission/mandate supervision (`continue`/`warn`/`constrain`/
  `revoke` decisions about whether an agent keeps ERC-7710 authority) — use
  `../genlayer-intelligent-contracts/SKILL.md`.
- Binary public-web-evidence questions ("did X happen by date Y") — use the
  Intelligent Oracle skill.
- Disputes with no named policy yet. Anchor's policy library currently has
  one production policy (below); if the dispute doesn't fit it, say so
  explicitly rather than forcing a mismatched policy, and flag it as a gap
  (new policies are how this connector grows — see Extending below).

## Workflow

1. **Confirm the policy fits.** Currently: `agent_data_task_v1` — Agent A
   pays Agent B to perform a data/API task; A disputes the delivery didn't
   meet spec. If the deal doesn't match this shape, don't force it — see
   Extending below.
2. **Open the case** — `POST /api/cases`:
   ```json
   {
     "claim": "service_not_delivered",
     "amount": 1000,
     "claimantRef": "party_A",
     "respondentRef": "party_B"
   }
   ```
   `claimantRef`/`respondentRef` must already be pseudonymous references —
   Anchor never sends real identities to GenLayer (see
   `packages/types/index.ts`'s privacy note). Resolve real agent
   identities (ERC-8004, wallet addresses, etc.) to opaque refs before
   calling this.
3. **Submit evidence** — `POST /api/cases/:id/evidence`, once per required
   type. `agent_data_task_v1` requires all four:
   `task_spec`, `delivery_payload`, `claimant_statement`,
   `respondent_statement`. The endpoint rejects submission for
   adjudication until all four are present.
4. **Submit for adjudication** — `POST /api/cases/:id/adjudicate`. Returns
   `202` immediately with the case in `ADJUDICATING` status — this call
   does not block on the ~1-2 minute GenLayer consensus round. Poll step 5.
5. **Poll for the decision** — `GET /api/cases/:id`. Once `status` leaves
   `ADJUDICATING` (becomes `ACCEPTED` or `UNDETERMINED`), the `decision`
   field is populated. See Decision Output below for the shape.

## Decision Output

```ts
type AnchorDecision = {
  caseId: string;
  policyId: string;          // e.g. "agent_data_task_v1"
  policyVersion: string;     // e.g. "1.0.0"
  outcome:
    | "RELEASE_FULL" | "RELEASE_PARTIAL"
    | "REFUND_FULL"  | "REFUND_PARTIAL"
    | "REQUEST_MORE_EVIDENCE" | "UNDETERMINED";
  claimantShareBps: number;    // integer 0-10000, NOT a float — see note below
  respondentShareBps: number;  // claimantShareBps + respondentShareBps == 10000
  reasonCodes: string[];       // fixed vocabulary, see docs/policy-v1.md
  consensus: "ACCEPTED" | "UNDETERMINED";
};
```

`claimantShareBps`/`respondentShareBps` are integer basis points (0–10000),
never floats — this is not a stylistic choice. GenVM's calldata encoding
rejects native float in the LLM response path; the whole schema is bps end
to end (Anchor's contract, API, and Postgres columns) because of it. Do not
convert to a 0–1 float and send it back into anything touching GenLayer.

## Settlement Effect Path

Anchor's decision does not move funds by itself — same posture as the
`genlayer-intelligent-contracts` connector's revocation-effect path.
Specify explicitly how the decision reaches the party that actually holds
the funds:

```ts
type AnchorSettlementEffect = {
  decisionSource: "anchor";
  caseId: string;
  outcome: string;
  claimantShareBps: number;
  respondentShareBps: number;
  settlementChain: string;          // e.g. "solana", "base", "ethereum"
  settlementContract?: `0x${string}` | string;
  relayMechanism: "hyperlane" | "direct_call" | "manual";
  fallback: "human_review" | "escalate_to_arbitration";
};
```

For cross-chain settlement (e.g. the dispute involves a Solana escrow but
adjudication runs on GenLayer), Anchor has a real, live-proven Hyperlane
relay path — not a proposal. See `docs/hyperlane-integration.md` and
`chains/solana/README.md`/`chains/evm/` for the actual deployed contracts
and dispatch mechanics (a real dispute-origination message from a Solana
program through Hyperlane's live Mailbox has been proven on-chain; full
round-trip delivery to an EVM settlement contract is in progress). Point
`relayMechanism: "hyperlane"` deals at that pipeline once it's fully
closed; until then, treat it as `"manual"` for anything shipping today.

## Evidence Schema (agent_data_task_v1)

| Evidence type | Required | Content |
|---|---|---|
| `task_spec` | yes | The agreed task definition |
| `delivery_payload` | yes | What was actually returned |
| `claimant_statement` | yes | Why the claimant disputes the delivery |
| `respondent_statement` | yes | The respondent's defense |
| `delivery_metadata` | no | Timestamps, request/response logs |

Full policy logic (how the checklist comparison works, the reason-code
vocabulary, outcome thresholds): `docs/policy-v1.md` in the Anchor repo.

## Extending to New Policies

The one production policy today (`agent_data_task_v1`) covers agent-to-
agent data task delivery disputes specifically. Internet Court deals will
need others — escrow release, freelance milestones, invoice disputes — the
shapes the original Anchor architecture notes list but haven't been built
yet. When a deal doesn't fit the existing policy:

1. Say so explicitly — do not force-fit evidence into the wrong policy.
2. Sketch the new policy using the same shape: required evidence types,
   allowed outcomes, reason-code vocabulary, decision logic — matching
   `docs/policy-v1.md`'s structure.
3. Flag it as a gap for a human to prioritize building, rather than
   fabricating an API call to a policy that doesn't exist yet.

## Failure and Appeal Paths

- **`UNDETERMINED` consensus**: validators didn't reach agreement, or the
  contract itself returned `UNDETERMINED` (e.g. `SPEC_AMBIGUOUS` reason
  code). No funds should move; escalate to human review or request
  clarified evidence and resubmit.
- **Missing evidence**: `POST /api/cases/:id/adjudicate` returns `400`
  with the specific missing types — resubmit evidence, don't retry blindly.
- **Case not found / wrong status**: `404`/`409` — the case lifecycle
  (`OPEN` → `EVIDENCE_COLLECTION` → `SUBMITTED` → `ADJUDICATING` →
  `ACCEPTED`/`UNDETERMINED`) is strict; don't call adjudicate twice or
  submit evidence after submission.
- No appeal endpoint exists yet in the live API (the case lifecycle design
  anticipates `APPEAL_WINDOW`/`APPEALED` states — see the root README's
  case-lifecycle notes — but it isn't wired to the API today). Treat every
  decision as final until that lands; note this explicitly to the user
  rather than implying an appeal path exists.

## References

- `references/api-quickstart.md` — copy-paste request sequence for the
  full case lifecycle.
- Parent repo docs (resolve relative to wherever Anchor's repo is
  installed/vendored): `docs/decision-schema.md`, `docs/policy-v1.md`,
  `docs/hyperlane-integration.md`, `genlayer/README.md`.
