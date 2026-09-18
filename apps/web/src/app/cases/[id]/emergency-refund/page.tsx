"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface PreparedRefund {
  chain: "sepolia" | "solanatestnet";
  decisionRelayAddress: string;
  settlementTargetAddress: string;
  // EVM only
  caseIdBytes32?: string;
  escrowIdBytes32?: string;
  proofHash?: string;
  hashToSign?: string;
  // Solana only — the raw bytes to sign directly (Ed25519 has no
  // separate hash-first step the way EVM's ecrecover scheme does).
  messageHex?: string;
  attestorThreshold: number;
  attestorCount: number;
  eligible: boolean;
  reason: string | null;
  readyAt: string | null;
}

// Priority 5, item 19 — admin-only emergency-refund REQUEST page.
// EVM: prepares and displays the real attestation payload; never signs,
// never broadcasts, never bypasses the Safe/M-of-N attestor requirement
// in any way — every real safety property is enforced by the
// DecisionRelay/Escrow contracts themselves, not by this page. This
// page's only job is turning "compute the right hash and coordinate
// signatures" from a manual, error-prone SSH+cast exercise into
// something that can't typo the hash.
//
// Solana is genuinely asymmetric, not just a different chain's version
// of the same flow: decision-relay's emergency_refund, like
// attested_settle, can only ever be submitted by Anchor's own backend
// (it needs held payer/attestor keys nobody outside Anchor's
// infrastructure has), so there is no "run this yourself" step for
// Solana — once eligible and a real external attestor signature is
// collected, this page submits directly via a dedicated backend route
// (still never bypassing the M-of-N requirement: submitting zero or
// invalid external attestations here fails exactly like it would for a
// real settlement).
export default function EmergencyRefundPage() {
  const params = useParams();
  const id = params.id as string;

  const [prepared, setPrepared] = useState<PreparedRefund | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sig1, setSig1] = useState("");
  const [sig2, setSig2] = useState("");
  const [solanaPubkey, setSolanaPubkey] = useState("");
  const [solanaSignature, setSolanaSignature] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  async function prepare() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${id}/emergency-refund/prepare`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to prepare emergency refund");
      setPrepared(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitSolanaRefund() {
    if (!solanaPubkey || !solanaSignature) return;
    setSubmitting(true);
    setError(null);
    setSubmitResult(null);
    try {
      const res = await fetch(`/api/cases/${id}/emergency-refund/submit-solana`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalAttestations: [{ publicKey: solanaPubkey, signature: solanaSignature }] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to submit emergency refund");
      setSubmitResult(body.signature);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const castCommand =
    prepared?.chain === "sepolia" && sig1 && sig2
      ? `cast send ${prepared.decisionRelayAddress} "emergencyRefund(address,bytes32,bytes32,bytes32,bytes[])" ${prepared.settlementTargetAddress} ${prepared.caseIdBytes32} ${prepared.escrowIdBytes32} ${prepared.proofHash} "[${sig1},${sig2}]" --rpc-url sepolia --private-key $PRIVATE_KEY`
      : null;

  const solanaSignCommand =
    prepared?.chain === "solanatestnet"
      ? `node -e 'const c=require("crypto");const seed=Buffer.from(JSON.parse(require("fs").readFileSync("keypair.json","utf8"))).subarray(0,32);const priv=c.createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});console.log("0x"+c.sign(null,Buffer.from(process.argv[1].slice(2),"hex"),priv).toString("hex"))' ${prepared.messageHex}`
      : null;

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <Link href={`/cases/${id}`} className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
        ← Case
      </Link>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-status-undetermined">Emergency refund</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Request an emergency refund</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          For a deposit that is genuinely stuck: no decision ever reached, or one was reached but
          delivery never completed. Only usable after a real on-chain timeout has elapsed since the
          deposit, and only with real threshold attestor signatures. This page cannot bypass either.
          Works for both Sepolia (Escrow.sol's emergencyRefund()) and Solana Devnet
          (escrow::emergency_refund via decision-relay). See docs/v1-v2-escrow-cutover.md.
        </p>
      </header>

      {!prepared && (
        <button className="btn-primary mt-8" onClick={prepare} disabled={loading}>
          {loading ? "Reading on-chain state…" : "Prepare refund request"}
        </button>
      )}

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      {prepared && (
        <section className="mt-10">
          <div className="dossier">
            <p className={`font-display text-xl font-semibold ${prepared.eligible ? "text-seal-500 dark:text-seal-400" : "text-status-undetermined"}`}>
              {prepared.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"}
            </p>
            <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
              {prepared.chain === "sepolia" ? "Sepolia" : "Solana Devnet"}
            </p>
            {prepared.reason && <p className="mt-2 text-sm text-muted dark:text-muted-dark">{prepared.reason}</p>}
            {prepared.readyAt && !prepared.eligible && (
              <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">ready at {new Date(prepared.readyAt).toLocaleString()}</p>
            )}

            {prepared.chain === "sepolia" ? (
              <>
                <div className="mt-6 border-t border-line pt-4 dark:border-line-dark">
                  <p className="field-label mb-1">Hash to sign</p>
                  <code className="block break-all font-mono text-xs">{prepared.hashToSign}</code>
                  <p className="mt-2 font-mono text-[11px] text-muted dark:text-muted-dark">
                    Requires {prepared.attestorThreshold} of {prepared.attestorCount} registered attestor signatures. Each
                    attestor signs this exact hash themselves. No private key is ever entered here:
                  </p>
                  <code className="mt-1 block break-all rounded bg-black/5 p-2 font-mono text-[11px] dark:bg-white/5">
                    cast wallet sign --no-hash {prepared.hashToSign} --private-key $ATTESTOR_PRIVATE_KEY
                  </code>
                </div>

                <div className="mt-6 flex flex-col gap-3 border-t border-line pt-4 dark:border-line-dark">
                  <label className="flex flex-col gap-2">
                    <span className="field-label">Attestor 1 signature</span>
                    <input className="field-input font-mono" value={sig1} onChange={(e) => setSig1(e.target.value)} placeholder="0x…" />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="field-label">Attestor 2 signature</span>
                    <input className="field-input font-mono" value={sig2} onChange={(e) => setSig2(e.target.value)} placeholder="0x…" />
                  </label>
                </div>

                {castCommand && (
                  <div className="mt-6 border-t border-line pt-4 dark:border-line-dark">
                    <p className="field-label mb-1">Ready to broadcast, run this yourself</p>
                    <p className="mb-2 text-xs text-muted dark:text-muted-dark">
                      This page never sees or handles a private key. Verify each signature first:{" "}
                      <code className="font-mono">cast wallet verify --address &lt;attestor&gt; --no-hash {prepared.hashToSign} &lt;signature&gt;</code>
                    </p>
                    <code className="block overflow-x-auto whitespace-pre rounded bg-black/5 p-2 font-mono text-[11px] dark:bg-white/5">{castCommand}</code>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="mt-6 border-t border-line pt-4 dark:border-line-dark">
                  <p className="field-label mb-1">Message to sign</p>
                  <code className="block break-all font-mono text-xs">{prepared.messageHex}</code>
                  <p className="mt-2 font-mono text-[11px] text-muted dark:text-muted-dark">
                    Requires {prepared.attestorThreshold} of {prepared.attestorCount} registered attestor signatures
                    total; this backend contributes one automatically, so exactly one real external
                    attestor signature below is enough to reach threshold. Ed25519 signs the raw
                    message directly, no separate hash step. No private key is ever entered here:
                  </p>
                  <code className="mt-1 block break-all rounded bg-black/5 p-2 font-mono text-[11px] dark:bg-white/5">
                    {solanaSignCommand}
                  </code>
                </div>

                <div className="mt-6 flex flex-col gap-3 border-t border-line pt-4 dark:border-line-dark">
                  <label className="flex flex-col gap-2">
                    <span className="field-label">External attestor public key (base58)</span>
                    <input className="field-input font-mono" value={solanaPubkey} onChange={(e) => setSolanaPubkey(e.target.value)} placeholder="…" />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="field-label">External attestor signature</span>
                    <input className="field-input font-mono" value={solanaSignature} onChange={(e) => setSolanaSignature(e.target.value)} placeholder="0x…" />
                  </label>
                </div>

                <div className="mt-6 border-t border-line pt-4 dark:border-line-dark">
                  <p className="text-xs text-muted dark:text-muted-dark">
                    Unlike Sepolia, this backend must submit the Solana transaction itself (it holds
                    the fee-paying key) — clicking below broadcasts for real once eligible, using the
                    signature you provide plus this backend's own attestor signature. It cannot
                    succeed without a genuinely valid, registered external signature.
                  </p>
                  <button
                    className="btn-primary mt-3"
                    onClick={submitSolanaRefund}
                    disabled={submitting || !prepared.eligible || !solanaPubkey || !solanaSignature}
                  >
                    {submitting ? "Submitting…" : "Submit refund"}
                  </button>
                  {submitResult && (
                    <p className="mt-3 break-all font-mono text-xs text-seal-500 dark:text-seal-400">
                      Submitted: {submitResult}
                    </p>
                  )}
                </div>
              </>
            )}

            <button className="btn-secondary mt-6" onClick={prepare} disabled={loading}>
              {loading ? "Re-checking…" : "Re-check eligibility"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
