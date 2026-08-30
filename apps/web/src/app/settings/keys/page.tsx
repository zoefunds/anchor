"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/api-keys");
    if (res.ok) setKeys(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create key");
      setFreshKey(body.key);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
    await load();
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
        <Link
          href="/settings/members"
          className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          Members →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Programmatic access</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
          API keys
        </h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Every key acts on behalf of your organization — the same cases you see here are
          reachable by any agent or service holding one of these keys, via{" "}
          <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
        </p>
      </header>

      {freshKey && (
        <div className="mt-8 border-l-2 border-seal-500 bg-seal-50/50 py-4 pl-4 dark:bg-seal-500/5">
          <p className="field-label mb-2">New key — shown once, copy it now</p>
          <p className="break-all font-mono text-sm text-ink-950 dark:text-ink">{freshKey}</p>
        </div>
      )}

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        <p className="kicker mb-4">Issue a new key</p>
        <form onSubmit={handleCreate} className="flex items-end gap-4">
          <label className="flex flex-1 flex-col gap-2">
            <span className="field-label">Name</span>
            <input
              className="field-input"
              placeholder="e.g. production agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <button className="btn-primary" type="submit" disabled={creating}>
            {creating ? "Issuing…" : "Issue key"}
          </button>
        </form>
      </section>

      <section className="mt-12">
        <p className="kicker mb-4">Issued keys</p>
        <div className="border-t border-line dark:border-line-dark">
          {keys.length === 0 && (
            <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">No keys issued yet.</p>
          )}
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between border-b border-line py-4 dark:border-line-dark"
            >
              <div>
                <p className="text-sm font-medium">{k.name}</p>
                <p className="font-mono text-xs text-muted dark:text-muted-dark">
                  {k.keyPrefix}… · issued {new Date(k.createdAt).toLocaleDateString()}
                  {k.lastUsedAt && ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`}
                </p>
              </div>
              {k.revokedAt ? (
                <span className="font-mono text-xs uppercase text-status-undetermined">Revoked</span>
              ) : (
                <button
                  onClick={() => handleRevoke(k.id)}
                  className="font-mono text-xs text-muted hover:text-status-undetermined dark:text-muted-dark"
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
