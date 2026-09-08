"use client";

import { useState } from "react";
import { StatusStamp } from "@/components/StatusStamp";
import {
  PublicCase,
  setPayoutAddress,
  submitTextEvidence,
  submitFileEvidence,
  fileAppeal,
  formatDeadline,
} from "./usePublicCase";

// Shared render for the party-facing case record. Used by both the full
// page (/public/cases/[id]) and the embeddable widget
// (/public/widget/[id]/embed) so the two never drift apart. `embed`
// trims chrome (no "Anchor" wordmark/kicker) for iframe use.
//
// Nothing rendered here is a wallet connector, private-key field, or
// chain-ID selector — the "payout address" input is a plain text field
// the party types their own address into; the org's off-chain systems
// use it later. No client-side signing, no injected-wallet calls.
export function CasePanel({
  id,
  kase,
  onRefresh,
  embed = false,
}: {
  id: string;
  kase: PublicCase;
  onRefresh: () => void | Promise<void>;
  embed?: boolean;
}) {
  const [payoutAddress, setPayoutAddressInput] = useState("");
  const [settingAddress, setSettingAddress] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [addressSetNote, setAddressSetNote] = useState<string | null>(null);

  const [evidenceType, setEvidenceType] = useState("statement");
  const [evidenceText, setEvidenceText] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [submittingEvidence, setSubmittingEvidence] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceNote, setEvidenceNote] = useState<string | null>(null);

  const [appealReason, setAppealReason] = useState("");
  const [filingAppeal, setFilingAppeal] = useState(false);
  const [appealError, setAppealError] = useState<string | null>(null);
  const [appealNote, setAppealNote] = useState<string | null>(null);

  const latestDecision = kase.decisions[0];
  const now = new Date();

  const evidenceDeadline =
    kase.policy && kase.decisions.length === 0
      ? new Date(new Date(kase.createdAt).getTime() + kase.policy.evidenceDeadlineHours * 60 * 60 * 1000)
      : null;
  const evidenceWindowOpen = !evidenceDeadline || evidenceDeadline.getTime() > now.getTime();

  const appealWindowClosesAt = latestDecision?.appealWindowClosesAt ? new Date(latestDecision.appealWindowClosesAt) : null;
  const appealWindowOpen = !!appealWindowClosesAt && appealWindowClosesAt.getTime() > now.getTime();

  async function handleSetAddress(e: React.FormEvent) {
    e.preventDefault();
    setSettingAddress(true);
    setAddressError(null);
    try {
      const body = await setPayoutAddress(id, payoutAddress);
      setAddressSetNote(`Payout address set to ${body.address}.`);
      await onRefresh();
    } catch (err) {
      setAddressError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingAddress(false);
    }
  }

  async function handleSubmitEvidence(e: React.FormEvent) {
    e.preventDefault();
    setSubmittingEvidence(true);
    setEvidenceError(null);
    try {
      if (evidenceFile) {
        await submitFileEvidence(id, evidenceType, evidenceFile);
      } else {
        if (!evidenceText.trim()) throw new Error("enter text or choose a file");
        await submitTextEvidence(id, evidenceType, evidenceText);
      }
      setEvidenceText("");
      setEvidenceFile(null);
      setEvidenceNote("Evidence submitted.");
      await onRefresh();
    } catch (err) {
      setEvidenceError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingEvidence(false);
    }
  }

  async function handleFileAppeal(e: React.FormEvent) {
    e.preventDefault();
    setFilingAppeal(true);
    setAppealError(null);
    try {
      const note = await fileAppeal(id, appealReason);
      setAppealNote(note);
      setAppealReason("");
      await onRefresh();
    } catch (err) {
      setAppealError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilingAppeal(false);
    }
  }

  const myAddress = kase.role === "claimant" ? kase.settlement?.claimantAddress : kase.role === "respondent" ? kase.settlement?.respondentAddress : undefined;
  const needsMyAddress = kase.settlement && kase.settlement.status === "PENDING_DEPOSIT" && kase.role && !myAddress;

  return (
    <div>
      {!embed && (
        <>
          <p className="font-display text-lg font-semibold text-ink-950 dark:text-ink">Anchor</p>
          <p className="kicker mt-2 text-seal-500 dark:text-seal-400">Public case record</p>
        </>
      )}

      <header className="mt-4 border-b border-line pb-8 dark:border-line-dark">
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
            {kase.amount} {kase.settlement?.assetSymbol ?? kase.currency}
          </span>
          <span className="mx-2 text-line dark:text-line-dark">·</span>
          <span className="font-mono text-xs">{kase.policyId}</span>
        </p>
      </header>

      {kase.settlement && (
        <section className="mt-10">
          <p className="kicker mb-4">Escrow</p>
          <div className="dossier">
            <p className="text-sm text-muted dark:text-muted-dark">
              {kase.settlement.status === "PENDING_DEPOSIT" && "Awaiting deposit."}
              {kase.settlement.status === "DEPOSITED" && "Deposit confirmed — awaiting settlement."}
              {kase.settlement.status === "SETTLED" && "Settled."}
              {kase.settlement.status === "MISMATCH_BLOCKED" && "Blocked — on-chain state didn't match what was expected. Contact the organization handling this case."}
              {" "}
              <span className="font-mono text-xs">
                {kase.settlement.chain} · {kase.settlement.assetSymbol}
              </span>
            </p>

            {needsMyAddress ? (
              <form onSubmit={handleSetAddress} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex flex-1 flex-col gap-2">
                  <span className="field-label">Your payout address</span>
                  <input
                    className="field-input font-mono"
                    placeholder="0x…"
                    value={payoutAddress}
                    onChange={(e) => setPayoutAddressInput(e.target.value)}
                    required
                  />
                </label>
                <button className="btn-primary" type="submit" disabled={settingAddress}>
                  {settingAddress ? "Setting…" : "Set address"}
                </button>
              </form>
            ) : (
              myAddress && (
                <p className="mt-4 break-all font-mono text-xs text-muted dark:text-muted-dark">
                  Your payout address: <span className="text-ink-950 dark:text-ink">{myAddress}</span>
                </p>
              )
            )}
            {addressError && <p className="mt-2 text-sm text-status-undetermined">{addressError}</p>}
            {addressSetNote && <p className="mt-2 text-sm text-muted dark:text-muted-dark">{addressSetNote}</p>}
          </div>
        </section>
      )}

      {latestDecision && (
        <section className="mt-10">
          <p className="kicker mb-4 text-seal-500 dark:text-seal-400">Verdict</p>
          <div className="dossier">
            <div className="flex items-baseline justify-between">
              <p className="font-display text-2xl font-semibold text-ink-950 dark:text-ink">
                {latestDecision.outcome.replace(/_/g, " ")}
              </p>
              <span className="font-mono text-[11px] uppercase tracking-wide text-muted dark:text-muted-dark">
                consensus · {latestDecision.consensus}
              </span>
            </div>
            {latestDecision.claimantShareBps !== null && (
              <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:gap-8">
                <ShareBar label="Claimant" bps={latestDecision.claimantShareBps} />
                <ShareBar label="Respondent" bps={latestDecision.respondentShareBps!} />
              </div>
            )}
            <p className="mt-6 border-t border-line pt-4 font-mono text-xs text-muted dark:border-line-dark dark:text-muted-dark">
              Grounds: {latestDecision.reasonCodes.join(" · ")}
            </p>
            {appealWindowClosesAt && (
              <p className="mt-2 font-mono text-xs text-muted dark:text-muted-dark">
                Appeal window: {formatDeadline(appealWindowClosesAt, now)}
              </p>
            )}
          </div>

          {kase.role && (
            <div className="dossier mt-4">
              <p className="field-label">File an appeal</p>
              {appealWindowOpen ? (
                <form onSubmit={handleFileAppeal} className="mt-3 flex flex-col gap-3">
                  <textarea
                    className="field-input"
                    placeholder="Reason for appeal (optional)"
                    value={appealReason}
                    onChange={(e) => setAppealReason(e.target.value)}
                    rows={3}
                  />
                  <button className="btn-primary self-start" type="submit" disabled={filingAppeal}>
                    {filingAppeal ? "Filing…" : "File appeal"}
                  </button>
                </form>
              ) : (
                <p className="mt-2 text-sm text-muted dark:text-muted-dark">
                  {appealWindowClosesAt ? "Appeal window has closed." : "No appeal window is open for this decision."}
                </p>
              )}
              {appealError && <p className="mt-2 text-sm text-status-undetermined">{appealError}</p>}
              {appealNote && <p className="mt-2 text-sm text-muted dark:text-muted-dark">{appealNote}</p>}
            </div>
          )}
        </section>
      )}

      {kase.role && (
        <section className="mt-10">
          <p className="kicker mb-4">Submit evidence</p>
          {evidenceDeadline && (
            <p className="mb-3 font-mono text-xs text-muted dark:text-muted-dark">
              Evidence deadline: {formatDeadline(evidenceDeadline, now)}
            </p>
          )}
          {evidenceWindowOpen ? (
            <form onSubmit={handleSubmitEvidence} className="dossier flex flex-col gap-3">
              <label className="flex flex-col gap-2">
                <span className="field-label">Type</span>
                <input
                  className="field-input"
                  value={evidenceType}
                  onChange={(e) => setEvidenceType(e.target.value)}
                  placeholder="statement, receipt, screenshot…"
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="field-label">Statement (or attach a file below)</span>
                <textarea
                  className="field-input"
                  rows={4}
                  value={evidenceText}
                  onChange={(e) => setEvidenceText(e.target.value)}
                  placeholder="Describe what happened…"
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="field-label">Attach a file (image or PDF)</span>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <button className="btn-primary self-start" type="submit" disabled={submittingEvidence}>
                {submittingEvidence ? "Submitting…" : "Submit evidence"}
              </button>
              {evidenceError && <p className="text-sm text-status-undetermined">{evidenceError}</p>}
              {evidenceNote && <p className="text-sm text-muted dark:text-muted-dark">{evidenceNote}</p>}
            </form>
          ) : (
            <p className="dossier text-sm text-muted dark:text-muted-dark">
              The evidence submission window for this case has closed.
            </p>
          )}
        </section>
      )}

      <section className="mt-10">
        <p className="kicker mb-4">Exhibits ({kase.evidence.length})</p>
        <div className="border-t border-line dark:border-line-dark">
          {kase.evidence.map((e) => (
            <div key={e.id} className="flex flex-col gap-1.5 border-b border-line py-5 dark:border-line-dark">
              <p className="field-label">{e.type}</p>
              {e.mimeType?.startsWith("image/") ? (
                <a href={e.storageRef} target="_blank" rel="noreferrer">
                  <img
                    src={e.storageRef}
                    alt={e.type}
                    className="mt-1 max-h-64 max-w-full border border-line object-contain dark:border-line-dark"
                  />
                </a>
              ) : e.mimeType ? (
                <a href={e.storageRef} target="_blank" rel="noreferrer" className="text-sm text-seal-500 underline dark:text-seal-400">
                  {e.mimeType} file — open
                </a>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{e.storageRef.slice(0, 400)}</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
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
