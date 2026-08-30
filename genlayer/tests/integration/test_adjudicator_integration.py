"""
Integration tests for Adjudicator against a real GenLayer environment (full
leader + validator consensus, real LLM calls — no mocking). Slower and
rate-limited on StudioNet (60 req/min), so kept to a handful of cases: the
exact RELEASE_FULL/REFUND_FULL scenarios already proven manually via the
CLI, plus one exercising the multimodal image-evidence path added for file
uploads (see genlayer/contracts/adjudicator.py's _resolve_evidence). See
genlayer/README.md for the manual run this mirrors and the deploy-header
bug it uncovered.

Run: gltest tests/integration/ -v -s --network studionet

NOTE: adjudicate()'s signature is (policy_id: str, evidence_json: str) -
one JSON object of {evidence_type: value}, not positional args per field.
This changed when the contract became multi-policy; these tests were
stale against the old 4-positional-arg signature until fixed alongside
the local pytest harness issue (see direct/test_adjudicator.py's comment
on the CONTRACT path collision).
"""

import json
import time

import pytest
from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded


def _deploy_with_retry(factory, args, attempts: int = 4, delay_seconds: float = 5.0):
    """factory.deploy() reads the contract schema right after the deploy
    tx is accepted, via gen_getContractSchema - but StudioNet's schema
    indexer can lag a few seconds behind the tx itself being queryable
    (confirmed: a deploy that failed this way here resolved fine via
    `genlayer schema <address>` moments later). Retrying absorbs that
    race instead of failing the whole suite on indexer lag."""
    last_error = None
    for attempt in range(attempts):
        try:
            return factory.deploy(args=args)
        except ValueError as e:
            if "Failed to get schema" not in str(e):
                raise
            last_error = e
            if attempt < attempts - 1:
                time.sleep(delay_seconds)
    raise last_error


TASK_SPEC = (
    "Return a JSON array of the 5 most recent BTC/USD trades from exchange X, "
    "each with timestamp, price, and volume."
)

FULL_DELIVERY = json.dumps(
    [
        {"timestamp": f"2026-08-30T00:00:0{i}Z", "price": 65000 + i, "volume": 1.2}
        for i in range(5)
    ]
)
EMPTY_DELIVERY = "[]"

# Real, stable, publicly-fetchable images used to prove the contract's live
# image-interpretation path (gl.nondet.web.get + exec_prompt images=) - the
# same URLs used for the manual live proof during development.
CAT_IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg"
DOG_IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/6/6e/Golde33443.jpg"


@pytest.mark.slow
def test_release_full_on_studionet():
    factory = get_contract_factory("Adjudicator")
    contract = _deploy_with_retry(factory, ["CASE-IT-1", "party_A", "party_B", 10**18])

    evidence = json.dumps(
        {
            "task_spec": TASK_SPEC,
            "delivery_payload": FULL_DELIVERY,
            "claimant_statement": "The delivered trades look plausible and match the requested exchange.",
            "respondent_statement": "I delivered exactly 5 recent trades with timestamp, price, and volume as specified.",
        }
    )
    tx_receipt = contract.adjudicate(args=["agent_data_task_v1", evidence]).transact()
    assert tx_execution_succeeded(tx_receipt)

    decision = json.loads(contract.get_decision(args=[]).call())
    assert decision["case_id"] == "CASE-IT-1"
    assert decision["policy_id"] == "agent_data_task_v1"
    assert decision["outcome"] in ("RELEASE_FULL", "RELEASE_PARTIAL")
    assert decision["consensus"] == "ACCEPTED"
    assert decision["respondent_share_bps"] + decision["claimant_share_bps"] == 10000

    assert contract.get_status(args=[]).call() == "DECIDED"


@pytest.mark.slow
def test_refund_full_on_studionet():
    factory = get_contract_factory("Adjudicator")
    contract = _deploy_with_retry(factory, ["CASE-IT-2", "party_A", "party_B", 10**18])

    evidence = json.dumps(
        {
            "task_spec": TASK_SPEC,
            "delivery_payload": EMPTY_DELIVERY,
            "claimant_statement": "Nothing was delivered at all — the response is an empty array.",
            "respondent_statement": "There was an upstream outage and I could not complete the task.",
        }
    )
    tx_receipt = contract.adjudicate(args=["agent_data_task_v1", evidence]).transact()
    assert tx_execution_succeeded(tx_receipt)

    decision = json.loads(contract.get_decision(args=[]).call())
    assert decision["case_id"] == "CASE-IT-2"
    assert decision["outcome"] in ("REFUND_FULL", "REFUND_PARTIAL")
    assert decision["consensus"] == "ACCEPTED"
    assert decision["claimant_share_bps"] > decision["respondent_share_bps"]


@pytest.mark.slow
def test_image_evidence_matching_spec_releases_full_on_studionet():
    """A real image URL as evidence.deliverable - the contract fetches it
    live (gl.nondet.web.get) and passes actual bytes into exec_prompt as
    genuine visual input. The milestone spec requires a cat photo; the
    deliverable genuinely is one, so this should release in full."""
    factory = get_contract_factory("Adjudicator")
    contract = _deploy_with_retry(factory, ["CASE-IT-3", "party_A", "party_B", 10**18])

    evidence = json.dumps(
        {
            "milestone_spec": (
                "The deliverable must be a photograph that clearly shows a cat "
                "(feline). A photo of any other animal, or no animal, does not "
                "meet spec."
            ),
            "deliverable": CAT_IMAGE_URL,
            "claimant_statement": "The provider was paid to deliver a photo of a cat for our pet-adoption catalog listing.",
            "respondent_statement": "I delivered exactly what was requested — see the attached photo.",
        }
    )
    tx_receipt = contract.adjudicate(args=["escrow_release_v1", evidence]).transact()
    assert tx_execution_succeeded(tx_receipt)

    decision = json.loads(contract.get_decision(args=[]).call())
    assert decision["outcome"] == "RELEASE_FULL"
    assert decision["consensus"] == "ACCEPTED"
    assert "MILESTONE_FULLY_MET" in decision["reason_codes"]


@pytest.mark.slow
def test_image_evidence_mismatching_spec_refunds_full_on_studionet():
    """Same spec (must be a cat), but the deliverable image is a dog - a
    genuine visual mismatch the model can only catch by actually seeing
    the image, not by pattern-matching on 'a URL was provided'."""
    factory = get_contract_factory("Adjudicator")
    contract = _deploy_with_retry(factory, ["CASE-IT-4", "party_A", "party_B", 10**18])

    evidence = json.dumps(
        {
            "milestone_spec": (
                "The deliverable must be a photograph that clearly shows a cat "
                "(feline). A photo of any other animal, or no animal, does not "
                "meet spec."
            ),
            "deliverable": DOG_IMAGE_URL,
            "claimant_statement": "The provider was paid to deliver a photo of a cat for our pet-adoption catalog listing.",
            "respondent_statement": "I delivered exactly what was requested — see the attached photo.",
        }
    )
    tx_receipt = contract.adjudicate(args=["escrow_release_v1", evidence]).transact()
    assert tx_execution_succeeded(tx_receipt)

    decision = json.loads(contract.get_decision(args=[]).call())
    assert decision["outcome"] == "REFUND_FULL"
    assert decision["consensus"] == "ACCEPTED"
    assert "MILESTONE_NOT_MET" in decision["reason_codes"]
