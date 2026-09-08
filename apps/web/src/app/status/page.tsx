"use client";

import { useEffect, useState } from "react";

// Phase 5, last item: public status page, no auth. Deliberately thin
// compared to settings/ops/page.tsx (Phase 3's internal console) —
// this renders only what GET /api/status returns, and that route
// itself withholds anything sensitive (see its own header comment).

type ComponentStatus = "up" | "degraded" | "down";

interface StatusData {
  environment: string;
  generatedAt: string;
  components: {
    database: ComponentStatus;
    redis: ComponentStatus;
    evmRpc: ComponentStatus;
    solanaRpc: ComponentStatus;
    workerRelayer: ComponentStatus;
  };
  canary: { lastRunAt: string; outcome: string } | null;
  incidents: Array<{
    title: string;
    description: string;
    status: "INVESTIGATING" | "MONITORING" | "RESOLVED";
    startedAt: string;
    resolvedAt: string | null;
  }>;
  reliabilityWindow: {
    status: "PASS" | "FAIL" | "EXTENDED" | "NOT_STARTED";
    dayOfWindow: number;
    targetDays: number;
    totalObservations: number;
    lastObservationAt: string | null;
    failTickCount: number;
  };
  auditPackageUrl: string;
  knownLimitations: string[];
}

const COMPONENT_LABELS: Record<keyof StatusData["components"], string> = {
  database: "Database",
  redis: "Redis",
  evmRpc: "EVM RPC (Sepolia)",
  solanaRpc: "Solana RPC (devnet/testnet)",
  workerRelayer: "Worker / relayer",
};

function Dot({ status }: { status: ComponentStatus }) {
  const color = status === "up" ? "text-status-settled" : status === "degraded" ? "text-status-adjudicating" : "text-status-undetermined";
  const label = status === "up" ? "operational" : status === "degraded" ? "degraded" : "down";
  return <span className={color}>● {label}</span>;
}

export default function StatusPage() {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/status");
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "status temporarily unavailable");
          return;
        }
        setData(body);
      } catch {
        if (!cancelled) setError("status temporarily unavailable");
      }
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-xl font-semibold">Anchor status</h1>
      <p className="mt-1 text-sm text-muted dark:text-muted-dark">
        {data?.environment ?? "TESTNET — no real value"}
      </p>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      {data && (
        <>
          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase text-muted dark:text-muted-dark">Components</h2>
            <ul className="mt-2 divide-y">
              {(Object.keys(data.components) as Array<keyof StatusData["components"]>).map((key) => (
                <li key={key} className="flex items-center justify-between py-2 text-sm">
                  <span>{COMPONENT_LABELS[key]}</span>
                  <Dot status={data.components[key]} />
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase text-muted dark:text-muted-dark">Latest canary</h2>
            {data.canary ? (
              <p className="mt-2 text-sm">
                {data.canary.outcome} — {new Date(data.canary.lastRunAt).toLocaleString()}
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted dark:text-muted-dark">No canary runs recorded yet.</p>
            )}
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase text-muted dark:text-muted-dark">30-day reliability observation window</h2>
            <p className="mt-2 text-sm">
              {data.reliabilityWindow.status === "NOT_STARTED"
                ? "Not yet started — no observation ticks recorded."
                : `Day ${data.reliabilityWindow.dayOfWindow} of ${data.reliabilityWindow.targetDays} — ${data.reliabilityWindow.status}`}
            </p>
            <p className="mt-1 text-xs text-muted dark:text-muted-dark">
              {data.reliabilityWindow.totalObservations} observation(s) recorded
              {data.reliabilityWindow.lastObservationAt ? `, last at ${new Date(data.reliabilityWindow.lastObservationAt).toLocaleString()}` : ""}.
              {data.reliabilityWindow.failTickCount > 0 ? ` ${data.reliabilityWindow.failTickCount} fail tick(s) recorded — none excluded or rewritten.` : ""}
            </p>
            <p className="mt-2 text-xs">
              <a href={data.auditPackageUrl} className="underline">
                External audit package
              </a>{" "}
              — deployment identity, topology, threat model, and test evidence for independent review.
            </p>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase text-muted dark:text-muted-dark">Known custody &amp; independence limitations</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted dark:text-muted-dark">
              {data.knownLimitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase text-muted dark:text-muted-dark">Incidents</h2>
            {data.incidents.length === 0 ? (
              <p className="mt-2 text-sm text-muted dark:text-muted-dark">No incidents to report.</p>
            ) : (
              <ul className="mt-2 space-y-4">
                {data.incidents.map((inc) => (
                  <li key={`${inc.title}-${inc.startedAt}`} className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{inc.title}</span>
                      <span className="text-xs uppercase text-muted dark:text-muted-dark">{inc.status}</span>
                    </div>
                    <p className="mt-1 text-muted dark:text-muted-dark">{inc.description}</p>
                    <p className="mt-1 text-xs text-muted dark:text-muted-dark">
                      Started {new Date(inc.startedAt).toLocaleString()}
                      {inc.resolvedAt ? ` — resolved ${new Date(inc.resolvedAt).toLocaleString()}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="mt-10 text-xs text-muted dark:text-muted-dark">
            Last updated {new Date(data.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </main>
  );
}
