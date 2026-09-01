# Solana ISM migration: trusted-relayer → real multisig

Status: **design only — not implemented, not deployed.** Per the security
brief this responds to: "do NOT deploy a replacement until a complete
Testnet proof exists." Nothing in this document has been built yet.

## What this migration is and isn't

**Is**: replacing `decision-relay`'s inbound Hyperlane transport trust
model — currently `TRUSTED_ISM`, a deployed
`hyperlane-sealevel-composite-ism` instance configured as a bare
trusted-relayer check (`chains/solana/programs/decision-relay/src/lib.rs:66`,
same posture as `chains/evm/contracts/TrustedRelayerIsm.sol`) — with a real
Sealevel multisig ISM that requires threshold-many independent validator
checkpoint signatures before `process()` accepts a message, mirroring what
`StaticMerkleRootMultisigIsm` already does on the Sepolia side.

**Isn't**: a change to what a delivered message is allowed to do.
`handle()` is notification-only today (see its own doc comment) and this
migration doesn't touch that — a compromised or absent ISM check on the
Solana inbound side still cannot move a single lamport, because
`attested_settle` (2-of-2 Ed25519 attestation, checked independently in the
same transaction Anchor's backend itself builds) is the only path that
CPIs into escrow. This document is entirely about tightening *notification*
integrity, not fund safety. **This invariant must not regress during or
after the migration** — the Testnet proof checklist below has an explicit
step confirming it.

## Why this hasn't already been done

Solana's Hyperlane ecosystem multisig ISM (the Sealevel equivalent of
`StaticMerkleRootMultisigIsm`) is less mature/less used in production than
the EVM one — fewer reference deployments, thinner tooling, and the
composite-ISM primitive `TRUSTED_ISM` is built from
(`hyperlane-sealevel-composite-ism`) *can* express a real multisig
sub-module, but doing so correctly needs a from-scratch Testnet proof
rather than copying the EVM playbook, because account/PDA conventions,
checkpoint-storage indexing, and the relayer's Sealevel-specific
`process()` transaction construction are all different code paths from the
EVM relayer used for `DecisionRelay`.

## Migration plan

### 1. Target architecture

Replace the `TRUSTED_ISM` composite-ism instance's configuration with a
real multisig sub-module, keeping the composite-ism wrapper program itself
(it's a legitimate, general-purpose Hyperlane primitive — the trusted-relayer
posture is a *configuration* of it, not a defect in the program). Concretely:

- Deploy (or reuse, if already deployed by Hyperlane's own Sealevel
  contract suite on Testnet) a `hyperlane-sealevel-multisig-ism-message-id`
  program instance.
- Initialize it with the **same validator set and threshold** already
  running for the EVM side (`chains/hyperlane-validator/deployment.json`) —
  those validators sign checkpoints over Mailbox state generically, not
  per-destination-chain, so no new validator infrastructure is needed, only
  a new on-chain ISM configuration that trusts the existing checkpoints.
- Point `decision-relay`'s `InterchainSecurityModule` query handler
  (`lib.rs:327`) at this new ISM's pubkey instead of `TRUSTED_ISM`.
- Same validator-independence caveat as Phase 1's report applies here
  unchanged: this migration improves the *transport mechanism* (real
  signature-threshold checking vs. unconditional trust) but does not by
  itself create validator operator independence — that's tracked
  separately in `chains/hyperlane-validator/deployment.json`'s honest
  independence report.

### 2. Required Testnet proof before any deployment

Every item below must be demonstrated on Solana Testnet, with real
transaction signatures/checkpoint artifacts recorded, before the new ISM
is wired into the live `decision-relay` program:

1. **Validator checkpoint generation** — confirm the existing validators
   (already running for the EVM ISM) sign and publish checkpoints that
   cover Solana-destination messages too (Hyperlane checkpoints are
   Mailbox-global, not per-destination, but this must be verified against
   the actual running agent config, not assumed).
2. **Metadata construction** — build the multisig ISM's expected
   `metadata` bytes (validator signatures + checkpoint index/root) for a
   real dispatched message, using the same tooling/library Hyperlane's own
   Sealevel relayer uses, not a hand-rolled encoder.
3. **Relayer simulation** — run the self-hosted relayer's simulation step
   against the new ISM configuration and confirm it accepts the
   constructed metadata (catches account-list/format mismatches before
   spending a real `process()` transaction).
4. **`process()` transaction** — submit a real `process()` call on Solana
   Testnet through the new ISM and confirm it succeeds on-chain (record
   the transaction signature).
5. **Recipient notification event/log** — confirm `decision-relay`'s
   `handle()` still emits its existing notification log/state for the
   delivered message (proves the new ISM didn't change what a successful
   delivery hands to the recipient).
6. **Replay rejection** — resubmit the same message/metadata and confirm
   Hyperlane's own `Processed` PDA idempotency check rejects it (this is
   Hyperlane's own protection, separate from `decision-relay`'s own
   `ReplayGuard` on the recipient side — both must independently hold).
