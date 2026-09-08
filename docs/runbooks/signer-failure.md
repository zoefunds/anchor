# Runbook: signer / quorum failure

Covers the "signer unavailable" and "quorum unavailable" alerts, and the
`STALE_PENDING_SIGNATURE` reconciliation finding.

**Symptom:** A Decision has `pendingAttestationHash` (EVM) or
`pendingSolanaAttestationMessage` (Solana) set but no `relayTxHash` —
the backend's own key alone couldn't reach `attestorThreshold`, and
external attestors haven't (yet) supplied enough signatures. Visible on
`/settings/ops` under "Pending signatures" (age + collected/threshold),
and as a `STALE_PENDING_SIGNATURE` finding on
`/settings/reconciliation-findings` once it's been stuck for over
`RECONCILIATION_STALE_SIGNATURE_MS` (24h default).

A distinct, boot-time variant: `anc-hor-attestor2`/`anc-hor-attestor3`
(or the worker itself) refuses to start with a `StartupCheckError` from
`lib/startup-checks.ts` — this is "signer misconfigured", not just
"signer slow", and now fires a critical `sendOpsAlert` before exiting
(see `scripts/auto-attestor-sign.ts`/`auto-attestor-sign-solana.ts` and
`lib/worker.ts`'s `startAdjudicationWorker`).

## Diagnosis

1. **Boot-time failure:** read the exact `StartupCheckError` message —
   it names which invariant failed:
   - "not in the expected deployment manifest's active attestor set" —
     the configured `ATTESTOR_PRIVATE_KEY(S)` / `SOLANA_ATTESTOR_PRIVATE_KEY`
     doesn't match `apps/web/deployment-manifest.json` /
     `deployment-manifest.solana.json`. Either the key rotated without
     updating the manifest, or the manifest is stale — regenerate it:
     `npx tsx apps/web/scripts/generate-deployment-manifest.ts` and
     diff against committed.
   - "manifest has unresolved flags" — the committed manifest itself
     recorded a governance problem last time it was generated. Read
     `flags[]` in the JSON file directly.
   - "worker holds N attestor key(s), which is >= threshold" — a
     process was misconfigured to hold too many keys; split them
     across separate processes per `docs/multisig-attestor-setup.md`.
2. **Live stuck-signing (not boot):** check each attestor poller is
   actually running and polling:
   `fly logs -a anc-hor-attestor2 | grep auto-attestor` — look for
   `poll iteration failed` errors (network/RPC issues) vs. no log
   output at all (process down — see [worker-crash.md](worker-crash.md)
   for the general crash-diagnosis steps, same supervisor commands
   apply to attestor processes).
3. Compare `collected` vs `threshold` on `/settings/ops`: `0` collected
   past a full poll interval means no attestor has signed at all
   (likely all pollers down or misrouted `ANCHOR_API_BASE_URL`);
   `threshold - 1` collected means exactly one signer is unavailable.

## Resolution

- Poller down: restart it (same supervisor commands as
  [worker-crash.md](worker-crash.md), pointed at the attestor app).
- Wrong/rotated key: update the manifest via the generate script above,
  commit it, redeploy the poller with the correct key. Never edit
  `deployment-manifest.json` by hand — it exists specifically to be a
  live-verified read, not an assumption.
- A hard stuck case past its SLA with no dispatch: manually re-drive via
  `POST /api/internal/pending-attestations/[decisionId]/sign` (EVM) or
  `.../pending-solana-attestations/[decisionId]/sign` (Solana) if a
  known-good offline attestor key is available, following
  `docs/multisig-attestor-setup.md`'s co-signing procedure.

## Escalation

Two or more attestors down simultaneously is a quorum-loss event —
escalate immediately; do not attempt to add a new stopgap key without
going through `docs/multisig-attestor-setup.md`'s custody process, since
that's exactly the M-of-N separation this repo is designed to protect.
