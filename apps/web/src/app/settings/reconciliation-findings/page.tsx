"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface FindingEvent {
  id: string;
  type: "ACKNOWLEDGED" | "NOTE";
  memberEmail: string;
  note: string | null;
  createdAt: string;
}

interface Finding {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  openedAt: string;
  resolvedAt: string | null;
  alertedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByEmail: string | null;
  events: FindingEvent[];
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-status-undetermined",
  warning: "text-status-adjudicating",
  info: "text-muted dark:text-muted-dark",
};

// Priority 5, item 18 — platform-admin-only. ReconciliationFinding is
// global, cross-tenant data (see lib/auth.ts's requirePlatformAdmin),
// so this page deliberately isn't gated the same way as the other
// /settings/* pages, even though it lives at the same URL depth.
export default function ReconciliationFindingsPage() {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  async function load() {
    const res = await fetch(`/api/reconciliation-findings?status=${status}`);
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) setFindings(await res.json());
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function acknowledge(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/reconciliation-findings/${id}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: noteDrafts[id] ?? "" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "failed to acknowledge");
      setNoteDrafts((prev) => ({ ...prev, [id]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function addNote(id: string) {
    const note = noteDrafts[id];
    if (!note || note.trim().length === 0) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/reconciliation-findings/${id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "failed to add note");
      setNoteDrafts((prev) => ({ ...prev, [id]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (forbidden) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">
          This is a platform-wide operator page, not an organization setting — your account isn't on the
          platform-admin allowlist.
        </p>
        <Link href="/cases" className="mt-4 inline-block text-sm text-seal-500 hover:underline dark:text-seal-400">
          ← Docket
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <div className="flex items-center justify-between">
        <Link
          href="/cases"
          className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          ← Docket
        </Link>
        <Link href="/settings/members" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Members →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Platform</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Reconciliation findings</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Real drift between on-chain state and this database, found by the periodic reconciliation
          sweep (see lib/reconciliation.ts). Acknowledging a finding records that a real person has
          taken ownership — only the sweep itself can resolve one, by re-checking the actual condition.
        </p>
        <div className="mt-4 flex gap-4 font-mono text-xs">
          {(["open", "resolved", "all"] as const).map((s) => (
            <button key={s} className={s === status ? "text-seal-500 dark:text-seal-400" : "text-muted dark:text-muted-dark"} onClick={() => setStatus(s)}>
              {s}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        {findings.length === 0 && <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">No {status === "all" ? "" : status} findings.</p>}
        {findings.map((f) => (
          <div key={f.id} className="dossier mb-6">
            <div className="flex items-baseline justify-between">
              <p className={`font-mono text-sm font-semibold ${SEVERITY_COLOR[f.severity]}`}>
                [{f.severity.toUpperCase()}] {f.type}
              </p>
              <span className="font-mono text-[11px] text-muted dark:text-muted-dark">
                {f.resolvedAt ? `resolved ${new Date(f.resolvedAt).toLocaleString()}` : `opened ${new Date(f.openedAt).toLocaleString()}`}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
              {f.targetType} {f.targetId}
            </p>
            <pre className="mt-2 overflow-x-auto rounded bg-black/5 p-2 font-mono text-[11px] dark:bg-white/5">{JSON.stringify(f.detail, null, 2)}</pre>

            <p className="mt-3 font-mono text-xs text-muted dark:text-muted-dark">
              {f.alertedAt ? `alerted ${new Date(f.alertedAt).toLocaleString()}` : "not yet alerted"}
              {f.acknowledgedAt && ` · acknowledged by ${f.acknowledgedByEmail} at ${new Date(f.acknowledgedAt).toLocaleString()}`}
            </p>

            {f.events.length > 0 && (
              <div className="mt-4 border-t border-line pt-3 dark:border-line-dark">
                <p className="field-label mb-2">History</p>
                <ul className="flex flex-col gap-2">
                  {f.events.map((e) => (
                    <li key={e.id} className="text-sm">
                      <span className="font-mono text-xs text-muted dark:text-muted-dark">
                        {new Date(e.createdAt).toLocaleString()} · {e.memberEmail} · {e.type}
                      </span>
                      {e.note && <p className="mt-0.5">{e.note}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!f.resolvedAt && (
              <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 dark:border-line-dark">
                <textarea
                  className="field-input"
                  placeholder="Remediation note (optional for acknowledging, required to add a note)"
                  value={noteDrafts[f.id] ?? ""}
                  onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [f.id]: e.target.value }))}
                  rows={2}
                />
                <div className="flex gap-3">
                  {!f.acknowledgedAt && (
                    <button className="btn-primary" onClick={() => acknowledge(f.id)} disabled={busyId === f.id}>
                      Acknowledge
                    </button>
                  )}
                  <button className="btn-secondary" onClick={() => addNote(f.id)} disabled={busyId === f.id}>
                    Add note
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}
