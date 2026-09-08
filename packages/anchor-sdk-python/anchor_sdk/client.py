from typing import Any, Dict, List, Optional
from urllib.parse import quote

import requests

from .errors import AnchorApiError
from .types import (
    CaseRecord,
    CreateCaseRequest,
    CreateCaseResponse,
    EvidenceRecord,
    JsonDict,
    SubmitEvidenceRequest,
)


class AnchorClient:
    """
    Typed wrapper over Anchor's REST API. Every route here is org-scoped
    by the API key (see apps/web/src/lib/auth.ts's resolveOrgFromRequest)
    — there is no separate "organization id" parameter to pass.

    Mirrors packages/anchor-sdk/client.ts's coverage exactly: cases,
    evidence, adjudication requests, org policies (read), analytics,
    receipts/statements, and the org settlement export. Does NOT cover
    decisions (review/appeal), org-policy writes, settlement-
    integrations, webhook management, api-keys management,
    members/invites, ops-console, or reconciliation-findings — same
    scope boundary the TS SDK documents, not a Python-specific gap.

    Testnet-only: every case created through this client settles (if at
    all) on Sepolia or Solana devnet/testnet. This client has no
    mainnet mode.
    """

    def __init__(self, base_url: str, api_key: str, session: Optional[requests.Session] = None, timeout: float = 30.0):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._session = session or requests.Session()
        self._timeout = timeout

    def _headers(self, has_body: bool) -> Dict[str, str]:
        headers = {"Authorization": f"Bearer {self._api_key}"}
        if has_body:
            headers["Content-Type"] = "application/json"
        return headers

    def _request(self, method: str, path: str, json_body: Optional[JsonDict] = None) -> Any:
        res = self._session.request(
            method,
            f"{self._base_url}{path}",
            headers=self._headers(json_body is not None),
            json=json_body,
            timeout=self._timeout,
        )
        if res.status_code == 429:
            retry_after = res.headers.get("Retry-After")
            try:
                body = res.json()
            except ValueError:
                body = {"error": "rate limit exceeded"}
            message = "rate limited" + (f" — retry after {retry_after}s" if retry_after else "")
            raise AnchorApiError(message, 429, body)
        if not res.ok:
            try:
                body = res.json()
            except ValueError:
                body = {"error": res.reason}
            raise AnchorApiError(body.get("error", f"request failed with status {res.status_code}"), res.status_code, body)
        if not res.content:
            return None
        return res.json()

    def _request_raw(self, method: str, path: str) -> str:
        res = self._session.request(method, f"{self._base_url}{path}", headers=self._headers(False), timeout=self._timeout)
        if not res.ok:
            try:
                body = res.json()
            except ValueError:
                body = {"error": res.reason}
            raise AnchorApiError(body.get("error", f"request failed with status {res.status_code}"), res.status_code, body)
        return res.text

    # --- Cases ---
    # POST /api/cases has no server-side idempotency-key mechanism today
    # (see packages/anchor-sdk/client.ts's identical note, checked
    # against apps/web/src/app/api/cases/route.ts) — this client does
    # not fabricate one either. Same for pagination: GET /api/cases
    # returns the org's entire case list, no cursor/offset.
    def create_case(self, input: CreateCaseRequest) -> CreateCaseResponse:
        data = self._request("POST", "/api/cases", input.to_json())
        return CreateCaseResponse.from_json(data)

    def list_cases(self) -> List[CaseRecord]:
        """Returns every case for the caller's org — the route has no pagination."""
        data = self._request("GET", "/api/cases")
        return [CaseRecord.from_json(item) for item in data]

    def get_case(self, case_id: str) -> JsonDict:
        """Returns the case merged with its evidence list, as the route does — kept as a dict since it's not a plain CaseRecord."""
        return self._request("GET", f"/api/cases/{quote(case_id, safe='')}")

    def submit_evidence(self, case_id: str, input: SubmitEvidenceRequest) -> EvidenceRecord:
        data = self._request("POST", f"/api/cases/{quote(case_id, safe='')}/evidence", input.to_json())
        return EvidenceRecord.from_json(data)

    def request_adjudication(self, case_id: str) -> JsonDict:
        """Returns immediately — real adjudication runs async (~1-2 min); poll get_case() or subscribe a webhook."""
        return self._request("POST", f"/api/cases/{quote(case_id, safe='')}/adjudicate")

    # --- Org policies (OWNER-only on the server; a non-owner key/session gets 403) ---
    def list_org_policies(self) -> List[JsonDict]:
        return self._request("GET", "/api/org-policies")

    # --- Analytics ---
    def get_analytics(self, since_days: int = 90) -> JsonDict:
        return self._request("GET", f"/api/analytics?sinceDays={since_days}")

    # --- Receipts / statements ---
    def get_deposit_receipt(self, case_id: str) -> JsonDict:
        return self._request("GET", f"/api/cases/{quote(case_id, safe='')}/receipt?type=deposit")

    def get_settlement_receipt(self, case_id: str) -> JsonDict:
        return self._request("GET", f"/api/cases/{quote(case_id, safe='')}/receipt?type=settlement")

    def get_case_statement(self, case_id: str) -> JsonDict:
        return self._request("GET", f"/api/cases/{quote(case_id, safe='')}/statement?type=statement")

    def get_proof_bundle(self, case_id: str) -> JsonDict:
        return self._request("GET", f"/api/cases/{quote(case_id, safe='')}/statement?type=proof-bundle")

    # --- Org settlement export ---
    def get_settlements_csv(self) -> str:
        return self._request_raw("GET", "/api/organizations/settlements/export?format=csv")

    def get_reconciliation_export(self) -> JsonDict:
        return self._request("GET", "/api/organizations/settlements/export?format=json")
