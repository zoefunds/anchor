"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StatusStamp } from "@/components/StatusStamp";
import { EmailVerificationBanner } from "@/components/EmailVerificationBanner";
import { Walkthrough } from "@/components/Walkthrough";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "@/lib/deployment-registry";

// Same preset this project already offers on Settings → Settlement
// integrations — an org doesn't deploy its own DecisionRelay/escrow
// program on this testnet, they all settle through these same
// operator-approved contracts (see lib/hyperlane.ts's
// isApprovedSettlementContract), so there's exactly one right answer per
// chain here too. Filing a case previously required knowing/pasting this
// by hand with no help from the UI, unlike the settlement-integrations
// form.
const SETTLEMENT_TARGET_PRESETS: Record<string, string> = {
  sepolia: ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay,
  solanatestnet: "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN",
};
// Solana's settlement target needs a SECOND preset address (the escrow
// program, separate from the decision-relay program above) — Sepolia
// doesn't have an equivalent second field, since its escrow address is
// looked up server-side from the bound settlement integration instead.
const SETTLEMENT_ESCROW_PRESETS: Record<string, string> = {
  solanatestnet: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
};

interface CaseSummary {
  id: string;
  status: string;
  claim: string;
  amount: string;
  currency: string;
  settlementChain: string | null;
  policyId: string;
  claimantRef: string;
  respondentRef: string;
  createdAt: string;
}

// The amount is always denominated in the settlement chain's own native
// asset (real ETH moved by Escrow.sol, real SOL moved by the Solana
// escrow program — neither moves any stablecoin) — see
// chains/evm/contracts/Escrow.sol's payable deposit()/settle() and
// chains/solana/programs/escrow's lamport-denominated CaseAccount.
// Case.currency defaulting to "USD" was a launch-era placeholder that
// never reflected the real settlement asset; this derives the correct
// label from settlementChain once one is bound, falling back to the
// stored currency only for a case with no settlement target yet (a
// decision-only case that was never meant to move funds on any chain).
const NATIVE_ASSET_LABELS: Record<string, string> = {
  sepolia: "ETH",
  solanatestnet: "SOL",
};

function displayCurrency(c: { currency: string; settlementChain: string | null }): string {
  return (c.settlementChain && NATIVE_ASSET_LABELS[c.settlementChain]) || c.currency;
}

interface PolicySummary {
  id: string;
  label: string;
  description: string;
}

