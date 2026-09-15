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
  /** Public on-chain facts (see the /deposit page) — not present on the embeddable widget's own display, only used by the dedicated deposit page. */
  escrowContractAddress: string;
  escrowId: string;
  /** decision-relay program id (Solana only) — needed client-side to derive the escrow_authority PDA that initializeCase's `adjudicator` arg must be. Null for Sepolia, where the deposit page never needs it. */
  decisionRelayProgramId: string | null;
}

export interface PublicPolicy {
  evidenceDeadlineHours: number;
  appealWindowHours: number;
  requiredEvidence: { type: string; label: string; restrictedTo?: "claimant" | "respondent" }[];
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

function partyTokenStorageKey(id: string): string {
  return `anchor_party_token_${id}`;
}

// Deliberately sessionStorage, not a cookie: a cookie is shared browser-
// wide (across every tab in the same profile) under one name, so a
// second party link for the same case opened in another tab silently
// clobbers the first tab's identity the moment it's read again — exactly
// the "which party am I" confusion this replaced. sessionStorage is
// scoped to this one tab, so two tabs — or two profiles, or two separate
// browsers — each hold their own party's token with no way to collide,
// without needing any case+role-scoped naming scheme to keep them apart.
function readStoredPartyToken(id: string): string | null {
  try {
    return sessionStorage.getItem(partyTokenStorageKey(id));
  } catch {
    // Private browsing / storage blocked — fall back to requiring the
    // token in the URL on every load rather than crashing the page.
    return null;
  }
}

function storePartyToken(id: string, token: string): void {
  try {
    sessionStorage.setItem(partyTokenStorageKey(id), token);
  } catch {
    // Ignored — see readStoredPartyToken.
  }
}

export function usePublicCase(id: string, urlToken: string | null) {
  const [kase, setKase] = useState<PublicCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The token this tab actually authenticates as — from the URL on first
  // load, from sessionStorage on every load after (once the URL's own
  // copy has been stripped). Every subsequent request (refresh, evidence,
  // appeal, address) resends this explicitly rather than depending on a
  // cookie to remember it.
  const [token, setToken] = useState<string | null>(() => urlToken ?? (typeof window !== "undefined" ? readStoredPartyToken(id) : null));

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/public/cases/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    if (res.ok) setKase(await res.json());
  }, [id, token]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const effectiveToken = urlToken ?? readStoredPartyToken(id);
      if (urlToken) {
        storePartyToken(id, urlToken);
        const url = new URL(window.location.href);
        url.searchParams.delete("token");
        window.history.replaceState(null, "", url.pathname + url.search);
      }
      if (!cancelled) setToken(effectiveToken);

      const res = await fetch(`/api/public/cases/${id}${effectiveToken ? `?token=${encodeURIComponent(effectiveToken)}` : ""}`);
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
  }, [id, urlToken]);

  return { kase, error, refresh, token };
}

// Every action below takes the tab's own `token` (from usePublicCase)
// and sends it explicitly on each request — not a cookie — so which
// party is acting is never ambiguous between tabs/profiles/browsers.

export async function setPayoutAddress(id: string, token: string | null, address: string): Promise<{ address: string }> {
  const res = await fetch(`/api/public/cases/${id}/settlement-address`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, address }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "failed to set payout address");
  return body;
}

export async function submitTextEvidence(id: string, token: string | null, type: string, content: string): Promise<void> {
  const res = await fetch(`/api/public/cases/${id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, type, content }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to submit evidence");
  }
}

export async function submitFileEvidence(id: string, token: string | null, type: string, file: File): Promise<void> {
  const form = new FormData();
  if (token) form.set("token", token);
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

export async function fileAppeal(id: string, token: string | null, reason: string): Promise<string> {
  const res = await fetch(`/api/public/cases/${id}/appeal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, reason }),
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
