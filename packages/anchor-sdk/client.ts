import type {
  AdjudicateAcceptedResponse,
  ApiErrorBody,
  CaseRecord,
  CreateCaseRequest,
  CreateCaseResponse,
  DepositReceipt,
  EvidenceRecord,
  OrgAnalytics,
  OrgPolicy,
  ProofBundle,
  ReconciliationExport,
  SettlementReceipt,
  SubmitEvidenceRequest,
} from "./types";
import { AnchorApiError } from "./types";

export interface AnchorClientOptions {
  /** e.g. "https://anchor-testnet.example.com" — no trailing slash. */
  baseUrl: string;
  /** `ak_live_...` key minted via POST /api/api-keys. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Typed wrapper over Anchor's REST API. Every route here is org-scoped by
 * the API key (see apps/web/src/lib/auth.ts's resolveOrgFromRequest) —
 * there is no separate "organization id" parameter to pass.
 *
 * Testnet-only: every case created through this client settles (if at
 * all) on Sepolia or Solana devnet/testnet — see docs/api/README.md's
 * environment-labeling section. This client has no mainnet mode.
 */
export class AnchorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnchorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const body = (await res.json().catch(() => ({ error: "rate limit exceeded" }))) as ApiErrorBody;
      throw new AnchorApiError(
        `rate limited${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
        429,
        body
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as ApiErrorBody;
      throw new AnchorApiError(body.error ?? `request failed with status ${res.status}`, res.status, body);
    }
    return res.json() as Promise<T>;
  }

  private async requestRaw(path: string, init?: RequestInit): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...init?.headers },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as ApiErrorBody;
      throw new AnchorApiError(body.error ?? `request failed with status ${res.status}`, res.status, body);
    }
    return res.text();
  }

  // --- Cases ---
  // POST /api/cases has no server-side idempotency-key mechanism today
  // (checked apps/web/src/app/api/cases/route.ts — it relies on the
  // caller not retrying blindly, same as GET returning no cursor/paging
  // at all: every GET /api/cases response is the org's full case list).
  // This client deliberately does not fabricate either feature client-side.
  createCase(input: CreateCaseRequest): Promise<CreateCaseResponse> {
    return this.request<CreateCaseResponse>("/api/cases", { method: "POST", body: JSON.stringify(input) });
  }

  /** Returns every case for the caller's org — the route has no pagination. */
  listCases(): Promise<CaseRecord[]> {
    return this.request<CaseRecord[]>("/api/cases");
  }

  getCase(caseId: string): Promise<CaseRecord & { evidence: EvidenceRecord[] }> {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}`);
  }

  submitEvidence(caseId: string, input: SubmitEvidenceRequest): Promise<EvidenceRecord> {
    return this.request<EvidenceRecord>(`/api/cases/${encodeURIComponent(caseId)}/evidence`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Returns 202-equivalent immediately — real adjudication runs async (~1-2 min); poll getCase() or subscribe a webhook. */
  requestAdjudication(caseId: string): Promise<AdjudicateAcceptedResponse> {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/adjudicate`, { method: "POST" });
  }

  // --- Org policies (OWNER-only on the server; a non-owner key/session gets 403) ---
  listOrgPolicies(): Promise<OrgPolicy[]> {
    return this.request<OrgPolicy[]>("/api/org-policies");
  }

  // --- Analytics ---
  getAnalytics(sinceDays = 90): Promise<OrgAnalytics> {
    return this.request<OrgAnalytics>(`/api/analytics?sinceDays=${sinceDays}`);
  }

  // --- Receipts / statements ---
  getDepositReceipt(caseId: string): Promise<DepositReceipt> {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/receipt?type=deposit`);
  }

  getSettlementReceipt(caseId: string): Promise<SettlementReceipt> {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/receipt?type=settlement`);
  }

  getCaseStatement(caseId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/statement?type=statement`);
  }

  getProofBundle(caseId: string): Promise<ProofBundle> {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/statement?type=proof-bundle`);
  }

  // --- Org settlement export ---
  getSettlementsCsv(): Promise<string> {
    return this.requestRaw("/api/organizations/settlements/export?format=csv");
  }

  getReconciliationExport(): Promise<ReconciliationExport> {
    return this.request("/api/organizations/settlements/export?format=json");
  }
}