export default function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [policies, setPolicies] = useState<PolicySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [policyId, setPolicyId] = useState("");
  const [claim, setClaim] = useState("service_not_delivered");
  const [amount, setAmount] = useState("1000");
  const [claimantRef, setClaimantRef] = useState("party_A");
  const [respondentRef, setRespondentRef] = useState("party_B");
  const [creating, setCreating] = useState(false);
  const [newPartyTokens, setNewPartyTokens] = useState<{
    caseId: string;
    claimantToken: string;
    respondentToken: string;
  } | null>(null);

  // Settlement target — optional. Leaving this at "none" is the common
  // case and behaves exactly as before: the decision is recorded and
  // nothing is dispatched cross-chain. Setting it wires up the Hyperlane
  // DecisionRelay dispatch (see lib/hyperlane.ts) once the case reaches
  // FINALIZED. Previously only settable via a raw API call — a case
  // filed through this form had no way to configure one at all.
  const [settlementChain, setSettlementChain] = useState<"" | "sepolia" | "solanatestnet">("");
  const [settlementContract, setSettlementContract] = useState("");
  const [settlementSolanaClaimant, setSettlementSolanaClaimant] = useState("");
  const [settlementSolanaRespondent, setSettlementSolanaRespondent] = useState("");
  const [settlementSolanaEscrowProgram, setSettlementSolanaEscrowProgram] = useState("");
  const [settlementSolanaCaseId, setSettlementSolanaCaseId] = useState("");

  async function loadCases() {
    setLoading(true);
    try {
      const res = await fetch("/api/cases");
      const data = await res.json();
      setCases(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadPolicies() {
    const res = await fetch("/api/policies");
    if (res.ok) {
      const data: PolicySummary[] = await res.json();
      setPolicies(data);
      if (data.length > 0) setPolicyId((prev) => prev || data[0].id);
    }
  }

  useEffect(() => {
    loadCases();
    loadPolicies();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim,
          // Real regression from the backend's own precision fix (see
          // lib/money.ts): the API now requires amount as a JSON
          // string, rejecting numeric literals outright since
          // precision can already be lost by the time a JS number
          // reaches validation. This form's `amount` state is already
          // a string (bound directly to the input's value) — sending
          // it as Number(amount) here was silently reintroducing
          // exactly the bug the backend fix was meant to close.
          amount,
          claimantRef,
          respondentRef,
          policyId,
          ...(settlementChain
            ? {
                settlementChain,
                settlementContract,
                ...(settlementChain === "solanatestnet"
                  ? {
                      settlementSolanaClaimant,
                      settlementSolanaRespondent,
                      settlementSolanaEscrowProgram,
                      settlementSolanaCaseId,
                    }
                  : {}),
              }
            : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "failed to create case");
      }
      // Shown exactly once — the API never returns the raw tokens again
      // after this response (only their hashes are stored). Hand these
      // to the actual claimant/respondent so they can submit evidence or
      // appeal independently, via /api/public/cases/:id/* — see
      // lib/party-auth.ts.
      setNewPartyTokens({
        caseId: body.id,
        claimantToken: body.claimantToken,
        respondentToken: body.respondentToken,
      });
      setSettlementChain("");
      setSettlementContract("");
      setSettlementSolanaClaimant("");
      setSettlementSolanaRespondent("");
      setSettlementSolanaEscrowProgram("");
      setSettlementSolanaCaseId("");
      await loadCases();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const selectedPolicy = policies.find((p) => p.id === policyId);

  return (
    <main className="mx-auto max-w-5xl px-8 py-16">
      <EmailVerificationBanner />
      <header className="mb-12 border-b border-line pb-8 pt-10 dark:border-line-dark">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="kicker text-seal-500 dark:text-seal-400">The Docket</p>
            <h1 className="font-display text-4xl font-semibold tracking-tight text-ink-950 dark:text-ink">
              Cases
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <Walkthrough />
            <Link
              href="/settings/settlement-integrations"
              className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
            >
              Settings →
            </Link>
          </div>
        </div>
      </header>

      {newPartyTokens && (
        <section className="dossier mb-10 border-2 border-seal-500 dark:border-seal-400">
          <p className="kicker mb-4 text-seal-500 dark:text-seal-400">Party links, shown once</p>
          <p className="mb-4 text-sm text-muted dark:text-muted-dark">
            Hand each token to the actual claimant/respondent so they can submit evidence or appeal
            independently, without an Anchor account. These are shown exactly once. If lost, reissue via{" "}
            <code className="font-mono text-xs">POST /api/cases/{newPartyTokens.caseId}/party-tokens</code>.
          </p>
          <div className="flex flex-col gap-3">
            <div>
              <span className="field-label">Claimant link</span>
              <code className="mt-1 block break-all rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
                {typeof window !== "undefined" ? window.location.origin : ""}/public/cases/{newPartyTokens.caseId}?token={newPartyTokens.claimantToken}
              </code>
            </div>
            <div>
              <span className="field-label">Respondent link</span>
              <code className="mt-1 block break-all rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
                {typeof window !== "undefined" ? window.location.origin : ""}/public/cases/{newPartyTokens.caseId}?token={newPartyTokens.respondentToken}
              </code>
            </div>
          </div>

          <p className="mt-6 mb-2 text-sm text-muted dark:text-muted-dark">
            Optional, for stronger, cryptographic attribution (a link alone can be forwarded; a
            signature can&apos;t be used to forge a submission after the fact). A party who wants this
            generates their own Ed25519 keypair themselves (Anchor never sees the private key) and
            registers the public half via <code className="font-mono text-xs">POST /api/public/cases/{newPartyTokens.caseId}/signing-key</code>{" "}
            (authenticated with their own token/session above), then includes a signature on future
            evidence submissions.
          </p>
          <button
            type="button"
            className="mt-4 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
            onClick={() => setNewPartyTokens(null)}
          >
            Dismiss
          </button>
        </section>
      )}

      <section className="dossier mb-10">
        <p className="kicker mb-6">File a new case</p>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
          <label className="flex flex-col gap-2 sm:col-span-2">
            <span className="field-label">Policy</span>
            <select className="field-input" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {selectedPolicy && (
              <span className="mt-1 text-xs text-muted dark:text-muted-dark">{selectedPolicy.description}</span>
            )}
          </label>
          <label className="flex flex-col gap-2">
            <span className="field-label">Claim</span>
            <input className="field-input" value={claim} onChange={(e) => setClaim(e.target.value)} />
          </label>
          <label className="flex flex-col gap-2">
            <span className="field-label">
              Amount{settlementChain ? ` (${NATIVE_ASSET_LABELS[settlementChain]})` : ""}
            </span>
            <input
              className="field-input"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {!settlementChain && (
              <span className="text-xs text-muted dark:text-muted-dark">
                Choose a settlement target below to enter this in ETH or SOL. Settlement always moves the
                chain&apos;s native asset, never a stablecoin.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-2">
            <span className="field-label">Claimant ref</span>
            <input
              className="field-input"
              value={claimantRef}
              onChange={(e) => setClaimantRef(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="field-label">Respondent ref</span>
            <input
              className="field-input"
              value={respondentRef}
              onChange={(e) => setRespondentRef(e.target.value)}
            />
          </label>

          <div className="sm:col-span-2 mt-2 border-t border-line pt-6 dark:border-line-dark">
            <label className="flex flex-col gap-2">
              <span className="field-label">Settlement target (optional)</span>
              <select
                className="field-input"
                value={settlementChain}
                onChange={(e) => setSettlementChain(e.target.value as typeof settlementChain)}
              >
                <option value="">None, record the decision only, don&apos;t settle cross-chain</option>
                <option value="sepolia">Sepolia (EVM), DecisionRelay.sol</option>
                <option value="solanatestnet">Solana Devnet, decision-relay program</option>
              </select>
              <span className="mt-1 text-xs text-muted dark:text-muted-dark">
                When set, a finalized decision on GenLayer gets relayed via Hyperlane to this
                chain/contract, which then calls settle() to move funds. Anchor&apos;s own backend
                wallet dispatches this. GenLayer itself isn&apos;t a Hyperlane chain, so it can&apos;t
                send the message directly.
              </span>
            </label>
          </div>

          {settlementChain && (
            <div className="flex flex-col gap-2 sm:col-span-2">
              <button
                type="button"
                onClick={() => {
                  setSettlementContract(SETTLEMENT_TARGET_PRESETS[settlementChain]);
                  if (settlementChain === "solanatestnet") setSettlementSolanaEscrowProgram(SETTLEMENT_ESCROW_PRESETS.solanatestnet);
                }}
                className="self-start rounded-md border border-seal-500/40 px-3 py-1.5 text-xs font-medium text-seal-600 hover:bg-seal-50 dark:border-seal-400/40 dark:text-seal-400 dark:hover:bg-seal-500/10"
              >
                Use Anchor&apos;s testnet contract for {settlementChain === "sepolia" ? "Sepolia (EVM)" : "Solana Devnet"}
              </button>
              <label className="flex flex-col gap-2">
                <span className="field-label">
                  {settlementChain === "sepolia" ? "DecisionRelay.sol address" : "decision-relay program ID"}
                </span>
                <input
                  className="field-input font-mono text-xs"
                  value={settlementContract}
                  onChange={(e) => setSettlementContract(e.target.value)}
                  placeholder={settlementChain === "sepolia" ? "0x…" : "base58 program ID"}
                  required
                />
              </label>
            </div>
          )}

          {settlementChain === "solanatestnet" && (
            <>
              <label className="flex flex-col gap-2">
                <span className="field-label">Solana claimant pubkey</span>
                <input
                  className="field-input font-mono text-xs"
                  value={settlementSolanaClaimant}
                  onChange={(e) => setSettlementSolanaClaimant(e.target.value)}
                  required
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="field-label">Solana respondent pubkey</span>
                <input
                  className="field-input font-mono text-xs"
                  value={settlementSolanaRespondent}
                  onChange={(e) => setSettlementSolanaRespondent(e.target.value)}
                  required
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="field-label">Escrow program ID</span>
                <input
                  className="field-input font-mono text-xs"
                  value={settlementSolanaEscrowProgram}
                  onChange={(e) => setSettlementSolanaEscrowProgram(e.target.value)}
                  required
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="field-label">On-chain escrow case ID</span>
                <input
                  className="field-input font-mono text-xs"
                  value={settlementSolanaCaseId}
                  onChange={(e) => setSettlementSolanaCaseId(e.target.value)}
                  placeholder="e.g. CASE-RELAY-1"
                  required
                />
              </label>
            </>
          )}

          <div className="sm:col-span-2">
            <button className="btn-primary mt-2" type="submit" disabled={creating || !policyId}>
              {creating ? "Filing…" : "File case"}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <p className="mb-8 border-l-2 border-status-undetermined bg-status-undetermined/5 py-2 pl-4 text-sm text-status-undetermined">
          {error}
        </p>
      )}

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <p className="kicker">
            {cases.length} {cases.length === 1 ? "case" : "cases"} on file
          </p>
          {loading && <span className="font-mono text-xs text-muted dark:text-muted-dark">loading…</span>}
        </div>

        {cases.length === 0 && !loading ? (
          <p className="border-t border-line py-12 text-center text-sm text-muted dark:border-line-dark dark:text-muted-dark">
            No cases on file yet.
          </p>
        ) : (
          <div className="overflow-x-auto border-t border-line dark:border-line-dark">
            <table className="w-full min-w-[780px] border-collapse text-sm">
              <thead>
                <tr className="text-left">
                  <th className="kicker py-3 pr-4 font-semibold">Docket No.</th>
                  <th className="kicker py-3 pr-4 font-semibold">Status</th>
                  <th className="kicker py-3 pr-4 font-semibold">Policy</th>
                  <th className="kicker py-3 pr-4 font-semibold">Claim</th>
                  <th className="kicker py-3 pr-4 font-semibold">Amount</th>
                  <th className="kicker py-3 pr-4 font-semibold">Parties</th>
                  <th className="kicker py-3 pr-4 font-semibold">Filed</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id} className="border-t border-line dark:border-line-dark">
                    <td className="py-4 pr-4 font-mono text-xs text-muted dark:text-muted-dark">
                      <Link href={`/cases/${c.id}`} className="text-ink-950 hover:text-seal-500 dark:text-ink dark:hover:text-seal-400">
                        {c.id.slice(0, 12)}
                      </Link>
                    </td>
                    <td className="py-4 pr-4">
                      <StatusStamp status={c.status} />
                    </td>
                    <td className="py-4 pr-4 font-mono text-xs text-muted dark:text-muted-dark">{c.policyId}</td>
                    <td className="py-4 pr-4">{c.claim}</td>
                    <td className="py-4 pr-4 font-mono tabular-nums">
                      {c.amount} {displayCurrency(c)}
                    </td>
                    <td className="py-4 pr-4 text-muted dark:text-muted-dark">
                      {c.claimantRef} <span className="mx-1.5 text-line dark:text-line-dark">v.</span>{" "}
                      {c.respondentRef}
                    </td>
                    <td className="py-4 pr-4 text-muted dark:text-muted-dark">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
