"use client";

import { useCallback, useEffect, useState } from "react";

// Shared data/action layer for the party-facing case view. Extracted so
// both the full page (/public/cases/[id]) and the embeddable widget
// (/public/widget/[id]) hit the exact same endpoints and auth flow
// instead of drifting out of sync. Nothing here ever touches a wallet,
// private key, or chain ID — settlement addresses are plain strings the
// party types in, and the chain/asset shown (kase.settlement.chain) is
// informational text from the org's SettlementIntegration, not
// something this page connects to or signs with.

export interface PublicEvidence {
  id: string;
  type: string;
  storageRef: string;
  mimeType: string | null;
  createdAt: string;
}

export interface PublicDecision {
  outcome: string;
  claimantShareBps: number | null;
  respondentShareBps: number | null;
  reasonCodes: string[];
  consensus: string;
  appealWindowClosesAt: string | null;
  createdAt: string;
}

export interface PublicSettlement {
  status: "PENDING_DEPOSIT" | "DEPOSITED" | "SETTLED" | "MISMATCH_BLOCKED";
  chain: string;
  assetSymbol: string;
  expectedAmountAtto: string;
  claimantAddress: string | null;
  respondentAddress: string | null;
}

export interface PublicPolicy {
  evidenceDeadlineHours: number;
  appealWindowHours: number;
}

export interface PublicCase {
  id: string;
  status: string;
  claim: string;
  amount: string;
  currency: string;
  policyId: string;
  claimantRef: string;
  respondentRef: string;
  createdAt: string;
  evidence: PublicEvidence[];
  decisions: PublicDecision[];
  role: "claimant" | "respondent" | null;
  settlement: PublicSettlement | null;
  policy: PublicPolicy | null;
}

export function usePublicCase(id: string, token: string | null) {
  const [kase, setKase] = useState<PublicCase | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/public/cases/${id}`);
    if (res.ok) setKase(await res.json());
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Exchange a raw token in the URL for a short-lived HttpOnly
      // session cookie, then strip it from the address bar — see the
      // long-form rationale this used to carry inline (moved here so
      // both consumers of this hook get the same behavior).
      if (token) {
        const exchangeRes = await fetch(`/api/public/cases/${id}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (exchangeRes.ok) {
          const url = new URL(window.location.href);
          url.searchParams.delete("token");
          window.history.replaceState(null, "", url.pathname + url.search);
        }
      }

      const res = await fetch(`/api/public/cases/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "case not found");
      }
      if (!cancelled) setKase(await res.json());
    }
    load().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [id, token]);

  return { kase, error, refresh };
}

export async function setPayoutAddress(id: string, address: string): Promise<{ address: string }> {
  const res = await fetch(`/api/public/cases/${id}/settlement-address`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "failed to set payout address");
  return body;
}

export async function submitTextEvidence(id: string, type: string, content: string): Promise<void> {
  const res = await fetch(`/api/public/cases/${id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, content }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to submit evidence");
  }
}

export async function submitFileEvidence(id: string, type: string, file: File): Promise<void> {
  const form = new FormData();
  form.set("type", type);
  form.set("file", file);
  const res = await fetch(`/api/public/cases/${id}/evidence/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to upload evidence");
  }
}

export async function fileAppeal(id: string, reason: string): Promise<string> {
  const res = await fetch(`/api/public/cases/${id}/appeal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "failed to file appeal");
  return body.note ?? "Appeal accepted.";
}

/** Human-readable countdown / date for a deadline instant. */
export function formatDeadline(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return `closed (${target.toLocaleString()})`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const rel = days > 0 ? `${days}d ${remHours}h remaining` : `${remHours}h remaining`;
  return `${rel} — closes ${target.toLocaleString()}`;
}
