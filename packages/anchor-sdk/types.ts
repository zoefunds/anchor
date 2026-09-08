// Request/response shapes hand-derived from the actual route handlers
// under apps/web/src/app/api/**/route.ts (that codebase validates
// request bodies with plain manual checks, not Zod, so there are no
// schema objects to import/derive from — these types are kept in sync
// by hand against each route's own validation and NextResponse.json
// shape; the round-trip test in test/contract.test.ts is what catches
// drift).

export type CaseStatus =
  | "OPEN"
  | "EVIDENCE_COLLECTION"
  | "ADJUDICATING"
  | "APPEAL_WINDOW"
  | "DECIDED"
  | "SETTLED"
  | "CLOSED";

export const SUPPORTED_SETTLEMENT_CHAINS = ["sepolia", "solanatestnet"] as const;
export type SettlementChain = (typeof SUPPORTED_SETTLEMENT_CHAINS)[number];

export interface CreateCaseRequest {
  claim: string;
  /** MUST be a decimal string (e.g. "1250.50") — a JSON numeric literal is rejected server-side. */
  amount: string;
  claimantRef: string;
  respondentRef: string;
  policyId?: string;
  settlementChain?: SettlementChain;
  settlementContract?: string;
  settlementSolanaClaimant?: string;
  settlementSolanaRespondent?: string;
  settlementSolanaEscrowProgram?: string;
  settlementSolanaCaseId?: string;
}

export interface CaseRecord {
  id: string;
  organizationId: string;
  status: CaseStatus;
  claim: string;
  amount: string;
  currency: string;
  policyId: string;
  policyVersion: string;
  claimantRef: string;
  respondentRef: string;
  contractAddress: string | null;
  settlementChain: string | null;
  settlementContract: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Only present in the POST /api/cases response — shown once, never retrievable again. */
export interface CreateCaseResponse extends CaseRecord {
  claimantToken: string;
  respondentToken: string;
}

export interface EvidenceRecord {
  id: string;
  caseId: string;
  type: string;
  contentHash: string;
  storageRef: string;
  signatureVerified: boolean;
  mimeType: string | null;
  fileSizeBytes: number | null;
  submittedBy: "claimant" | "respondent" | null;
  attributionSource: string;
  createdAt: string;
}

export interface SubmitEvidenceRequest {
  type: string;
  content: string;
  submittedBy?: "claimant" | "respondent";
}

export interface AdjudicateAcceptedResponse extends CaseRecord {
  status: "ADJUDICATING";
}

export interface OrgAnalytics {
  // computeOrgAnalytics's return shape varies by metric bucket; kept
  // intentionally loose here rather than guessing every field — callers
  // should treat this as "parsed JSON, org-scoped, see GET /api/analytics
  // in the docs for the full field list."
  sinceDays: number;
  [key: string]: unknown;
}

export interface OrgPolicyVersion {
  id: string;
  version: number;
  velocityLimits: unknown;
  humanReviewTriggers: unknown;
  allowedChains: string[];
  allowedOutcomes: string[];
  createdAt: string;
}

export interface OrgPolicy {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  versions: OrgPolicyVersion[];
  createdAt: string;
}

export interface DepositReceipt {
  [key: string]: unknown;
}
export interface SettlementReceipt {
  [key: string]: unknown;
}
export interface CaseStatement {
  [key: string]: unknown;
}
export interface ProofBundle {
  [key: string]: unknown;
}
export interface ReconciliationExport {
  [key: string]: unknown;
}

export interface ApiErrorBody {
  error: string;
  [key: string]: unknown;
}

export class AnchorApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: ApiErrorBody
  ) {
    super(message);
    this.name = "AnchorApiError";
  }
}
