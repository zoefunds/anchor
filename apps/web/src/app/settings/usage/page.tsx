"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface OrgUsage {
  organizationId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  cases: number;
  evidenceSubmissions: number;
  decisions: number;
  settlements: number;
}

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPriceUsd: number;
  amountUsd: number;
}

interface StubInvoice {
  organizationId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  lineItems: InvoiceLineItem[];
  totalUsd: number;
  status: "STUB_NOT_INVOICED";
  disclaimer: string;
}

export default function UsagePage() {
  const [period, setPeriod] = useState<string>("");
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  const [invoice, setInvoice] = useState<StubInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const qs = period ? `?period=${period}` : "";
    const [usageRes, invoiceRes] = await Promise.all([
      fetch(`/api/organizations/usage${qs}`),
      fetch(`/api/organizations/invoices${qs}`),
    ]);
    if (!usageRes.ok || !invoiceRes.ok) {
      const body = await (usageRes.ok ? invoiceRes : usageRes).json().catch(() => ({}));
      setError(body.error ?? "failed to load usage");
      return;
    }
    setError(null);
    setUsage(await usageRes.json());
    setInvoice(await invoiceRes.json());
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <div className="flex items-center justify-between">
        <Link
          href="/cases"
          className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          ← Docket
        </Link>
        <Link href="/settings/keys" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          API keys →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Billing</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Usage &amp; billing</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Metered usage is computed live from your organization's own case history, not a persisted
          ledger.
        </p>
        <label className="mt-4 flex max-w-xs flex-col gap-2">
          <span className="field-label">Period (YYYY-MM, blank = current month)</span>
          <input
            className="field-input"
            placeholder={new Date().toISOString().slice(0, 7)}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </label>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      {usage && (
        <section className="mt-10">
          <p className="kicker mb-4">Usage · {usage.period}</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Cases" value={usage.cases} />
            <Stat label="Evidence submissions" value={usage.evidenceSubmissions} />
            <Stat label="Decisions" value={usage.decisions} />
            <Stat label="Settlements" value={usage.settlements} />
          </div>
        </section>
      )}

      {invoice && (
        <section className="mt-12">
          <div className="mb-4 flex items-center justify-between">
            <p className="kicker">Invoice preview · {invoice.period}</p>
            <span className="font-mono text-[11px] uppercase tracking-wide text-status-adjudicating">{invoice.status}</span>
          </div>
          <div className="border-l-2 border-status-adjudicating bg-status-adjudicating/5 py-3 pl-4">
            <p className="text-sm text-muted dark:text-muted-dark">{invoice.disclaimer}</p>
          </div>
          <div className="dossier mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[11px] uppercase text-muted dark:border-line-dark dark:text-muted-dark">
                  <th className="py-2 font-normal">Line item</th>
                  <th className="py-2 text-right font-normal">Qty</th>
                  <th className="py-2 text-right font-normal">Unit</th>
                  <th className="py-2 text-right font-normal">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lineItems.map((li) => (
                  <tr key={li.description} className="border-b border-line last:border-0 dark:border-line-dark">
                    <td className="py-2 font-mono text-xs">{li.description}</td>
                    <td className="py-2 text-right font-mono text-xs text-muted dark:text-muted-dark">{li.quantity}</td>
                    <td className="py-2 text-right font-mono text-xs text-muted dark:text-muted-dark">${li.unitPriceUsd.toFixed(4)}</td>
                    <td className="py-2 text-right font-mono text-xs">${li.amountUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 flex justify-between border-t border-line pt-4 dark:border-line-dark">
              <p className="font-mono text-xs uppercase text-muted dark:text-muted-dark">Total (never charged)</p>
              <p className="font-display text-xl font-semibold text-ink-950 dark:text-ink">${invoice.totalUsd.toFixed(2)}</p>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="dossier">
      <p className="field-label">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-ink-950 dark:text-ink">{value}</p>
    </div>
  );
}
