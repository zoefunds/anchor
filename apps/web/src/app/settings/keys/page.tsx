"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Real scope vocabulary this key-creation form offers — kept in sync
// manually with lib/api-scopes.ts's API_SCOPES (a client component can't
// import a server-only lib module's const array across the app/api
// boundary here without pulling in its neighboring server code, so this
// list must be updated if that file's vocabulary changes).
const API_SCOPES = [
  "cases:read",
  "cases:write",
  "evidence:write",
  "settlements:read",
  "settlements:write",
  "settlements:export",
  "analytics:read",
  "policies:read",
  "organizations:read",
] as const;

interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  scopes: string[];
  rotatedFromKeyId: string | null;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/api-keys");
    if (res.ok) setKeys(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scopes,
          expiresInDays: expiresInDays === "" ? null : Number(expiresInDays),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create key");
      setFreshKey(body.key);
      setName("");
      setScopes([]);
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

  async function handleRotate(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/api-keys/${id}/rotate`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to rotate key");
      setFreshKey(body.key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
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
          Every key acts on behalf of your organization. The same cases you see here are
          reachable by any agent or service holding one of these keys, via{" "}
          <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
        </p>
      </header>

      {freshKey && (
        <div className="mt-8 border-l-2 border-seal-500 bg-seal-50/50 py-4 pl-4 dark:bg-seal-500/5">
          <p className="field-label mb-2">New key, shown once, copy it now</p>
          <p className="break-all font-mono text-sm text-ink-950 dark:text-ink">{freshKey}</p>
        </div>
      )}

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        <p className="kicker mb-4">Issue a new key</p>
        <form onSubmit={handleCreate} className="dossier flex flex-col gap-4">
          <div className="flex items-end gap-4">
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
            <label className="flex w-40 flex-col gap-2">
              <span className="field-label">Expires (days)</span>
              <input
                className="field-input"
                type="number"
                min={1}
                placeholder="never"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
              />
            </label>
          </div>
          <div>
            <p className="field-label mb-2">Scopes (none checked = full org-wide access)</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {API_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 font-mono text-xs">
                  <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                  {scope}
                </label>
              ))}
            </div>
          </div>
          <button className="btn-primary self-start" type="submit" disabled={creating}>
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
                  {k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : " · never expires"}
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted dark:text-muted-dark">
                  scopes: {k.scopes.length > 0 ? k.scopes.join(", ") : "full org-wide access"}
                  {k.rotatedFromKeyId && " · rotated"}
                </p>
              </div>
              {k.revokedAt ? (
                <span className="font-mono text-xs uppercase text-status-undetermined">Revoked</span>
              ) : (
                <div className="flex gap-3">
                  <button
                    onClick={() => handleRotate(k.id)}
                    disabled={busyId === k.id}
                    className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
                  >
                    Rotate
                  </button>
                  <button
                    onClick={() => handleRevoke(k.id)}
                    disabled={busyId === k.id}
                    className="font-mono text-xs text-muted hover:text-status-undetermined dark:text-muted-dark"
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
