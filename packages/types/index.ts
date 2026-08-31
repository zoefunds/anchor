// Shared types for Anchor's case/evidence/policy/decision pipeline.
// Mirrors docs/decision-schema.md and docs/policy-v1.md — keep in sync.

export type CaseStatus =
  | "OPEN"
  | "EVIDENCE_COLLECTION"
  | "SUBMITTED"
  | "ADJUDICATING"
  | "ACCEPTED"
  | "APPEAL_WINDOW"
  | "APPEALED"
  | "RE_ADJUDICATING"
  | "FINALIZED"
  | "UNDETERMINED"
  | "CANCELLED";

// Plain string, not a fixed union: which evidence types are valid depends
// on the case's policy (see apps/web/src/lib/policies.ts and the POLICIES
// registry in genlayer/contracts/adjudicator.py) - the set grew per-policy
// once Anchor supported more than agent_data_task_v1.
export type EvidenceType = string;

export type Outcome =
  | "RELEASE_FULL"
  | "RELEASE_PARTIAL"
  | "REFUND_FULL"
  | "REFUND_PARTIAL"
  | "SPLIT"
  | "REJECT"
  | "REQUEST_MORE_EVIDENCE"
  | "ESCALATE_HUMAN"
  | "UNDETERMINED";

export type ReasonCode =
  | "SPEC_FULLY_MET"
  | "SPEC_PARTIALLY_MET"
  | "SPEC_NOT_MET"
  | "DATA_INCOMPLETE"
  | "DATA_MALFORMED"
  | "DATA_STALE"
  | "SPEC_AMBIGUOUS"
  | "INSUFFICIENT_EVIDENCE";

export interface Party {
  /** Pseudonymous reference only — never a real identity. See privacy note below. */
  ref: string;
  role: "claimant" | "respondent";
}

export interface Case {
  id: string;
  status: CaseStatus;
  claim: string;
  amount: number;
  currency: string;
  policyId: string;
  policyVersion: string;
  claimant: Party;
  respondent: Party;
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  id: string;
  caseId: string;
  type: EvidenceType;
  contentHash: string;
  storageRef: string;
  submittedBy: "claimant" | "respondent" | "system";
  createdAt: string;
}

export interface Decision {
  caseId: string;
  policyId: string;
  policyVersion: string;
  outcome: Outcome;
  /**
   * Integer basis points (0-10000), NOT a float — mirrors the GenLayer
   * contract's wire format. GenVM's calldata encoding rejects native float
   * (confirmed via direct-mode contract tests, see docs/decision-schema.md),
   * so the contract, and this type, carry bps. Convert to a 0-1 fraction
   * only at a display/analytics boundary, never send a float back to GenLayer.
   */
  claimantShareBps?: number;
  respondentShareBps?: number;
  reasonCodes: ReasonCode[];
  evidenceUsed: string[];
  /**
   * sha256 of the exact evidence_json calldata the contract adjudicated
   * against (see adjudicator.py's adjudicate()) — deterministic, computed
   * on-chain, not the nondeterministic LLM output. This is the real proof
   * a decision is bound to specific evidence: anyone holding the evidence
   * can recompute this hash and check it against what's permanently
   * recorded on-chain, instead of trusting Anchor's own database that it
   * adjudicated on the evidence it claims to have.
   */
  evidenceHash?: string;
  consensus: "ACCEPTED" | "UNDETERMINED";
  confidence?: number;
  appealWindowClosesAt?: string;
  proofHash?: string;
  explanation?: string;
}

// Anchor never sends real party identities to GenLayer. Case/party refs sent
// to the Intelligent Contract are pseudonymous IDs (e.g. "party_7F82A"); the
// mapping back to a real account lives only in Anchor's own database.
export interface AdjudicationRequest {
  caseId: string;
  policyId: string;
  policyVersion: string;
  claim: string;
  amount: number;
  claimantRef: string;
  respondentRef: string;
  evidence: Array<{
    id: string;
    type: EvidenceType;
    contentHash: string;
    /** Inline content or excerpt — only what the contract needs, not the raw file. */
    content: string;
  }>;
  allowedOutcomes: Outcome[];
}
