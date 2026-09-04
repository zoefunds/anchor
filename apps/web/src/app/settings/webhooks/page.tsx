"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Kept in sync with lib/webhooks.ts's real WEBHOOK_EVENTS by hand
// (not imported directly — that module also exports the
// server-only/crypto-dependent encrypt/decrypt functions, which
// shouldn't end up in a client bundle). "case.relay_dispatched" was
// already missing from this list before the two emergency-refund
// events below were added — fixed here rather than compounding it.
const ALL_EVENTS = [
  "case.status_changed",
  "case.decided",
  "case.appealed",
  "case.relay_dispatched",
  "case.emergency_refund_requested",
  "case.emergency_refund_settled",
] as const;

interface WebhookSummary {
  id: string;
  url: string;
  // Real P1 fixed here (external audit finding, raised twice): this used
  // to be the full plaintext signing secret, returned and displayed on
  // every page load. The API now only ever returns secretPreview (a
  // short masked prefix) from a list — the real secret is shown exactly
  // once, right after creation or rotation, via revealedSecret state
  // below, never persisted or re-fetchable after that.
  secretPreview: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([...ALL_EVENTS]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // { webhookId, secret } for the one-time-reveal banner — cleared as
  // soon as the user navigates away or creates/rotates another one.
  const [revealedSecret, setRevealedSecret] = useState<{ webhookId: string; secret: string } | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/webhooks");
    if (res.status === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) setWebhooks(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  function toggleEvent(e: string) {
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, events }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create webhook");
      setUrl("");
      setRevealedSecret({ webhookId: body.id, secret: body.secret });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (revealedSecret?.webhookId === id) setRevealedSecret(null);
    await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
    await load();
  }

  async function handleRotate(id: string) {
    setRotatingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/webhooks/${id}/rotate-secret`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to rotate secret");
      setRevealedSecret({ webhookId: id, secret: body.secret });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRotatingId(null);
    }
  }

  if (forbidden) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">Only your organization's owner can manage webhooks.</p>
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
        <Link href="/settings/settlement-integrations" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Settlement →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Integrations</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
          Webhooks
        </h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Get notified the moment a case's status changes instead of polling{" "}
          <code className="font-mono">GET /api/cases/:id</code>. Every delivery is signed —
          verify <code className="font-mono">X-Anchor-Signature</code> as HMAC-SHA256 of the raw
          body using the webhook's secret.
        </p>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        <p className="kicker mb-4">Add a webhook</p>
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="field-label">Endpoint URL</span>
            <input
              className="field-input"
              type="url"
              placeholder="https://your-service.example.com/webhooks/anchor"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="field-label">Events</span>
            <div className="flex flex-wrap gap-4 font-mono text-xs">
              {ALL_EVENTS.map((e) => (
                <label key={e} className="flex items-center gap-2">
                  <input type="checkbox" checked={events.includes(e)} onChange={() => toggleEvent(e)} />
                  {e}
                </label>
              ))}
            </div>
          </div>
          <button className="btn-primary self-start" type="submit" disabled={creating || events.length === 0}>
            {creating ? "Adding…" : "Add webhook"}
          </button>
        </form>
      </section>

      <section className="mt-12">
        <p className="kicker mb-4">Subscribed webhooks</p>
        <div className="border-t border-line dark:border-line-dark">
          {webhooks.length === 0 && (
            <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">No webhooks yet.</p>
          )}
          {webhooks.map((w) => (
            <div key={w.id} className="border-b border-line py-4 dark:border-line-dark">
              <div className="flex items-center justify-between">
                <p className="break-all text-sm font-medium">{w.url}</p>
                <div className="ml-4 flex shrink-0 gap-3">
                  <button
                    onClick={() => handleRotate(w.id)}
                    disabled={rotatingId === w.id}
                    className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
                  >
                    {rotatingId === w.id ? "Rotating…" : "Rotate secret"}
                  </button>
                  <button
                    onClick={() => handleDelete(w.id)}
                    className="font-mono text-xs text-muted hover:text-status-undetermined dark:text-muted-dark"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
                events: {w.events.join(", ")}
              </p>
              {revealedSecret?.webhookId === w.id ? (
                <div className="mt-2 rounded border border-seal-500/40 bg-seal-500/5 p-3 dark:border-seal-400/40">
                  <p className="text-xs font-medium text-seal-500 dark:text-seal-400">
                    Copy this secret now — it will not be shown again.
                  </p>
                  <p className="mt-1 break-all font-mono text-xs">{revealedSecret.secret}</p>
                </div>
              ) : (
                <p className="mt-1 break-all font-mono text-xs text-muted dark:text-muted-dark">
                  secret: {w.secretPreview}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
