"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: { type: string; label: string };
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    fetch("/api/audit-log").then(async (res) => {
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (res.ok) setEntries(await res.json());
    });
  }, []);

  if (forbidden) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">Only your organization's owner can view the audit log.</p>
        <Link href="/cases" className="mt-4 inline-block text-sm text-seal-500 hover:underline dark:text-seal-400">
          ← Docket
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <Link
        href="/settings/members"
        className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
      >
        ← Members
      </Link>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Organization</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
          Audit log
        </h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Every mutating action taken in your organization, most recent first.
        </p>
      </header>

      <section className="mt-10">
        <div className="border-t border-line dark:border-line-dark">
          {entries.length === 0 && (
            <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">No activity yet.</p>
          )}
          {entries.map((e) => (
            <div key={e.id} className="border-b border-line py-4 dark:border-line-dark">
              <div className="flex items-center justify-between">
                <p className="font-mono text-sm">{e.action}</p>
                <p className="font-mono text-xs text-muted dark:text-muted-dark">
                  {new Date(e.createdAt).toLocaleString()}
                </p>
              </div>
              <p className="mt-1 text-xs text-muted dark:text-muted-dark">
                {e.actor.type === "api_key" ? "API key" : "member"} · {e.actor.label}
                {e.targetId && (
                  <>
                    {" "}
                    · {e.targetType} <span className="font-mono">{e.targetId.slice(0, 12)}</span>
                  </>
                )}
              </p>
              {e.metadata && Object.keys(e.metadata).length > 0 && (
                <p className="mt-1 break-all font-mono text-xs text-muted dark:text-muted-dark">
                  {JSON.stringify(e.metadata)}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
