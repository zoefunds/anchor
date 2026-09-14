"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StatusStamp } from "@/components/StatusStamp";
import { sepoliaTxUrl, genlayerTxUrl, genlayerAddressUrl, settlementTxUrl, settlementAddressUrl } from "@/lib/explorer-links";

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
  decisionHash: string | null;
  proofHash: string | null;
  adjudicateTxHash: string | null;
  relayTxHash: string | null;
  relayMessageId: string | null;
  relayNotificationTxHash: string | null;
  relayError: string | null;
  relayAttempts: number;
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
  settlementChain: string | null;
  settlementContract: string | null;
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

interface SettlementIntegrationSummary {
  id: string;
  chain: string;
  escrowContractAddress: string;
  assetSymbol: string;
  active: boolean;
  escrowVersion: "V1" | "V2";
}

interface CaseSettlementSummary {
  id: string;
  status: "PENDING_DEPOSIT" | "DEPOSITED" | "SETTLED" | "MISMATCH_BLOCKED";
  escrowId: string;
  expectedAmountAtto: string;
  claimantAddress: string | null;
  respondentAddress: string | null;
  integration: SettlementIntegrationSummary;
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

  const [caseSettlement, setCaseSettlement] = useState<CaseSettlementSummary | null>(null);
  const [availableIntegrations, setAvailableIntegrations] = useState<SettlementIntegrationSummary[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState("");
  const [binding, setBinding] = useState(false);
  const [confirmingDeposit, setConfirmingDeposit] = useState(false);
  const [escrowNote, setEscrowNote] = useState<string | null>(null);

  const [partyTokens, setPartyTokens] = useState<{ claimant?: string; respondent?: string }>({});
  const [partyLinkBusy, setPartyLinkBusy] = useState<{ claimant?: boolean; respondent?: boolean }>({});

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string[] | null>(null);

  // On-demand version of the worker's periodic sweeps, scoped to this
  // case (see api/cases/:id/sync's own doc comment) — a convenience for
  // staff who don't want to wait out a sweep's interval, never a
  // replacement for those sweeps, which keep running unattended either
  // way.
  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`/api/cases/${id}/sync`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "sync failed");
      setSyncResult(body.actions ?? []);
      await Promise.all([load(), loadEscrow()]);
    } catch (err) {
      setSyncResult([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSyncing(false);
    }
  }

  // Reissues (or re-displays, if already fetched this page-load) a
  // party's capability token and builds their public case link from it.
  // Each reissue invalidates whatever raw token that role held before
  // (see api/cases/:id/party-tokens's own doc comment) — fine here since
  // the only other place a token is shown is the one-time creation
  // response, which staff can't get back to anyway; this is the actual
  // durable way to hand a party their link after the fact.
  async function getPartyLink(role: "claimant" | "respondent") {
    setPartyLinkBusy((s) => ({ ...s, [role]: true }));
    try {
      const res = await fetch(`/api/cases/${id}/party-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to issue party link");
      const token = role === "claimant" ? body.claimantToken : body.respondentToken;
      setPartyTokens((s) => ({ ...s, [role]: token }));
    } catch (err) {
      setEscrowNote(err instanceof Error ? err.message : String(err));
    } finally {
      setPartyLinkBusy((s) => ({ ...s, [role]: false }));
    }
  }

  async function loadEscrow() {
    const res = await fetch(`/api/cases/${id}/settlement`);
    if (res.ok) {
      const body = await res.json();
      setCaseSettlement(body ?? null);
    }
  }

  async function bindSettlement() {
    if (!selectedIntegrationId) return;
    setBinding(true);
    setEscrowNote(null);
    try {
      const res = await fetch(`/api/cases/${id}/settlement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationId: selectedIntegrationId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to bind settlement integration");
      await loadEscrow();
    } catch (err) {
      setEscrowNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBinding(false);
    }
  }

  async function checkDeposit() {
    setConfirmingDeposit(true);
    setEscrowNote(null);
    try {
      const res = await fetch(`/api/cases/${id}/settlement/confirm-deposit`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to check deposit");
      if (body.outcome === "confirmed") setEscrowNote("Deposit confirmed on-chain.");
      else if (body.outcome === "already_confirmed") setEscrowNote("Already confirmed.");
      else if (body.outcome === "no_deposit_yet") setEscrowNote("No matching deposit found on-chain yet.");
      else setEscrowNote(body.reason ?? "Not ready.");
      await loadEscrow();
    } catch (err) {
      setEscrowNote(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmingDeposit(false);
    }
  }

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

    const integrationsRes = await fetch("/api/settlement-integrations");
    if (integrationsRes.ok) {
      setAvailableIntegrations(await integrationsRes.json());
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
    loadEscrow();
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="font-mono text-xs text-seal-500 hover:underline disabled:opacity-50 dark:text-seal-400"
              onClick={syncNow}
              disabled={syncing}
              title="Runs the deposit-check / appeal-finalize / settlement-retry sweeps for this case right now, instead of waiting for their periodic schedule"
            >
              {syncing ? "syncing…" : "↻ sync now"}
            </button>
            <StatusStamp status={kase.status} />
          </div>
        </div>
        {syncResult && (
          <ul className="mt-3 flex flex-col gap-1 border-l-2 border-seal-500 bg-seal-500/5 py-2 pl-4 font-mono text-xs text-muted dark:border-seal-400 dark:text-muted-dark">
            {syncResult.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
          {kase.claim}
        </h1>
        <p className="mt-2 text-sm text-muted dark:text-muted-dark">
          {kase.claimantRef} <span className="mx-1 text-line dark:text-line-dark">v.</span>{" "}
          {kase.respondentRef}
          <span className="mx-2 text-line dark:text-line-dark">·</span>
          <span className="font-mono tabular-nums">
            {kase.amount} {displayCurrency(kase)}
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
            <ExplorerLink href={genlayerAddressUrl(kase.contractAddress)}>{kase.contractAddress}</ExplorerLink>
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-6">
          <PartyLinkControl role="claimant" caseId={kase.id} token={partyTokens.claimant} busy={Boolean(partyLinkBusy.claimant)} onFetch={getPartyLink} />
          <PartyLinkControl role="respondent" caseId={kase.id} token={partyTokens.respondent} busy={Boolean(partyLinkBusy.respondent)} onFetch={getPartyLink} />
        </div>
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

      {kase.settlementChain && (
        <EscrowPanel
          kase={kase}
          isOwner={isOwner}
          caseSettlement={caseSettlement}
          availableIntegrations={availableIntegrations}
          selectedIntegrationId={selectedIntegrationId}
          setSelectedIntegrationId={setSelectedIntegrationId}
          binding={binding}
          onBind={bindSettlement}
          confirmingDeposit={confirmingDeposit}
          onCheckDeposit={checkDeposit}
          escrowNote={escrowNote}
          partyTokens={partyTokens}
          partyLinkBusy={partyLinkBusy}
          onGetPartyLink={getPartyLink}
        />
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

      {kase.decision && <SettlementPanel kase={kase} />}

      <ReviewStatusPanel caseId={id} />

      <section className="mt-10">
        <p className="kicker mb-4">Documents</p>
        <div className="dossier flex flex-wrap gap-4">
          <a className="btn-secondary" href={`/api/cases/${id}/statement?type=statement`}>
            Download case statement
          </a>
          <a className="btn-secondary" href={`/api/cases/${id}/statement?type=proof-bundle`}>
            Download proof bundle
          </a>
          {kase.decision && (
            <a className="btn-secondary" href={`/api/cases/${id}/receipt?type=settlement`}>
              Download settlement receipt
            </a>
          )}
          <a className="btn-secondary" href={`/api/cases/${id}/receipt?type=deposit`}>
            Download deposit receipt
          </a>
        </div>
      </section>

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
                  extraction. PDF text is extracted at upload time and sent as real evidence content
                  (best-effort — an encrypted PDF or a scan with no text layer falls back to reachability only).
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

const SETTLEMENT_CHAIN_LABELS: Record<string, string> = {
  sepolia: "Sepolia (EVM) — DecisionRelay.sol",
  // Label only — the "solanatestnet" value itself stays as the DB/schema
  // identifier; SOLANA_RPC_URL actually points at Devnet as of 2026-09-14.
  solanatestnet: "Solana Devnet — decision-relay program",
};

// Settlement always moves the chain's own native asset — real ETH via
// Escrow.sol's payable deposit()/settle(), real SOL via the Solana
// escrow program's lamport transfers — never a stablecoin. Case.currency
// defaulting to "USD" was a launch-era placeholder; this derives the
// real unit from settlementChain once one is bound.
const NATIVE_ASSET_LABELS: Record<string, string> = {
  sepolia: "ETH",
  solanatestnet: "SOL",
};

function displayCurrency(c: { currency: string; settlementChain: string | null }): string {
  return (c.settlementChain && NATIVE_ASSET_LABELS[c.settlementChain]) || c.currency;
}

// Makes the otherwise-invisible cross-chain pipeline visible: GenLayer
// decides -> Anchor's backend relays that decision via Hyperlane (since
// GenLayer itself isn't a Hyperlane chain and can't dispatch the
// message directly) -> the destination contract settles. Renders only
// once a decision exists; shows nothing extra if the case never had a
// settlement target configured (the common case), so this doesn't add
// noise to cases that were never meant to settle cross-chain.
const CASE_SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  PENDING_DEPOSIT: "Awaiting deposit",
  DEPOSITED: "Deposited — awaiting settlement",
  SETTLED: "Settled",
  MISMATCH_BLOCKED: "Blocked — on-chain state doesn't match what was expected",
};

// Item C's dashboard surface: binding a case to a registered escrow
// (staff-only — see /settings/settlement-integrations), and the
// current deposit/party-address state, which only ever gets written by
// each party themselves via their own public case link, never by
// staff typing addresses in here.
function EscrowPanel({
  kase,
  isOwner,
  caseSettlement,
  availableIntegrations,
  selectedIntegrationId,
  setSelectedIntegrationId,
  binding,
  onBind,
  confirmingDeposit,
  onCheckDeposit,
  escrowNote,
  partyTokens,
  partyLinkBusy,
  onGetPartyLink,
}: {
  kase: CaseDetail;
  isOwner: boolean;
  caseSettlement: CaseSettlementSummary | null;
  availableIntegrations: SettlementIntegrationSummary[];
  selectedIntegrationId: string;
  setSelectedIntegrationId: (id: string) => void;
  binding: boolean;
  onBind: () => void;
  confirmingDeposit: boolean;
  onCheckDeposit: () => void;
  escrowNote: string | null;
  partyTokens: { claimant?: string; respondent?: string };
  partyLinkBusy: { claimant?: boolean; respondent?: boolean };
  onGetPartyLink: (role: "claimant" | "respondent") => void;
}) {
  const usable = availableIntegrations.filter((i) => i.active && i.chain === kase.settlementChain);

  return (
    <section className="mt-10">
      <p className="kicker mb-4">Escrow</p>
      <div className="dossier">
        {!caseSettlement && isOwner && (
          <>
            <p className="text-sm text-muted dark:text-muted-dark">
              No escrow bound yet. Binding does not set either party's payout address — each party
              sets their own via their public case link once bound.
            </p>
            {usable.length === 0 ? (
              <p className="mt-3 font-mono text-xs text-status-undetermined">
                No active settlement integration for {kase.settlementChain}. Add one under{" "}
                <code className="font-mono">Settings → Settlement</code>.
              </p>
            ) : (
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex flex-1 flex-col gap-2">
                  <span className="field-label">Integration</span>
                  <select className="field-input" value={selectedIntegrationId} onChange={(e) => setSelectedIntegrationId(e.target.value)}>
                    <option value="">Select…</option>
                    {usable.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.escrowContractAddress} ({i.assetSymbol})
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn-primary" onClick={onBind} disabled={binding || !selectedIntegrationId}>
                  {binding ? "Binding…" : "Bind escrow"}
                </button>
              </div>
            )}
          </>
        )}

        {!caseSettlement && !isOwner && (
          <p className="text-sm text-muted dark:text-muted-dark">No escrow bound to this case yet.</p>
        )}

        {caseSettlement && (
          <>
            <div className="flex items-baseline justify-between">
              <p className="font-mono text-sm text-ink-950 dark:text-ink">
                {CASE_SETTLEMENT_STATUS_LABELS[caseSettlement.status] ?? caseSettlement.status}
              </p>
              <span className="font-mono text-[11px] text-muted dark:text-muted-dark">{caseSettlement.integration.assetSymbol}</span>
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted dark:text-muted-dark">
              escrow {caseSettlement.escrowId} on{" "}
              {settlementAddressUrl(caseSettlement.integration.chain, caseSettlement.integration.escrowContractAddress) ? (
                <ExplorerLink href={settlementAddressUrl(caseSettlement.integration.chain, caseSettlement.integration.escrowContractAddress)!}>
                  {caseSettlement.integration.escrowContractAddress}
                </ExplorerLink>
              ) : (
                caseSettlement.integration.escrowContractAddress
              )}
            </p>

            <ol className="mt-6 flex flex-col gap-3 border-t border-line pt-6 dark:border-line-dark">
              <PipelineStep
                done={Boolean(caseSettlement.claimantAddress)}
                label="Claimant set their payout address"
                detail={
                  caseSettlement.claimantAddress ? (
                    settlementAddressUrl(caseSettlement.integration.chain, caseSettlement.claimantAddress) ? (
                      <ExplorerLink href={settlementAddressUrl(caseSettlement.integration.chain, caseSettlement.claimantAddress)!}>
                        {caseSettlement.claimantAddress}
                      </ExplorerLink>
                    ) : (
                      caseSettlement.claimantAddress
                    )
                  ) : (
                    <>
                      waiting — the claimant sets this from their own case link{" "}
                      {isOwner && (
                        <PartyLinkControl role="claimant" caseId={kase.id} token={partyTokens.claimant} busy={Boolean(partyLinkBusy.claimant)} onFetch={onGetPartyLink} inline />
                      )}
                    </>
                  )
                }
              />
              <PipelineStep
                done={Boolean(caseSettlement.respondentAddress)}
                label="Respondent set their payout address"
                detail={
                  caseSettlement.respondentAddress ? (
                    settlementAddressUrl(caseSettlement.integration.chain, caseSettlement.respondentAddress) ? (
                      <ExplorerLink href={settlementAddressUrl(caseSettlement.integration.chain, caseSettlement.respondentAddress)!}>
                        {caseSettlement.respondentAddress}
                      </ExplorerLink>
                    ) : (
                      caseSettlement.respondentAddress
                    )
                  ) : (
                    <>
                      waiting — the respondent sets this from their own case link{" "}
                      {isOwner && (
                        <PartyLinkControl role="respondent" caseId={kase.id} token={partyTokens.respondent} busy={Boolean(partyLinkBusy.respondent)} onFetch={onGetPartyLink} inline />
                      )}
                    </>
                  )
                }
              />
              <PipelineStep
                done={caseSettlement.status === "DEPOSITED" || caseSettlement.status === "SETTLED"}
                pending={caseSettlement.status === "PENDING_DEPOSIT" && Boolean(caseSettlement.claimantAddress) && Boolean(caseSettlement.respondentAddress)}
                failed={caseSettlement.status === "MISMATCH_BLOCKED"}
                label="Deposit confirmed on-chain"
                detail={
                  caseSettlement.status === "PENDING_DEPOSIT" && caseSettlement.claimantAddress && isOwner ? (
                    <>
                      the claimant deposits from their own wallet at their deposit link{" "}
                      <PartyLinkControl
                        role="claimant"
                        caseId={kase.id}
                        token={partyTokens.claimant}
                        busy={Boolean(partyLinkBusy.claimant)}
                        onFetch={onGetPartyLink}
                        path="deposit"
                        inline
                      />
                    </>
                  ) : undefined
                }
              />
              <PipelineStep done={caseSettlement.status === "SETTLED"} label="Settled" />
            </ol>

            {caseSettlement.status === "PENDING_DEPOSIT" && (
              <button className="btn-secondary mt-6" onClick={onCheckDeposit} disabled={confirmingDeposit}>
                {confirmingDeposit ? "Checking…" : "Check for deposit"}
              </button>
            )}
            {escrowNote && <p className="mt-3 text-sm text-muted dark:text-muted-dark">{escrowNote}</p>}
            {isOwner && caseSettlement.status === "DEPOSITED" && caseSettlement.integration.escrowVersion === "V2" && (
              <Link
                href={`/cases/${kase.id}/emergency-refund`}
                className="mt-6 inline-block font-mono text-xs text-status-undetermined hover:underline"
              >
                Stuck? Request an emergency refund →
              </Link>
            )}
          </>
        )}
      </div>
    </section>
  );
}

interface CaseReviewApprovalSummary {
  id: string;
  memberId: string;
  decision: "APPROVE" | "REJECT";
  reason: string | null;
  createdAt: string;
}

interface CaseReviewSummary {
  id: string;
  trigger: "HIGH_VALUE" | "FRAUD_RISK" | "MANUAL";
  status: "PENDING" | "APPROVED" | "REJECTED";
  requiresDualApproval: boolean;
  createdAt: string;
  resolvedAt: string | null;
  approvals: CaseReviewApprovalSummary[];
}

const REVIEW_TRIGGER_LABEL: Record<string, string> = {
  HIGH_VALUE: "High value",
  FRAUD_RISK: "Fraud risk",
  MANUAL: "Manual",
};

// Surfaces the escalation status the settings/reviews queue manages —
// this page previously had no indication a case was even under human
// review at all. Read-only here; voting/notes happen on the queue page.
function ReviewStatusPanel({ caseId }: { caseId: string }) {
  const [review, setReview] = useState<CaseReviewSummary | null | undefined>(undefined);

  useEffect(() => {
    fetch(`/api/cases/${caseId}/review`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setReview)
      .catch(() => setReview(null));
  }, [caseId]);

  if (!review) return null;

  const approveCount = review.approvals.filter((a) => a.decision === "APPROVE").length;
  const required = review.requiresDualApproval ? 2 : 1;

  return (
    <section className="mt-10">
      <p className="kicker mb-4">Human review</p>
      <div className="dossier">
        <div className="flex items-baseline justify-between">
          <p className="font-mono text-sm font-semibold text-ink-950 dark:text-ink">
            {REVIEW_TRIGGER_LABEL[review.trigger] ?? review.trigger}
          </p>
          <span className="font-mono text-[11px] uppercase tracking-wide text-muted dark:text-muted-dark">{review.status}</span>
        </div>
        <p className="mt-2 text-sm text-muted dark:text-muted-dark">
          Opened {new Date(review.createdAt).toLocaleString()}
          {review.resolvedAt && ` · resolved ${new Date(review.resolvedAt).toLocaleString()}`}
        </p>
        {review.status === "PENDING" && (
          <p className="mt-2 font-mono text-xs text-muted dark:text-muted-dark">
            Approvals {approveCount}/{required}
            {review.requiresDualApproval ? " (dual approval required)" : ""} —{" "}
            <Link href="/settings/reviews" className="text-seal-500 hover:underline dark:text-seal-400">
              act on it in the review queue
            </Link>
          </p>
        )}
      </div>
    </section>
  );
}

function SettlementPanel({ kase }: { kase: CaseDetail }) {
  if (!kase.settlementChain || !kase.settlementContract) {
    return (
      <section className="mt-10">
        <p className="kicker mb-4">Settlement</p>
        <div className="dossier">
          <p className="text-sm text-muted dark:text-muted-dark">
            No settlement target configured for this case — the decision above is recorded on
            GenLayer and in Anchor, but nothing was dispatched cross-chain to move funds.
          </p>
        </div>
      </section>
    );
  }

  const d = kase.decision;
  const dispatched = Boolean(d?.relayTxHash);
  const reconciled = d?.relayTxHash === "reconciled:onchain";
  const failed = Boolean(d?.relayError) && !dispatched;

  return (
    <section className="mt-10">
      <p className="kicker mb-4">Settlement</p>
      <div className="dossier">
        <p className="text-sm text-muted dark:text-muted-dark">
          Target: <span className="font-mono text-ink-950 dark:text-ink">{SETTLEMENT_CHAIN_LABELS[kase.settlementChain] ?? kase.settlementChain}</span>
        </p>
        <p className="mt-1 break-all font-mono text-xs text-muted dark:text-muted-dark">
          {kase.settlementContract && settlementAddressUrl(kase.settlementChain ?? "", kase.settlementContract) ? (
            <ExplorerLink href={settlementAddressUrl(kase.settlementChain ?? "", kase.settlementContract)!}>{kase.settlementContract}</ExplorerLink>
          ) : (
            kase.settlementContract
          )}
        </p>

        <ol className="mt-6 flex flex-col gap-3 border-t border-line pt-6 dark:border-line-dark">
          <PipelineStep
            done
            label="Adjudicated on GenLayer"
            detail={d?.adjudicateTxHash ? <>tx <ExplorerLink href={genlayerTxUrl(d.adjudicateTxHash)}>{d.adjudicateTxHash}</ExplorerLink></> : undefined}
          />
          <PipelineStep
            done={kase.status === "FINALIZED"}
            label="Finalized (appeal window closed)"
            detail={kase.status !== "FINALIZED" ? "waiting — settlement only dispatches once finalized" : undefined}
          />
          <PipelineStep
            done={dispatched}
            pending={kase.status === "FINALIZED" && !dispatched && !failed}
            failed={failed}
            label={
              reconciled
                ? "Relayed via Hyperlane (reconciled — no local tx, already settled on-chain)"
                : "Relayed via Hyperlane to destination contract"
            }
            detail={
              reconciled ? undefined : d?.relayTxHash ? (
                // Three distinct identifiers, shown distinctly — never
                // collapse the settlement tx, the notification tx, and
                // the Hyperlane message ID into one value. For EVM
                // settlements relayNotificationTxHash is null (the
                // Hyperlane-delivered message IS the settlement tx), so
                // only Solana settlements show the extra "notify tx" —
                // that notification dispatch always happens on Sepolia
                // (Anchor's own Mailbox), regardless of settlement chain.
                <>
                  settle tx{" "}
                  {settlementTxUrl(kase.settlementChain ?? "", d.relayTxHash) ? (
                    <ExplorerLink href={settlementTxUrl(kase.settlementChain ?? "", d.relayTxHash)!}>{d.relayTxHash}</ExplorerLink>
                  ) : (
                    d.relayTxHash
                  )}
                  {d.relayNotificationTxHash && (
                    <>
                      {" "}
                      · notify tx <ExplorerLink href={sepoliaTxUrl(d.relayNotificationTxHash)}>{d.relayNotificationTxHash}</ExplorerLink>
                    </>
                  )}
                  {d.relayMessageId && <> · hyperlane message {d.relayMessageId}</>}
                </>
              ) : d?.relayError ? (
                `${d.relayError} (attempt ${d.relayAttempts}) — retried automatically`
              ) : undefined
            }
          />
        </ol>

        {d?.decisionHash && (
          <p className="mt-6 border-t border-line pt-4 font-mono text-[11px] text-muted dark:border-line-dark dark:text-muted-dark">
            decisionHash {d.decisionHash} — this is what the destination contract's own
            processedDecisions guard checks to reject a duplicate settlement.
          </p>
        )}
      </div>
    </section>
  );
}

// Fetching a link reissues that role's capability token (see
// api/cases/:id/party-tokens), invalidating whatever raw token they held
// before — deliberate, since this is the only durable way to get a
// party their link again once the one-time case-creation response is
// gone. `path` selects which public page the link points at: the main
// case page (set address / evidence) by default, or the wallet-connect
// deposit page when asked for near the deposit step.
function PartyLinkControl({
  role,
  caseId,
  token,
  busy,
  onFetch,
  path,
  inline,
}: {
  role: "claimant" | "respondent";
  caseId: string;
  token: string | undefined;
  busy: boolean;
  onFetch: (role: "claimant" | "respondent") => void;
  path?: "deposit";
  inline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = token ? `${origin}/public/cases/${caseId}${path ? `/${path}` : ""}?token=${token}` : null;

  if (!link) {
    return (
      <button
        type="button"
        className="font-mono text-[11px] text-seal-500 hover:underline disabled:opacity-50 dark:text-seal-400"
        onClick={() => onFetch(role)}
        disabled={busy}
      >
        {busy ? "issuing…" : path === "deposit" ? `get ${role} deposit link →` : `get ${role} link →`}
      </button>
    );
  }

  return (
    <span className={inline ? "inline-flex items-center gap-2" : "flex flex-wrap items-center gap-2"}>
      <a href={link} target="_blank" rel="noreferrer" className="break-all font-mono text-[11px] text-seal-500 underline dark:text-seal-400">
        {link}
      </a>
      <button
        type="button"
        className="font-mono text-[11px] text-muted hover:underline dark:text-muted-dark"
        onClick={() => {
          navigator.clipboard.writeText(link);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
      <button
        type="button"
        className="font-mono text-[11px] text-muted hover:underline dark:text-muted-dark"
        onClick={() => onFetch(role)}
        disabled={busy}
        title="Issues a fresh link and invalidates this one"
      >
        {busy ? "reissuing…" : "reissue"}
      </button>
    </span>
  );
}

function ExplorerLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-seal-500 underline decoration-dotted underline-offset-2 hover:text-seal-600 dark:text-seal-400 dark:hover:text-seal-300"
    >
      {children}
    </a>
  );
}

function PipelineStep({
  done,
  pending,
  failed,
  label,
  detail,
}: {
  done: boolean;
  pending?: boolean;
  failed?: boolean;
  label: string;
  detail?: ReactNode;
}) {
  const marker = failed ? "✕" : done ? "✓" : pending ? "…" : "○";
  const markerColor = failed
    ? "text-status-undetermined"
    : done
      ? "text-seal-500 dark:text-seal-400"
      : "text-muted dark:text-muted-dark";
  return (
    <li className="flex items-start gap-3">
      <span className={`font-mono text-sm ${markerColor}`}>{marker}</span>
      <div>
        <p className={`text-sm ${done ? "text-ink-950 dark:text-ink" : "text-muted dark:text-muted-dark"}`}>{label}</p>
        {detail && <p className="mt-0.5 break-all font-mono text-[11px] text-muted dark:text-muted-dark">{detail}</p>}
      </div>
    </li>
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
