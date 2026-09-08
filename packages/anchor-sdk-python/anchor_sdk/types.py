from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

SUPPORTED_SETTLEMENT_CHAINS = ("sepolia", "solanatestnet")


@dataclass
class CreateCaseRequest:
    claim: str
    amount: str  # MUST be a decimal string (e.g. "1250.50") — a JSON numeric literal is rejected server-side.
    claimant_ref: str
    respondent_ref: str
    policy_id: Optional[str] = None
    settlement_chain: Optional[str] = None
    settlement_contract: Optional[str] = None
    settlement_solana_claimant: Optional[str] = None
    settlement_solana_respondent: Optional[str] = None
    settlement_solana_escrow_program: Optional[str] = None
    settlement_solana_case_id: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "claim": self.claim,
            "amount": self.amount,
            "claimantRef": self.claimant_ref,
            "respondentRef": self.respondent_ref,
        }
        optional = {
            "policyId": self.policy_id,
            "settlementChain": self.settlement_chain,
            "settlementContract": self.settlement_contract,
            "settlementSolanaClaimant": self.settlement_solana_claimant,
            "settlementSolanaRespondent": self.settlement_solana_respondent,
            "settlementSolanaEscrowProgram": self.settlement_solana_escrow_program,
            "settlementSolanaCaseId": self.settlement_solana_case_id,
        }
        body.update({k: v for k, v in optional.items() if v is not None})
        return body


@dataclass
class SubmitEvidenceRequest:
    type: str
    content: str
    submitted_by: Optional[str] = None  # "claimant" | "respondent"

    def to_json(self) -> Dict[str, Any]:
        body: Dict[str, Any] = {"type": self.type, "content": self.content}
        if self.submitted_by is not None:
            body["submittedBy"] = self.submitted_by
        return body


@dataclass
class CaseRecord:
    id: str
    organization_id: str
    status: str
    claim: str
    amount: str
    currency: str
    policy_id: str
    policy_version: str
    claimant_ref: str
    respondent_ref: str
    contract_address: Optional[str]
    settlement_chain: Optional[str]
    settlement_contract: Optional[str]
    created_at: str
    updated_at: str
    raw: JsonDict = field(default_factory=dict)  # full server payload, in case a field isn't modeled above yet

    @classmethod
    def from_json(cls, data: JsonDict) -> "CaseRecord":
        return cls(
            id=data["id"],
            organization_id=data["organizationId"],
            status=data["status"],
            claim=data["claim"],
            amount=data["amount"],
            currency=data["currency"],
            policy_id=data["policyId"],
            policy_version=data["policyVersion"],
            claimant_ref=data["claimantRef"],
            respondent_ref=data["respondentRef"],
            contract_address=data.get("contractAddress"),
            settlement_chain=data.get("settlementChain"),
            settlement_contract=data.get("settlementContract"),
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
            raw=data,
        )


@dataclass
class CreateCaseResponse(CaseRecord):
    # Only present in the POST /api/cases response — shown once, never retrievable again.
    claimant_token: str = ""
    respondent_token: str = ""

    @classmethod
    def from_json(cls, data: JsonDict) -> "CreateCaseResponse":
        base = CaseRecord.from_json(data)
        return cls(
            **{k: v for k, v in base.__dict__.items() if k != "raw"},
            raw=data,
            claimant_token=data["claimantToken"],
            respondent_token=data["respondentToken"],
        )


@dataclass
class EvidenceRecord:
    id: str
    case_id: str
    type: str
    content_hash: str
    storage_ref: str
    signature_verified: bool
    mime_type: Optional[str]
    file_size_bytes: Optional[int]
    submitted_by: Optional[str]
    attribution_source: str
    created_at: str
    raw: JsonDict = field(default_factory=dict)

    @classmethod
    def from_json(cls, data: JsonDict) -> "EvidenceRecord":
        return cls(
            id=data["id"],
            case_id=data["caseId"],
            type=data["type"],
            content_hash=data["contentHash"],
            storage_ref=data["storageRef"],
            signature_verified=data["signatureVerified"],
            mime_type=data.get("mimeType"),
            file_size_bytes=data.get("fileSizeBytes"),
            submitted_by=data.get("submittedBy"),
            attribution_source=data["attributionSource"],
            created_at=data["createdAt"],
            raw=data,
        )


# The rest of the wire shapes (CaseRecord, EvidenceRecord, OrgAnalytics,
# OrgPolicy, receipts, proof bundles, the settlement export) are returned
# as plain dicts, not dataclasses — same call the TS SDK makes for the
# genuinely open-ended ones (OrgAnalytics, DepositReceipt,
# SettlementReceipt, ProofBundle, ReconciliationExport are all typed
# `[key: string]: unknown` there). Wrapping every field in a dataclass
# here would just be re-guessing a schema neither SDK can verify against
# a real schema source (the routes validate manually, no Zod/pydantic
# models to import). Treat return values as Dict[str, Any] and consult
# docs/api/README.md / the route handlers for the real field list.
JsonDict = Dict[str, Any]
