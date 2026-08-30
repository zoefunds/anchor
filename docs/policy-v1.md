# Policy: agent_data_task_v1

Governs disputes where Agent A (claimant) paid Agent B (respondent) to
perform a data/API task, and Agent A disputes that the delivery met the
agreed spec.

## Required evidence types

| id pattern | type              | required | description                                  |
|-----------|-------------------|----------|-----------------------------------------------|
| E1        | task_spec         | yes      | The agreed task definition (what was ordered) |
| E2        | delivery_payload  | yes      | What Agent B actually returned                |
| E3        | claimant_statement| yes      | Why Agent A disputes the delivery             |
| E4        | respondent_statement | yes   | Agent B's response to the dispute             |
| E5        | delivery_metadata | no       | Timestamps, request/response logs, schema used|

A case cannot move from `EVIDENCE_COLLECTION` to `SUBMITTED` until every
required evidence type is present.

## Allowed outcomes for this policy

`RELEASE_FULL`, `RELEASE_PARTIAL`, `REFUND_FULL`, `REFUND_PARTIAL`,
`REQUEST_MORE_EVIDENCE`, `UNDETERMINED`

(`ESCALATE_HUMAN` and `REJECT` are not offered in v1 — no human review queue
exists yet in the MVP; the contract must resolve to one of the outcomes
above or `UNDETERMINED`.)

## Reason code vocabulary

- `SPEC_FULLY_MET` — delivery satisfies every requirement in the task spec
- `SPEC_PARTIALLY_MET` — delivery satisfies some but not all requirements
- `SPEC_NOT_MET` — delivery does not satisfy the task spec
- `DATA_INCOMPLETE` — delivery is missing required fields/records
- `DATA_MALFORMED` — delivery does not match the agreed schema/format
- `DATA_STALE` — delivery uses out-of-date source data where freshness was specified
- `SPEC_AMBIGUOUS` — the task spec itself does not clearly define success criteria
- `INSUFFICIENT_EVIDENCE` — evidence bundle does not allow a confident determination

## Decision logic (what the Intelligent Contract evaluates)

1. Parse E1 (task spec) into a checklist of concrete, checkable requirements.
2. Compare E2 (delivery) against each requirement.
3. Weigh E3/E4 (party statements) only where the spec/delivery comparison is
   ambiguous — statements do not override observable evidence.
4. Compute the fraction of requirements met → maps to outcome + shares
   (as integer basis points, 0–10000 — see `decision-schema.md` on why not
   float):
   - 100% met → `RELEASE_FULL`, reason `SPEC_FULLY_MET`
   - 0% met → `REFUND_FULL`, reason `SPEC_NOT_MET`
   - partial → `RELEASE_PARTIAL`/`REFUND_PARTIAL` with
     `claimant_share_bps` / `respondent_share_bps` proportional to
     requirements met, reason `SPEC_PARTIALLY_MET` plus the specific
     failure reason codes
   - spec too ambiguous to checklist → `UNDETERMINED`, reason `SPEC_AMBIGUOUS`
   - required evidence missing/contradictory beyond repair → `REQUEST_MORE_EVIDENCE`,
     reason `INSUFFICIENT_EVIDENCE`

## Versioning

Every decision permanently records `policy_id` + `policy_version` + a hash of
this document (or its structured equivalent). Changing the logic above
requires a new version (`1.1.0`, `2.0.0`, ...); existing cases keep resolving
under the policy version they were submitted with.
