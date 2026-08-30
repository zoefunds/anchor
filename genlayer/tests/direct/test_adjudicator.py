import json
from pathlib import Path

# Resolved relative to this file, not the invocation cwd. A plain relative
# string like "genlayer/contracts/adjudicator.py" only worked when pytest
# was run from the repo root - and even then broke direct-mode contract
# loading, because `python -m pytest` prepends cwd to sys.path, and the
# repo root contains a directory literally named "genlayer". That shadows
# the real GenVM SDK's "genlayer" package (inserted separately by gltest's
# loader) with an empty namespace package pointing at our own project
# folder, so `from genlayer import *` inside the contract silently fails
# to define `gl` - confirmed by reproducing the loader manually outside
# pytest, where it worked, versus inside pytest at repo root, where it
# didn't. Resolving from __file__ sidesteps the problem regardless of
# which directory pytest is invoked from.
CONTRACT = str(Path(__file__).resolve().parents[2] / "contracts" / "adjudicator.py")


def _mock_llm(direct_vm, response: dict):
    direct_vm.mock_llm(r".*", json.dumps(response))


def test_full_release_agent_data_task(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-1", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    _mock_llm(direct_vm, {
        "outcome": "RELEASE_FULL",
        "claimant_share_bps": 0,
        "respondent_share_bps": 10000,
        "reason_codes": ["SPEC_FULLY_MET"],
        "requirements_total": 3,
        "requirements_met": 3,
    })

    evidence = json.dumps({
        "task_spec": "Return 5 recent BTC/USD trades.",
        "delivery_payload": '[{"price": 65000}]',
        "claimant_statement": "Looks fine but checking.",
        "respondent_statement": "Delivered exactly as asked.",
    })
    contract.adjudicate("agent_data_task_v1", evidence)

    decision = json.loads(contract.get_decision())
    assert decision["outcome"] == "RELEASE_FULL"
    assert decision["policy_id"] == "agent_data_task_v1"
    assert contract.get_status() == "DECIDED"


def test_full_refund_agent_data_task(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-2", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    _mock_llm(direct_vm, {
        "outcome": "REFUND_FULL",
        "claimant_share_bps": 10000,
        "respondent_share_bps": 0,
        "reason_codes": ["SPEC_NOT_MET", "DATA_INCOMPLETE"],
        "requirements_total": 3,
        "requirements_met": 0,
    })

    evidence = json.dumps({
        "task_spec": "Return 5 recent BTC/USD trades.",
        "delivery_payload": "[]",
        "claimant_statement": "Nothing was returned.",
        "respondent_statement": "Upstream outage.",
    })
    contract.adjudicate("agent_data_task_v1", evidence)

    decision = json.loads(contract.get_decision())
    assert decision["outcome"] == "REFUND_FULL"
    assert "SPEC_NOT_MET" in decision["reason_codes"]


def test_escrow_release_policy(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-3", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    _mock_llm(direct_vm, {
        "outcome": "RELEASE_PARTIAL",
        "claimant_share_bps": 3000,
        "respondent_share_bps": 7000,
        "reason_codes": ["MILESTONE_PARTIALLY_MET"],
        "requirements_total": 4,
        "requirements_met": 3,
    })

    evidence = json.dumps({
        "milestone_spec": "Ship a working login page with email/password auth.",
        "deliverable": "Login page shipped, but password reset flow missing.",
        "claimant_statement": "Password reset was part of the milestone.",
        "respondent_statement": "Password reset was a stretch goal, not required.",
    })
    contract.adjudicate("escrow_release_v1", evidence)

    decision = json.loads(contract.get_decision())
    assert decision["policy_id"] == "escrow_release_v1"
    assert decision["outcome"] == "RELEASE_PARTIAL"
    assert decision["respondent_share_bps"] == 7000


def test_invoice_dispute_policy(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-4", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    _mock_llm(direct_vm, {
        "outcome": "REFUND_FULL",
        "claimant_share_bps": 10000,
        "respondent_share_bps": 0,
        "reason_codes": ["OBLIGATIONS_NOT_MET", "DELIVERY_UNVERIFIED"],
        "requirements_total": 2,
        "requirements_met": 0,
    })

    evidence = json.dumps({
        "invoice_terms": "50 units of widget X, net-30, delivered to warehouse B.",
        "delivery_record": "No delivery record found for this PO.",
        "claimant_statement": "We never received these goods.",
        "respondent_statement": "Our logs show a delivery attempt but no confirmation.",
    })
    contract.adjudicate("invoice_dispute_v1", evidence)

    decision = json.loads(contract.get_decision())
    assert decision["policy_id"] == "invoice_dispute_v1"
    assert decision["outcome"] == "REFUND_FULL"


