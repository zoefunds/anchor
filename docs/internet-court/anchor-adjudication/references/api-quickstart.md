# Anchor API quickstart

Full case lifecycle, copy-paste ready. Assumes Anchor's API is reachable at
`$ANCHOR_API` (e.g. `http://localhost:3000` for local dev — see the parent
repo's `apps/web/README`-equivalent setup in the root README).

This exact sequence has been run live end to end, including the real
GenLayer adjudication call — not a hypothetical spec. See the parent
session's real run for the shape of a real response.

## 1. Open a case

```bash
curl -s $ANCHOR_API/api/cases -X POST -H "Content-Type: application/json" -d '{
  "claim": "service_not_delivered",
  "amount": 1000,
  "claimantRef": "party_A",
  "respondentRef": "party_B"
}'
```

Returns the created case with `status: "EVIDENCE_COLLECTION"` and an `id`.
Use that `id` (`$CASE_ID` below) for every subsequent call.

## 2. Submit evidence (all four required for agent_data_task_v1)

```bash
curl -s $ANCHOR_API/api/cases/$CASE_ID/evidence -X POST -H "Content-Type: application/json" -d '{
  "type": "task_spec",
  "content": "Return a JSON array of the 5 most recent BTC/USD trades from exchange X, each with timestamp, price, and volume."
}'

curl -s $ANCHOR_API/api/cases/$CASE_ID/evidence -X POST -H "Content-Type: application/json" -d '{
  "type": "delivery_payload",
  "content": "[]"
}'

curl -s $ANCHOR_API/api/cases/$CASE_ID/evidence -X POST -H "Content-Type: application/json" -d '{
  "type": "claimant_statement",
  "content": "Nothing was delivered at all."
}'

curl -s $ANCHOR_API/api/cases/$CASE_ID/evidence -X POST -H "Content-Type: application/json" -d '{
  "type": "respondent_statement",
  "content": "There was an upstream outage and I could not complete the task."
}'
```

## 3. Submit for adjudication

```bash
curl -s $ANCHOR_API/api/cases/$CASE_ID/adjudicate -X POST -H "Content-Type: application/json"
```

Returns `202` immediately:
```json
{
  "case": { "id": "...", "status": "ADJUDICATING", ... },
  "note": "Adjudication started. Poll GET /api/cases/:id for status/decision."
}
```

## 4. Poll for the decision

```bash
curl -s $ANCHOR_API/api/cases/$CASE_ID
```

Poll until `status` is no longer `ADJUDICATING` (real consensus takes
~1-2 minutes). A real completed response looks like:

```json
{
  "id": "...",
  "status": "ACCEPTED",
  "contractAddress": "0x...",
  "decision": {
    "outcome": "REFUND_FULL",
    "claimantShareBps": 10000,
    "respondentShareBps": 0,
    "reasonCodes": ["SPEC_NOT_MET", "DATA_INCOMPLETE"],
    "consensus": "ACCEPTED"
  }
}
```

`contractAddress` is the actual deployed GenLayer Intelligent Contract
instance for this case — independently verifiable via GenLayer's own CLI
(`genlayer schema <address>`, `genlayer call <address> get_decision`)
against whichever GenLayer network Anchor's backend is configured for.
