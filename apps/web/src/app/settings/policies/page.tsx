"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface PolicyVersion {
  id: string;
  version: number;
  active: boolean;
  publishedAt: string;
  publishedByMemberId: string | null;
  evidenceDeadlineHours: number;
  appealWindowHours: number;
  allowedOutcomes: string[];
  autoSettlementCapUsd: string | null;
  allowedAssets: string[];
  allowedChains: string[];
  kycRequired: boolean;
  velocityLimits: Record<string, number>;
  humanReviewTriggers: Record<string, number>;
}

interface Policy {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  versions: PolicyVersion[];
}

interface FormState {
  key: string;
  name: string;
  evidenceDeadlineHours: string;
  appealWindowHours: string;
  allowedOutcomes: string;
  autoSettlementCapUsd: string;
  allowedAssets: string;
  allowedChains: string;
  kycRequired: boolean;
}

const EMPTY_FORM: FormState = {
  key: "",
  name: "",
  evidenceDeadlineHours: "72",
  appealWindowHours: "48",
  allowedOutcomes: "CLAIMANT_WINS, RESPONDENT_WINS, SPLIT",
  autoSettlementCapUsd: "",
  allowedAssets: "USDC",
  allowedChains: "",
  kycRequired: false,
};

function toBody(form: FormState) {
  return {
    key: form.key || undefined,
    name: form.name,
    evidenceDeadlineHours: Number(form.evidenceDeadlineHours),
    appealWindowHours: Number(form.appealWindowHours),
    allowedOutcomes: form.allowedOutcomes.split(",").map((s) => s.trim()).filter(Boolean),
    autoSettlementCapUsd: form.autoSettlementCapUsd ? Number(form.autoSettlementCapUsd) : null,
    allowedAssets: form.allowedAssets.split(",").map((s) => s.trim()).filter(Boolean),
    allowedChains: form.allowedChains.split(",").map((s) => s.trim()).filter(Boolean),
    kycRequired: form.kycRequired,
  };
}

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState<FormState>(EMPTY_FORM);
  const [versionForms, setVersionForms] = useState<Record<string, FormState>>({});
  const [publishing, setPublishing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  async function load() {
    const res = await fetch("/api/org-policies");
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) setPolicies(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  function formForVersion(policy: Policy): FormState {
    if (versionForms[policy.id]) return versionForms[policy.id];
    const active = policy.versions.find((v) => v.active) ?? policy.versions[0];
    if (!active) return EMPTY_FORM;
    return {
      key: policy.key,
      name: policy.name,
      evidenceDeadlineHours: String(active.evidenceDeadlineHours),
      appealWindowHours: String(active.appealWindowHours),
      allowedOutcomes: active.allowedOutcomes.join(", "),
      autoSettlementCapUsd: active.autoSettlementCapUsd ?? "",
      allowedAssets: active.allowedAssets.join(", "),
      allowedChains: active.allowedChains.join(", "),
      kycRequired: active.kycRequired,
    };
  }

  async function createPolicy(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/org-policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBody(newForm)),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create policy");
      setNewForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function publishVersion(policy: Policy) {
    setPublishing(policy.id);
    setError(null);
    try {
      const form = formForVersion(policy);
      const res = await fetch(`/api/org-policies/${policy.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBody(form)),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to publish version");
      setVersionForms((prev) => {
        const next = { ...prev };
        delete next[policy.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(null);
    }
  }

  if (forbidden) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">
          Policy configuration is OWNER-only for this organization.
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
        <Link href="/settings/analytics" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Analytics →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Governance</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Policies</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Your organization's own dispute-governance config — evidence deadlines, appeal windows,
          allowed outcomes/assets/chains, KYC requirement, and auto-settlement cap. Publishing never
          edits a version in place; it inserts a new one and every case already bound to an older
          version keeps reading it unchanged.
        </p>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        <p className="kicker mb-4">New policy</p>
        <form onSubmit={createPolicy} className="dossier flex flex-col gap-4">
          <div className="flex gap-4">
            <label className="flex flex-1 flex-col gap-2">
              <span className="field-label">Key</span>
              <input
                className="field-input"
                placeholder="e.g. us-consumer"
                value={newForm.key}
                onChange={(e) => setNewForm((f) => ({ ...f, key: e.target.value }))}
                required
              />
            </label>
            <label className="flex flex-1 flex-col gap-2">
              <span className="field-label">Name</span>
              <input
                className="field-input"
                placeholder="e.g. US consumer disputes"
                value={newForm.name}
                onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </label>
          </div>
          <PolicyFieldset form={newForm} onChange={(f) => setNewForm(f)} />
          <button className="btn-primary self-start" type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create policy and publish v1"}
          </button>
        </form>
      </section>

      <section className="mt-12">
        <p className="kicker mb-4">Existing policies</p>
        {policies.length === 0 && <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">No policies configured yet.</p>}
        {policies.map((policy) => {
          const activeVersion = policy.versions.find((v) => v.active) ?? policy.versions[0];
          const form = formForVersion(policy);
          const isExpanded = expanded[policy.id] ?? false;
          return (
            <div key={policy.id} className="dossier mb-6">
              <div className="flex items-baseline justify-between">
                <div>
                  <p className="font-display text-xl font-semibold text-ink-950 dark:text-ink">{policy.name}</p>
                  <p className="font-mono text-xs text-muted dark:text-muted-dark">key: {policy.key}</p>
                </div>
                <span className="font-mono text-[11px] uppercase tracking-wide text-muted dark:text-muted-dark">
                  {policy.versions.length} version{policy.versions.length === 1 ? "" : "s"}
                </span>
              </div>

              {activeVersion && (
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-4 font-mono text-xs dark:border-line-dark">
                  <dt className="text-muted dark:text-muted-dark">Active version</dt>
                  <dd>v{activeVersion.version}</dd>
                  <dt className="text-muted dark:text-muted-dark">Evidence deadline</dt>
                  <dd>{activeVersion.evidenceDeadlineHours}h</dd>
                  <dt className="text-muted dark:text-muted-dark">Appeal window</dt>
                  <dd>{activeVersion.appealWindowHours}h</dd>
                  <dt className="text-muted dark:text-muted-dark">Allowed outcomes</dt>
                  <dd>{activeVersion.allowedOutcomes.join(", ") || "—"}</dd>
                  <dt className="text-muted dark:text-muted-dark">Auto-settlement cap</dt>
                  <dd>{activeVersion.autoSettlementCapUsd ? `$${activeVersion.autoSettlementCapUsd}` : "none (global default)"}</dd>
                  <dt className="text-muted dark:text-muted-dark">Allowed assets</dt>
                  <dd>{activeVersion.allowedAssets.join(", ") || "any"}</dd>
                  <dt className="text-muted dark:text-muted-dark">Allowed chains</dt>
                  <dd>{activeVersion.allowedChains.join(", ") || "any"}</dd>
                  <dt className="text-muted dark:text-muted-dark">KYC required</dt>
                  <dd>{activeVersion.kycRequired ? "yes" : "no"}</dd>
                </dl>
              )}

              <button
                className="mt-4 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
                onClick={() => setExpanded((prev) => ({ ...prev, [policy.id]: !isExpanded }))}
              >
                {isExpanded ? "Hide version history / publish form ▲" : "Publish a new version ▼"}
              </button>

              {isExpanded && (
                <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4 dark:border-line-dark">
                  {policy.versions.length > 1 && (
                    <div>
                      <p className="field-label mb-2">Version history</p>
                      <ul className="flex flex-col gap-1 font-mono text-xs text-muted dark:text-muted-dark">
                        {policy.versions.map((v) => (
                          <li key={v.id}>
                            v{v.version} — published {new Date(v.publishedAt).toLocaleString()}
                            {v.active ? " (active)" : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <PolicyFieldset form={form} onChange={(f) => setVersionForms((prev) => ({ ...prev, [policy.id]: f }))} />
                  <button className="btn-secondary self-start" onClick={() => publishVersion(policy)} disabled={publishing === policy.id}>
                    {publishing === policy.id ? "Publishing…" : `Publish v${(activeVersion?.version ?? 0) + 1}`}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}

function PolicyFieldset({ form, onChange }: { form: FormState; onChange: (f: FormState) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4">
        <label className="flex flex-1 flex-col gap-2">
          <span className="field-label">Evidence deadline (hours)</span>
          <input
            className="field-input"
            type="number"
            min={1}
            value={form.evidenceDeadlineHours}
            onChange={(e) => onChange({ ...form, evidenceDeadlineHours: e.target.value })}
            required
          />
        </label>
        <label className="flex flex-1 flex-col gap-2">
          <span className="field-label">Appeal window (hours)</span>
          <input
            className="field-input"
            type="number"
            min={1}
            value={form.appealWindowHours}
            onChange={(e) => onChange({ ...form, appealWindowHours: e.target.value })}
            required
          />
        </label>
      </div>
      <label className="flex flex-col gap-2">
        <span className="field-label">Allowed outcomes (comma-separated)</span>
        <input
          className="field-input"
          value={form.allowedOutcomes}
          onChange={(e) => onChange({ ...form, allowedOutcomes: e.target.value })}
          required
        />
      </label>
      <div className="flex gap-4">
        <label className="flex flex-1 flex-col gap-2">
          <span className="field-label">Auto-settlement cap (USD, optional)</span>
          <input
            className="field-input"
            type="number"
            min={0}
            placeholder="uses global default if blank"
            value={form.autoSettlementCapUsd}
            onChange={(e) => onChange({ ...form, autoSettlementCapUsd: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 self-end pb-2">
          <input
            type="checkbox"
            checked={form.kycRequired}
            onChange={(e) => onChange({ ...form, kycRequired: e.target.checked })}
          />
          <span className="field-label">KYC required</span>
        </label>
      </div>
      <div className="flex gap-4">
        <label className="flex flex-1 flex-col gap-2">
          <span className="field-label">Allowed assets (comma-separated, blank = any)</span>
          <input className="field-input" value={form.allowedAssets} onChange={(e) => onChange({ ...form, allowedAssets: e.target.value })} />
        </label>
        <label className="flex flex-1 flex-col gap-2">
          <span className="field-label">Allowed chains (comma-separated, blank = any)</span>
          <input className="field-input" value={form.allowedChains} onChange={(e) => onChange({ ...form, allowedChains: e.target.value })} />
        </label>
      </div>
    </div>
  );
}