def test_rejects_unknown_policy(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-5", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]"):
        contract.adjudicate("not_a_real_policy", json.dumps({}))


def test_rejects_missing_required_evidence(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-6", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    evidence = json.dumps({"task_spec": "Return trades.", "delivery_payload": ""})
    with direct_vm.expect_revert("[EXPECTED]"):
        contract.adjudicate("agent_data_task_v1", evidence)


def test_rejects_malformed_evidence_json(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-7", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]"):
        contract.adjudicate("agent_data_task_v1", "not json")


def test_rejects_re_adjudication_of_decided_case(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-8", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    _mock_llm(direct_vm, {
        "outcome": "RELEASE_FULL",
        "claimant_share_bps": 0,
        "respondent_share_bps": 10000,
        "reason_codes": ["SPEC_FULLY_MET"],
        "requirements_total": 3,
        "requirements_met": 3,
    })
    evidence = json.dumps({
        "task_spec": "spec", "delivery_payload": "payload",
        "claimant_statement": "stmt", "respondent_statement": "stmt",
    })
    contract.adjudicate("agent_data_task_v1", evidence)

    with direct_vm.expect_revert("already decided"):
        contract.adjudicate("agent_data_task_v1", evidence)


def test_malformed_llm_json_raises_llm_error(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-9", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    direct_vm.mock_llm(r".*", "not json at all, just prose")

    evidence = json.dumps({
        "task_spec": "spec", "delivery_payload": "payload",
        "claimant_statement": "stmt", "respondent_statement": "stmt",
    })
    with direct_vm.expect_revert("[LLM_ERROR]"):
        contract.adjudicate("agent_data_task_v1", evidence)


def test_appeal_allows_one_re_adjudication(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-10", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    _mock_llm(direct_vm, {
        "outcome": "RELEASE_FULL",
        "claimant_share_bps": 0,
        "respondent_share_bps": 10000,
        "reason_codes": ["SPEC_FULLY_MET"],
        "requirements_total": 3,
        "requirements_met": 3,
    })
    evidence = json.dumps({
        "task_spec": "spec", "delivery_payload": "payload",
        "claimant_statement": "stmt", "respondent_statement": "stmt",
    })
    contract.adjudicate("agent_data_task_v1", evidence)
    assert contract.get_status() == "DECIDED"
    assert contract.get_appeal_count() == 0

    contract.appeal()
    assert contract.get_status() == "PENDING"
    assert contract.get_appeal_count() == 1
    assert contract.get_decision() == ""

    direct_vm.clear_mocks()
    _mock_llm(direct_vm, {
        "outcome": "REFUND_FULL",
        "claimant_share_bps": 10000,
        "respondent_share_bps": 0,
        "reason_codes": ["SPEC_NOT_MET"],
        "requirements_total": 3,
        "requirements_met": 0,
    })
    new_evidence = json.dumps({
        "task_spec": "spec", "delivery_payload": "payload",
        "claimant_statement": "new evidence surfaced on appeal", "respondent_statement": "stmt",
    })
    contract.adjudicate("agent_data_task_v1", new_evidence)

    decision = json.loads(contract.get_decision())
    assert decision["outcome"] == "REFUND_FULL"
    assert contract.get_status() == "DECIDED"


def test_rejects_appeal_beyond_limit(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-11", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    _mock_llm(direct_vm, {
        "outcome": "RELEASE_FULL",
        "claimant_share_bps": 0,
        "respondent_share_bps": 10000,
        "reason_codes": ["SPEC_FULLY_MET"],
        "requirements_total": 3,
        "requirements_met": 3,
    })
    evidence = json.dumps({
        "task_spec": "spec", "delivery_payload": "payload",
        "claimant_statement": "stmt", "respondent_statement": "stmt",
    })
    contract.adjudicate("agent_data_task_v1", evidence)
    contract.appeal()
    contract.adjudicate("agent_data_task_v1", evidence)

    with direct_vm.expect_revert("Appeal limit reached"):
        contract.appeal()


def test_rejects_appeal_before_decided(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT, "CASE-12", "party_A", "party_B", 10**18)
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("is not in a decided state"):
        contract.appeal()
