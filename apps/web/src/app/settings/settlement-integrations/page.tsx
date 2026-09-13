"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "@/lib/deployment-registry";

interface SettlementIntegration {
  id: string;
  chain: string;
  escrowContractAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  active: boolean;
  requireKycApproval: boolean;
  createdAt: string;
}

const CHAIN_OPTIONS = [
  { value: "sepolia", label: "Sepolia (EVM)" },
  { value: "solanatestnet", label: "Solana Testnet" },
];

// Anchor's own operator-approved contracts for this testnet deployment —
// see lib/hyperlane.ts's isApprovedSettlementContract/
// isApprovedSolanaEscrowProgram: an address not on that list is rejected
// at registration regardless of what's typed here. Orgs don't deploy
// their own escrow/DecisionRelay on this testnet; they all settle
// through these same contracts, so there is exactly one right answer
// per chain — this just saves an org owner from having to go find it.
const ANCHOR_TESTNET_CONTRACTS: Record<string, { escrowContractAddress: string; decisionRelayAddress: string; assetSymbol: string; assetDecimals: number }> = {
  sepolia: {
    escrowContractAddress: ACTIVE_SEPOLIA_TOPOLOGY.escrow,
    decisionRelayAddress: ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay,
    assetSymbol: "ETH",
    assetDecimals: 18,
  },
  solanatestnet: {
    escrowContractAddress: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
    decisionRelayAddress: "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN",
    assetSymbol: "SOL",
    assetDecimals: 9,
  },
};

export default function SettlementIntegrationsPage() {
  const [integrations, setIntegrations] = useState<SettlementIntegration[]>([]);
  const [chain, setChain] = useState("sepolia");
  const [escrowContractAddress, setEscrowContractAddress] = useState("");
  const [decisionRelayAddress, setDecisionRelayAddress] = useState("");
  const [assetSymbol, setAssetSymbol] = useState("ETH");
  const [assetDecimals, setAssetDecimals] = useState(18);
  const [requireKycApproval, setRequireKycApproval] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/settlement-integrations");
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      return;
    }
    if (res.ok) setIntegrations(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  function handleChainChange(next: string) {
    setChain(next);
    if (next === "solanatestnet") {
      setAssetSymbol("SOL");
      setAssetDecimals(9);
    } else {
      setAssetSymbol("ETH");
      setAssetDecimals(18);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/settlement-integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain, escrowContractAddress, decisionRelayAddress, assetSymbol, assetDecimals, requireKycApproval }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create settlement integration");
      setEscrowContractAddress("");
      setDecisionRelayAddress("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(integration: SettlementIntegration) {
    setBusyId(integration.id);
    setError(null);
    try {
      const res = await fetch(`/api/settlement-integrations/${integration.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !integration.active }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to update settlement integration");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (forbidden) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">Only your organization's owner can manage settlement integrations.</p>
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
        <Link href="/settings/cutover-readiness" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Cutover readiness →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Integrations</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Settlement integrations</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Register an escrow contract cases can settle through. Each one is checked on-chain against
          its DecisionRelay before it's usable — an address that isn't actually wired to the relay
          you name is rejected at registration, not discovered later at settlement time.
        </p>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        <p className="kicker mb-4">Add an integration</p>
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="field-label">Chain</span>
            <select className="field-input" value={chain} onChange={(e) => handleChainChange(e.target.value)}>
              {CHAIN_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              const preset = ANCHOR_TESTNET_CONTRACTS[chain];
              if (!preset) return;
              setEscrowContractAddress(preset.escrowContractAddress);
              setDecisionRelayAddress(preset.decisionRelayAddress);
              setAssetSymbol(preset.assetSymbol);
              setAssetDecimals(preset.assetDecimals);
            }}
            className="self-start rounded-md border border-seal-500/40 px-3 py-1.5 text-xs font-medium text-seal-600 hover:bg-seal-50 dark:border-seal-400/40 dark:text-seal-400 dark:hover:bg-seal-500/10"
          >
            Use Anchor's testnet contracts for {CHAIN_OPTIONS.find((c) => c.value === chain)?.label}
          </button>
          <label className="flex flex-col gap-2">
            <span className="field-label">{chain === "solanatestnet" ? "Escrow program ID" : "Escrow contract address"}</span>
            <input
              className="field-input font-mono"
              placeholder={chain === "solanatestnet" ? "base58 program ID" : "0x…"}
              value={escrowContractAddress}
              onChange={(e) => setEscrowContractAddress(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="field-label">
              {chain === "solanatestnet" ? "decision-relay program ID" : "DecisionRelay address"} (to verify the escrow is bound to it)
            </span>
            <input
              className="field-input font-mono"
              placeholder={chain === "solanatestnet" ? "base58 program ID" : "0x…"}
              value={decisionRelayAddress}
              onChange={(e) => setDecisionRelayAddress(e.target.value)}
              required
            />
          </label>
          <div className="flex gap-4">
            <label className="flex flex-1 flex-col gap-2">
              <span className="field-label">Asset symbol</span>
              <input className="field-input" value={assetSymbol} onChange={(e) => setAssetSymbol(e.target.value)} required />
            </label>
            <label className="flex flex-1 flex-col gap-2">
              <span className="field-label">Asset decimals</span>
              <input
                className="field-input"
                type="number"
                min={0}
                max={36}
                value={assetDecimals}
                onChange={(e) => setAssetDecimals(Number(e.target.value))}
                required
              />
            </label>
          </div>
          <label className="flex items-center gap-2 font-mono text-xs">
            <input type="checkbox" checked={requireKycApproval} onChange={(e) => setRequireKycApproval(e.target.checked)} />
            Require both parties' KYC approval before any case using this integration can settle
          </label>
          <button className="btn-primary self-start" type="submit" disabled={creating}>
            {creating ? "Verifying on-chain…" : "Add integration"}
          </button>
        </form>
      </section>

      <section className="mt-12">
        <p className="kicker mb-4">Registered integrations</p>
        <div className="border-t border-line dark:border-line-dark">
          {integrations.length === 0 && (
            <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">No settlement integrations yet.</p>
          )}
          {integrations.map((i) => (
            <div key={i.id} className="border-b border-line py-4 dark:border-line-dark">
              <div className="flex items-center justify-between">
                <div>
                  <p className="break-all font-mono text-sm font-medium text-ink-950 dark:text-ink">{i.escrowContractAddress}</p>
                  <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
                    {i.chain} · {i.assetSymbol} ({i.assetDecimals}dp){i.requireKycApproval ? " · KYC required" : ""}
                  </p>
                </div>
                <div className="ml-4 flex shrink-0 items-center gap-3">
                  <span className={`font-mono text-xs ${i.active ? "text-seal-500 dark:text-seal-400" : "text-muted dark:text-muted-dark"}`}>
                    {i.active ? "active" : "inactive"}
                  </span>
                  <button
                    onClick={() => toggleActive(i)}
                    disabled={busyId === i.id}
                    className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
                  >
                    {busyId === i.id ? "…" : i.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
