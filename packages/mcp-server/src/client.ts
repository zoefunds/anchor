// Thin wrapper around Anchor's REST API (apps/web) — every call goes
// through the same API-key auth path an agent would use directly
// (Authorization: Bearer ak_live_...), this MCP server is not a
// privileged shortcut. See apps/web/src/lib/auth.ts's resolveOrgFromRequest
// for what that key can and can't do (rate-limited, org-scoped).

export interface AnchorConfig {
  baseUrl: string;
  apiKey: string;
}

export class AnchorApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "AnchorApiError";
  }
}

export class AnchorClient {
  constructor(private readonly config: AnchorConfig) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; formData?: FormData } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    let body: BodyInit | undefined;
    if (init.formData) {
      body = init.formData; // fetch sets multipart Content-Type + boundary itself
    } else if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    });

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const message = (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `Anchor API request failed (${res.status})`);
      throw new AnchorApiError(message, res.status, parsed);
    }

    return parsed as T;
  }

  listPolicies() {
    return this.request<
      Array<{ id: string; version: string; label: string; description: string; requiredEvidence: { type: string; label: string }[] }>
    >("/api/policies");
  }

  listCases() {
    return this.request<Array<Record<string, unknown>>>("/api/cases");
  }

  getCase(caseId: string) {
    return this.request<Record<string, unknown>>(`/api/cases/${encodeURIComponent(caseId)}`);
  }

  createCase(params: { claim: string; amount: number; claimantRef: string; respondentRef: string; policyId?: string }) {
    return this.request<Record<string, unknown>>("/api/cases", { method: "POST", body: params });
  }

  submitEvidence(caseId: string, params: { type: string; content: string; submittedBy?: "claimant" | "respondent" }) {
    return this.request<Record<string, unknown>>(`/api/cases/${encodeURIComponent(caseId)}/evidence`, {
      method: "POST",
      body: params,
    });
  }

  async submitEvidenceFile(
    caseId: string,
    params: { type: string; fileBytes: Buffer; filename: string; mimeType: string }
  ) {
    const form = new FormData();
    form.set("type", params.type);
    form.set("file", new Blob([new Uint8Array(params.fileBytes)], { type: params.mimeType }), params.filename);
    return this.request<Record<string, unknown>>(`/api/cases/${encodeURIComponent(caseId)}/evidence/upload`, {
      method: "POST",
      formData: form,
    });
  }

  submitForAdjudication(caseId: string) {
    return this.request<{ case: Record<string, unknown>; note: string }>(
      `/api/cases/${encodeURIComponent(caseId)}/adjudicate`,
      { method: "POST" }
    );
  }

  appealCase(caseId: string, reason?: string) {
    return this.request<{ note: string }>(`/api/cases/${encodeURIComponent(caseId)}/appeal`, {
      method: "POST",
      body: { reason },
    });
  }
}
