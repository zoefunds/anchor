# Decision schema — v1

Every adjudication returns this shape. The Intelligent Contract must produce
exactly this structure; nothing else is trusted as the machine-actionable
result. A separate `explanation` string may accompany it for humans but never
drives execution.

```json
{
  "case_id": "CASE-84921",
  "policy_id": "agent_data_task_v1",
  "policy_version": "1.0.0",

  "outcome": "PARTIAL_REFUND",
  "claimant_share_bps": 6500,
  "respondent_share_bps": 3500,

  "reason_codes": ["SPEC_PARTIALLY_MET", "DATA_INCOMPLETE"],
  "evidence_used": ["E1", "E3", "E4"],

  "consensus": "ACCEPTED",
  "confidence": 0.83,

  "appeal_window_closes_at": "2026-08-31T12:00:00Z",
  "proof_hash": "0x..."
}
```

## Fields

- `outcome` — one of `RELEASE_FULL`, `RELEASE_PARTIAL`, `REFUND_FULL`,
  `REFUND_PARTIAL`, `SPLIT`, `REJECT`, `REQUEST_MORE_EVIDENCE`,
  `ESCALATE_HUMAN`, `UNDETERMINED`. Anchor never returns free-form outcomes —
  the policy declares which of these are legal for a given case type.
- `claimant_share_bps` / `respondent_share_bps` — integer basis points
  (0–10000, sum to 10000) of the disputed amount attributed to each party.
  Only meaningful for split/refund/release outcomes. **Integer, not
  float** — GenVM's calldata encoding (which an Intelligent Contract's LLM
  response passes through) rejects native `float`; confirmed empirically via
  direct-mode contract tests. Any float representation used elsewhere
  (Anchor's Postgres `Decision.claimantShare` as 0.0–1.0, for UI/analytics
  convenience) is derived by dividing by 10000 at the boundary — the
  contract and wire format never carry a float.
- `reason_codes` — a fixed vocabulary per policy (see `policy-v1.md`), not
  free text. Lets Anchor aggregate analytics across cases without parsing
  prose.
- `evidence_used` — evidence IDs the decision actually relied on, so every
  decision is auditable against its inputs.
- `consensus` — `ACCEPTED` or `UNDETERMINED` (GenLayer's Optimistic Democracy
  outcome for this round — see GenLayer docs on leader/validator evaluation).
- `proof_hash` — hash of the finalized on-chain decision record, so Anchor's
  off-chain copy is independently checkable against GenLayer state.

## Non-goals for this schema

- It is not a legal ruling. Anchor's positioning is contractual/agreed
  adjudication infrastructure, not a court — GenLayer's own docs make the
  same distinction.
- It does not itself move funds. Execution (refund/release) is a separate,
  later concern once the MVP proves the decision pipeline.