7. **Forged-origin rejection** — attempt delivery with metadata over a
   forged/wrong checkpoint (wrong root, insufficient signatures, or
   signatures from non-validator keys) and confirm `process()` rejects it
   — this is the actual security property the whole migration exists to
   add over `TRUSTED_ISM`'s unconditional accept.
8. **Notification-only invariant re-confirmed** — after 4-7 pass, confirm
   directly (read the deployed `decision-relay` program's `handle()`
   account list, e.g. via `handle_account_metas`) that it still requires no
   escrow-authority or settlement-capable account — i.e. the new ISM
   changed nothing about what a delivered message can do.

Only once all 8 have real, recorded evidence does this become a
"deploy-ready" change, per the brief's explicit instruction not to deploy
before a complete proof exists.

### 3. Notification-only invariant — explicit preservation statement

This migration changes **only** the answer to "was this message
legitimately signed by enough validators to be delivered." It does not
and must not change:
- `handle()`'s account list (still storage + escrow_program + ReplayGuard,
  no payer/signer, no escrow-authority — see `required_handle_account_metas`).
- The fact that `attested_settle` (Ed25519 2-of-2, backend-built
  transaction) is the only path that can CPI into `escrow::settle`.
- The `ReplayGuard`'s own bounded ring-buffer replay protection on the
  recipient side (this is a second, independent layer from Hyperlane's
  own `Processed` PDA — both should hold, neither depends on the other).

If a future change to `handle()` is ever proposed that adds an
escrow-authority-capable account to its list, that is a **fund-safety**
change requiring the same rigor as `attested_settle` itself (multisig
review, its own Testnet proof, explicit sign-off) — not something to bundle
into an "ISM upgrade."

### 4. Rollback plan

A broken ISM deployment (misconfigured validator set/threshold, or a
metadata-format mismatch discovered only after cutover) must not leave
`decision-relay` unable to receive any messages. Rollback:

1. **Keep `TRUSTED_ISM`'s deployed composite-ism instance untouched** —
   don't delete or reconfigure it as part of cutover; it stays available
   as a known-working fallback target.
2. Cutover is a **single value change**: `decision-relay`'s
   `InterchainSecurityModule` query handler response
   (`lib.rs:327`/`342`) is redeployed to point at the new ISM's pubkey.
   Rolling back is the same operation in reverse — redeploy pointing back
   at `TRUSTED_ISM`'s pubkey. Same program ID both times (matches the
   project's existing precedent: the ISM-query-`None`-encoding bugfix was
   shipped as same-program-ID redeploy, per `docs/hyperlane-integration.md`).
3. **Verify before flipping back**: confirm the new program build's
   `InterchainSecurityModule` handler returns the intended pubkey via
   direct on-chain simulation (`solana program show`, or a `call`-style
   dry run) before assuming rollback took effect — this project's own
   Phase 1 verification work found more than one case where an on-chain
   value silently didn't match what was intended to be deployed.
4. **Relayer whitelist / recipient config**: confirm the relayer's own
   Solana-destination configuration still points at `decision-relay`'s
   unchanged program ID and recipient PDA — rollback only changes which
   ISM pubkey the recipient reports, not the recipient's own address, so
   no relayer whitelist change should be needed for rollback specifically.
5. **If the new ISM is already receiving live traffic when a break is
   found**: any message dispatched during the broken window and not yet
   delivered will simply queue undelivered (same as any other undelivered-
   message SLA case Phase 1's `verify-deployment.ts` already
   alerts on) — rolling `decision-relay`'s ISM pointer back does not
   retroactively fix metadata already rejected; those specific messages
   need re-dispatch once the working ISM is back in place.

### 5. Pre-whitelist-update verification

Before updating the self-hosted relayer's configuration to route through
the new ISM in production:
- Confirm the new ISM program's deployed bytecode/config on Testnet
  matches what was actually proof-tested (not a different build) — compare
  program hash or a deterministic-build check, not just "the deploy script
  ran."
- Confirm `decision-relay`'s own `InterchainSecurityModule` handler change
  is deployed and independently verified to return the new ISM's pubkey
  (not assumed from source review — read it back on-chain).
- Only then update the relayer's recipient/ISM expectations, mirroring
  Phase 1's `checkRelayerWhitelist`/`checkDecisionRelayIsm` pattern (an
  equivalent Solana-side check should be added to a future version of
  `verify-deployment.ts` once this migration is live — not built yet since
  there's nothing on Solana to verify until this migration actually ships).

## Explicitly out of scope for this document

- Building the actual multisig ISM program/configuration code — this is a
  design document per the brief's phased instructions, not the
  implementation.
- Any change to `attested_settle` or the Ed25519 attestation path — those
  are unaffected and explicitly required to remain unchanged.
- Solana validator operator independence — tracked in
  `chains/hyperlane-validator/deployment.json`'s honest reporting, not
  duplicated here.
