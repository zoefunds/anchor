"use client";

import { useEffect, useState } from "react";

interface Verification {
  id: string;
  caseId: string;
  role: "claimant" | "respondent";
  provider: string;
  providerReference: string | null;
  sessionId: string;
  status: string;
  jurisdiction: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  case: { claim: string };
}

const OVERRIDE_REASONS = [
  { value: "PROVIDER_OUTAGE", label: "Provider outage" },
  { value: "PROVIDER_DATA_ERROR", label: "Provider data error" },
  { value: "DOCUMENTED_EXCEPTION_APPROVED_BY_COMPLIANCE", label: "Documented exception (compliance-approved)" },
];

const STATUS_FILTERS = ["all", "NOT_STARTED", "IN_PROGRESS", "IN_REVIEW", "APPROVED", "DECLINED", "EXPIRED", "ABANDONED"] as const;

export default function KycVerificationsPage() {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  async function load() {
    const qs = status === "all" ? "" : `?status=${status}`;
    const res = await fetch(`/api/kyc/verifications${qs}`);
    if (res.ok) setVerifications(await res.json());
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function override(v: Verification, toStatus: "APPROVED" | "DECLINED") {
    const reason = reasonDrafts[v.id];
    const note = noteDrafts[v.id];
    if (!reason) {
      setError("select a reason before overriding");
      return;
    }
    if (!note || !note.trim()) {
      setError("a note is required in addition to the reason");
      return;
    }
    setBusyId(v.id);
    setError(null);
    try {
      const res = await fetch("/api/kyc/verifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyVerificationId: v.id, reason, note, toStatus }),
      });
      const responseBody = await res.json();
      if (!res.ok) throw new Error(responseBody.error ?? "override failed");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "override failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <h1>Party KYC verifications</h1>
      <p style={{ color: "#666" }}>
        Provider reference and status only — raw identity documents and PII are never stored here; they stay hosted by the
        verification provider&apos;s own flow.
      </p>

      <div style={{ margin: "12px 0" }}>
        <label>
          Status:{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th>Case</th>
            <th>Role</th>
            <th>Provider</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Expires</th>
            <th>Manual override</th>
          </tr>
        </thead>
        <tbody>
          {verifications.map((v) => (
            <tr key={v.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{v.case.claim}</td>
              <td>{v.role}</td>
              <td>{v.provider}</td>
              <td>{v.providerReference ?? v.sessionId}</td>
              <td>{v.status}</td>
              <td>{v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : "—"}</td>
              <td>
                <select
                  value={reasonDrafts[v.id] ?? ""}
                  onChange={(e) => setReasonDrafts((prev) => ({ ...prev, [v.id]: e.target.value }))}
                >
                  <option value="">select reason...</option>
                  {OVERRIDE_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <input
                  placeholder="required note"
                  value={noteDrafts[v.id] ?? ""}
                  onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [v.id]: e.target.value }))}
                  style={{ marginLeft: 6, width: 180 }}
                />
                <button disabled={busyId === v.id} onClick={() => override(v, "APPROVED")} style={{ marginLeft: 6 }}>
                  Approve
                </button>
                <button disabled={busyId === v.id} onClick={() => override(v, "DECLINED")} style={{ marginLeft: 6 }}>
                  Decline
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
