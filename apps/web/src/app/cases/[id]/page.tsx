"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StatusStamp } from "@/components/StatusStamp";

const EXHIBIT_LETTERS = "ABCDEFGH";

interface Evidence {
  id: string;
  type: string;
  contentHash: string;
  storageRef: string;
  mimeType: string | null;
  createdAt: string;
}

interface Decision {
  outcome: string;
  claimantShareBps: number | null;
  respondentShareBps: number | null;
  reasonCodes: string[];
  consensus: string;
  appealWindowClosesAt: string | null;
}

interface CaseDetail {
  id: string;
  status: string;
  claim: string;
  amount: string;
  currency: string;
  policyId: string;
  claimantRef: string;
  respondentRef: string;
  contractAddress: string | null;
  evidence: Evidence[];
  decision: Decision | null;
  canAppeal: boolean;
}

interface PolicyDefinition {
  id: string;
  label: string;
  requiredEvidence: { type: string; label: string }[];
}

interface OrgMember {
  id: string;
  email: string;
  role: "OWNER" | "MEMBER" | "VIEWER";
}

export default function CaseDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [kase, setKase] = useState<CaseDetail | null>(null);
  const [policy, setPolicy] = useState<PolicyDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [evidenceType, setEvidenceType] = useState<string>("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [adjudicating, setAdjudicating] = useState(false);
  const [evidenceMode, setEvidenceMode] = useState<"text" | "file">("text");
  const [file, setFile] = useState<globalThis.File | null>(null);
  const [appealReason, setAppealReason] = useState("");
  const [appealing, setAppealing] = useState(false);
  const [correctType, setCorrectType] = useState<string>("");

  const [isOwner, setIsOwner] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [grantedMembers, setGrantedMembers] = useState<{ id: string; email: string }[]>([]);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [accessBusy, setAccessBusy] = useState(false);

  async function load() {
    const res = await fetch(`/api/cases/${id}`);
    if (!res.ok) {
      setError("case not found");
      return;
    }
    const data: CaseDetail = await res.json();
    setKase(data);
    setError(null);

    // The case's policy defines which evidence types apply — fetched once
    // we know the case, since the policy list endpoint isn't filtered by
    // case.
    if (!policy || policy.id !== data.policyId) {
      const policiesRes = await fetch("/api/policies");
      if (policiesRes.ok) {
        const policies: PolicyDefinition[] = await policiesRes.json();
        setPolicy(policies.find((p) => p.id === data.policyId) ?? null);
      }
    }
  }

  // Access control (restrict this case to specific members) is
  // OWNER-only — see api/cases/:id/access. Loaded separately from the
  // main case fetch since a non-owner's request would just 403/404.
  async function loadAccess() {
    const meRes = await fetch("/api/auth/me");
    if (!meRes.ok) return;
    const me = await meRes.json();
    if (me.member.role !== "OWNER") return;
    setIsOwner(true);

    const [accessRes, membersRes] = await Promise.all([fetch(`/api/cases/${id}/access`), fetch("/api/members")]);
    if (accessRes.ok) {
      const data = await accessRes.json();
      setRestricted(data.restricted);
      setGrantedMembers(data.grantedMembers);
    }
    if (membersRes.ok) {
      setOrgMembers(await membersRes.json());
    }
  }

  async function toggleRestricted(next: boolean) {
    setAccessBusy(true);
    try {
      const res = await fetch(`/api/cases/${id}/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restricted: next }),
      });
      if (res.ok) setRestricted(next);
    } finally {
      setAccessBusy(false);
    }
  }

  async function grantAccess(memberId: string) {
    setAccessBusy(true);
    try {
      const res = await fetch(`/api/cases/${id}/access/${memberId}`, { method: "PUT" });
      if (res.ok) await loadAccess();
    } finally {
      setAccessBusy(false);
    }
  }

  async function revokeAccess(memberId: string) {
    setAccessBusy(true);
    try {
      const res = await fetch(`/api/cases/${id}/access/${memberId}`, { method: "DELETE" });
      if (res.ok) await loadAccess();
    } finally {
      setAccessBusy(false);
    }
  }

  useEffect(() => {
    load();
    loadAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (kase?.status === "ADJUDICATING" || kase?.status === "RE_ADJUDICATING") {
      pollRef.current = setInterval(load, 5000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kase?.status]);

  const requiredTypes = policy?.requiredEvidence.map((e) => e.type) ?? [];
  const evidenceLabels = Object.fromEntries((policy?.requiredEvidence ?? []).map((e) => [e.type, e.label]));
  const exhibitLetters = Object.fromEntries(requiredTypes.map((t, i) => [t, EXHIBIT_LETTERS[i] ?? "?"]));

  const presentTypes = new Set(kase?.evidence.map((e) => e.type) ?? []);
  const missingTypes = requiredTypes.filter((t) => !presentTypes.has(t));

  // The select's bound value can go stale after a submission removes it
  // from the options list — a plain useState default doesn't auto-correct,
  // and since the fetch body reads this state directly (not the DOM), a
  // stale value would silently resubmit the wrong type. Keep it pinned to
  // a valid option whenever the missing-types list changes.
  useEffect(() => {
    if (missingTypes.length > 0 && !missingTypes.includes(evidenceType)) {
      setEvidenceType(missingTypes[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingTypes.join(",")]);

  async function submitEvidence(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setNote(null);
    try {
      const res = await fetch(`/api/cases/${id}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: evidenceType, content }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "failed to submit evidence");
      }
      setContent("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitFileEvidence(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setNote(null);
    try {
      const form = new FormData();
      form.set("type", evidenceType);
      form.set("file", file);
      const res = await fetch(`/api/cases/${id}/evidence/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "failed to upload evidence");
      }
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCorrection(e: React.FormEvent) {
    e.preventDefault();
    if (!correctType) return;
    setSubmitting(true);
    setNote(null);
    try {
      const res = await fetch(`/api/cases/${id}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: correctType, content }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "failed to submit correction");
      }
      setContent("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function triggerAppeal() {
    setAppealing(true);
    setNote(null);
    try {
      const res = await fetch(`/api/cases/${id}/appeal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: appealReason || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "failed to appeal");
      }
      setNote(body.note ?? "Appeal accepted.");
      setAppealReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppealing(false);
    }
  }

  async function triggerAdjudicate() {
    setAdjudicating(true);
    setNote(null);
    try {
      const res = await fetch(`/api/cases/${id}/adjudicate`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "failed to start adjudication");
      }
      setNote(body.note ?? "Adjudication started.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdjudicating(false);
    }
  }

  if (error && !kase) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="mb-4 border-l-2 border-status-undetermined bg-status-undetermined/5 py-2 pl-4 text-sm text-status-undetermined">
          {error}
        </p>
        <BackLink />
      </main>
    );
  }

  if (!kase) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="font-mono text-sm text-muted dark:text-muted-dark">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <BackLink />

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs text-muted dark:text-muted-dark">{kase.id}</p>
          <StatusStamp status={kase.status} />
        </div>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
          {kase.claim}
        </h1>
        <p className="mt-2 text-sm text-muted dark:text-muted-dark">
          {kase.claimantRef} <span className="mx-1 text-line dark:text-line-dark">v.</span>{" "}
          {kase.respondentRef}
          <span className="mx-2 text-line dark:text-line-dark">·</span>
          <span className="font-mono tabular-nums">
            {kase.amount} {kase.currency}
          </span>
          <span className="mx-2 text-line dark:text-line-dark">·</span>
          <span className="font-mono text-xs">{policy?.label ?? kase.policyId}</span>
        </p>
        {(kase.status === "ADJUDICATING" || kase.status === "RE_ADJUDICATING") && (
          <p className="mt-4 font-mono text-xs text-status-adjudicating">
            {kase.status === "RE_ADJUDICATING" ? "Re-adjudicating (appeal)" : "Adjudicating"} — polling every 5s.
            Real consensus takes ~1–2 minutes.
          </p>
        )}
        {kase.contractAddress && (
          <p className="mt-4 font-mono text-[11px] text-muted dark:text-muted-dark">
            GenLayer contract{" "}
            <span className="text-ink-950 dark:text-ink">{kase.contractAddress}</span>
          </p>
        )}
        <p className="mt-2 font-mono text-[11px] text-muted dark:text-muted-dark">
          <a href={`/public/cases/${kase.id}`} target="_blank" rel="noreferrer" className="hover:text-seal-500 dark:hover:text-seal-400">
            Public link for the other party →
          </a>
        </p>
      </header>

      {isOwner && (
        <section className="mt-8 border-b border-line pb-8 dark:border-line-dark">
          <p className="kicker mb-4">Access</p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={restricted}
              disabled={accessBusy}
              onChange={(e) => toggleRestricted(e.target.checked)}
            />
            Restrict this case to specific members (you always have access)
          </label>
          {restricted && (
            <div className="mt-4 flex flex-col gap-2">
              {orgMembers
                .filter((m) => m.role !== "OWNER")
                .map((m) => {
                  const granted = grantedMembers.some((g) => g.id === m.id);
                  return (
                    <div key={m.id} className="flex items-center justify-between text-sm">
                      <span>{m.email}</span>
                      <button
                        type="button"
                        className="font-mono text-xs text-seal-500 hover:underline disabled:opacity-50 dark:text-seal-400"
                        disabled={accessBusy}
                        onClick={() => (granted ? revokeAccess(m.id) : grantAccess(m.id))}
                      >
                        {granted ? "Revoke" : "Grant"}
                      </button>
                    </div>
                  );
                })}
              {orgMembers.filter((m) => m.role !== "OWNER").length === 0 && (
                <p className="text-sm text-muted dark:text-muted-dark">No other members to grant access to.</p>
              )}
            </div>
          )}
        </section>
      )}

      {note && (
        <p className="mt-6 border-l-2 border-status-active bg-status-active/5 py-2 pl-4 text-sm text-status-active">
          {note}
        </p>
      )}
      {error && (
        <p className="mt-6 border-l-2 border-status-undetermined bg-status-undetermined/5 py-2 pl-4 text-sm text-status-undetermined">
          {error}
        </p>
      )}

      {kase.decision && (
        <section className="mt-10">
          <p className="kicker mb-4 text-seal-500 dark:text-seal-400">Verdict</p>
          <div className="dossier">
            <div className="flex items-baseline justify-between">
              <p className="font-display text-2xl font-semibold text-ink-950 dark:text-ink">
                {kase.decision.outcome.replace(/_/g, " ")}
              </p>
              <span className="font-mono text-[11px] uppercase tracking-wide text-muted dark:text-muted-dark">
                consensus · {kase.decision.consensus}
              </span>
            </div>

            {kase.decision.claimantShareBps !== null && (
              <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:gap-8">
                <ShareBar label="Claimant" bps={kase.decision.claimantShareBps} />
                <ShareBar label="Respondent" bps={kase.decision.respondentShareBps!} />
              </div>
            )}

            <p className="mt-6 border-t border-line pt-4 font-mono text-xs text-muted dark:border-line-dark dark:text-muted-dark">
              Grounds: {kase.decision.reasonCodes.join(" · ")}
            </p>
          </div>
        </section>
      )}

      {kase.canAppeal && (
        <section className="mt-10">
          <p className="kicker mb-4 text-status-adjudicating">Appeal window open</p>
          <div className="dossier">
            <p className="text-sm text-muted dark:text-muted-dark">
              Closes {kase.decision?.appealWindowClosesAt ? new Date(kase.decision.appealWindowClosesAt).toLocaleString() : ""}.
              One appeal is allowed per case — it triggers a fresh, independent consensus round, not a review of the prior one.
            </p>

            {requiredTypes.length > 0 && (
              <form onSubmit={submitCorrection} className="mt-6 flex flex-col gap-4 border-t border-line pt-6 dark:border-line-dark">
                <p className="field-label">Correct an exhibit before appealing (optional)</p>
                <div className="flex gap-3">
                  <select className="field-input" value={correctType || requiredTypes[0]} onChange={(e) => setCorrectType(e.target.value)}>
                    {requiredTypes.map((t) => (
                      <option key={t} value={t}>
                        {exhibitLetters[t]} — {evidenceLabels[t] ?? t}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  className="field-input min-h-[80px] resize-y"
                  placeholder="Corrected content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
                <button className="btn-primary self-start" type="submit" disabled={submitting || !content}>
                  {submitting ? "Saving…" : "Save correction"}
                </button>
              </form>
            )}

            <div className="mt-6 flex flex-col gap-4 border-t border-line pt-6 dark:border-line-dark">
              <label className="flex flex-col gap-2">
                <span className="field-label">Reason for appeal (optional)</span>
                <textarea
                  className="field-input min-h-[80px] resize-y"
                  value={appealReason}
                  onChange={(e) => setAppealReason(e.target.value)}
                />
              </label>
              <button className="btn-primary self-start" onClick={triggerAppeal} disabled={appealing}>
                {appealing ? "Appealing…" : "Appeal this decision"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="mt-10">
        <p className="kicker mb-4">
          Exhibits{" "}
          <span className="text-muted dark:text-muted-dark">
            ({kase.evidence.length} of {requiredTypes.length || "?"})
          </span>
        </p>

        <div className="border-t border-line dark:border-line-dark">
          {kase.evidence.map((e) => (
            <div key={e.id} className="flex gap-5 border-b border-line py-5 dark:border-line-dark">
              <span className="font-display text-lg font-semibold text-seal-500 dark:text-seal-400">
                {exhibitLetters[e.type] ?? "—"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="field-label">{evidenceLabels[e.type] ?? e.type}</p>
                {e.mimeType?.startsWith("image/") ? (
                  <a href={e.storageRef} target="_blank" rel="noreferrer" className="mt-1.5 block">
                    <img
                      src={e.storageRef}
                      alt={evidenceLabels[e.type] ?? e.type}
                      className="max-h-64 max-w-full border border-line object-contain dark:border-line-dark"
                    />
                  </a>
                ) : e.mimeType ? (
                  <a
                    href={e.storageRef}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block text-sm text-seal-500 underline hover:text-seal-600 dark:text-seal-400"
                  >
                    {e.mimeType} file — open
                  </a>
                ) : (
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {e.storageRef.slice(0, 400)}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {kase.status === "EVIDENCE_COLLECTION" && missingTypes.length > 0 && (
          <div className="mt-8">
            <div className="mb-4 flex gap-1 font-mono text-xs">
              <button
                type="button"
                onClick={() => setEvidenceMode("text")}
                className={`border px-3 py-1.5 ${evidenceMode === "text" ? "border-seal-500 text-seal-500 dark:text-seal-400" : "border-line text-muted dark:border-line-dark dark:text-muted-dark"}`}
              >
                Text
              </button>
              <button
                type="button"
                onClick={() => setEvidenceMode("file")}
                className={`border px-3 py-1.5 ${evidenceMode === "file" ? "border-seal-500 text-seal-500 dark:text-seal-400" : "border-line text-muted dark:border-line-dark dark:text-muted-dark"}`}
              >
                Image / PDF
              </button>
            </div>

            {evidenceMode === "text" ? (
              <form onSubmit={submitEvidence} className="flex flex-col gap-6">
                <label className="flex flex-col gap-2">
                  <span className="field-label">Exhibit type</span>
                  <select
                    className="field-input"
                    value={evidenceType}
                    onChange={(e) => setEvidenceType(e.target.value)}
                  >
                    {missingTypes.map((t) => (
                      <option key={t} value={t}>
                        {exhibitLetters[t]} — {evidenceLabels[t] ?? t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2">
                  <span className="field-label">Content</span>
                  <textarea
                    className="field-input min-h-[100px] resize-y"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                  />
                </label>
                <button className="btn-primary self-start" type="submit" disabled={submitting}>
                  {submitting ? "Filing…" : "File exhibit"}
                </button>
              </form>
            ) : (
              <form onSubmit={submitFileEvidence} className="flex flex-col gap-6">
                <label className="flex flex-col gap-2">
                  <span className="field-label">Exhibit type</span>
                  <select
                    className="field-input"
                    value={evidenceType}
                    onChange={(e) => setEvidenceType(e.target.value)}
                  >
                    {missingTypes.map((t) => (
                      <option key={t} value={t}>
                        {exhibitLetters[t]} — {evidenceLabels[t] ?? t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2">
                  <span className="field-label">File (image or PDF, max 15MB)</span>
                  <input
                    className="field-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <p className="text-xs text-muted dark:text-muted-dark">
                  Images are seen and interpreted directly by the GenLayer contract — no text
                  extraction. PDFs are only confirmed reachable; their content isn&apos;t machine-read.
                </p>
                <button className="btn-primary self-start" type="submit" disabled={submitting || !file}>
                  {submitting ? "Uploading…" : "File exhibit"}
                </button>
              </form>
            )}
          </div>
        )}

        {kase.status === "EVIDENCE_COLLECTION" && requiredTypes.length > 0 && missingTypes.length === 0 && (
          <button className="btn-primary mt-8" onClick={triggerAdjudicate} disabled={adjudicating}>
            {adjudicating ? "Submitting…" : "Submit for adjudication"}
          </button>
        )}
      </section>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/cases"
      className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
    >
      ← Docket
    </Link>
  );
}

function ShareBar({ label, bps }: { label: string; bps: number }) {
  const pct = bps / 100;
  return (
    <div className="flex-1">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="field-label">{label}</span>
        <span className="font-mono text-sm tabular-nums text-ink-950 dark:text-ink">{pct.toFixed(2)}%</span>
      </div>
      <div className="h-1 overflow-hidden bg-line dark:bg-line-dark">
        <div className="h-full bg-seal-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
