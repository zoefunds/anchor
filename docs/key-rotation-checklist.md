# Key rotation checklist — exposed credentials from this hardening pass

Status: **checklist only — not executed.** This document exists so the
human custodian can perform each rotation deliberately, not so an
agent can. No secret value appears anywhere in this document, only
role names and where each one lives — per this project's own standing
rule, credential handling is never delegated to an assistant.

## What's exposed and why each needs rotation

A credential pasted into a chat transcript — even one later removed
from the visible conversation — must be treated as permanently
compromised. It may persist in transcript storage, terminal scrollback,
shell history, clipboard managers, or logging systems outside this
project's control. "No evidence of misuse" is not the same as "not
compromised" — rotation is the only real remediation, not monitoring.

| Credential | Role | Where it's used | Exposure |
|---|---|---|---|
| `SOLANA_ATTESTOR_PRIVATE_KEY` | Backend's one half of the 2-of-2 Solana Ed25519 attestor threshold | Fly app `anc-hor-worker` — the **only** process that ever dispatches a real cross-chain settlement (see [DEPLOYMENT.md](../DEPLOYMENT.md)'s app table); *not* Vercel/`apps/web` | Raw byte array echoed into this session's own tool output during an accidental shell-quoting bug |
| `SOLANA_RELAY_PRIVATE_KEY` | Signs/pays for Solana-side dispatch transactions | Fly app `anc-hor-worker`, same as above | Same incident, same mechanism |
| Sepolia RPC key (Infura) | `anc-hor-validator1`'s dedicated endpoint | Fly secret `HYPERLANE_SEPOLIA_RPC_URL` on that app | Pasted directly into chat by the operator |
| Sepolia RPC key (Alchemy, validator2) | `anc-hor-validator2`'s dedicated endpoint | Fly secret `HYPERLANE_SEPOLIA_RPC_URL` on that app | Pasted directly into chat by the operator |
| Sepolia RPC key (Alchemy, relayer) | `anc-hor-relayer`'s dedicated endpoint | Fly secret `HYPERLANE_SEPOLIA_RPC_URL` on that app | Pasted directly into chat by the operator |

**Already remediated**: two old, no-longer-used AWS access keys
(originally exposed/rotated earlier this pass) — confirmed deleted by
the operator directly in IAM.

**Explicit standing decision, not an oversight**: the operator was
offered rotation for every item above at the time each exposure
happened and declined for the Solana keys and RPC keys specifically.
That decision is recorded in `docs/production-readiness-hardening-pass.md`
(the sixth, tenth addenda) as a deliberate, accepted residual risk —
this checklist exists so that decision can be revisited on its own
schedule, not because it was missed.

## Rotation procedure, per credential

### `SOLANA_ATTESTOR_PRIVATE_KEY`

This is the more consequential of the two Solana keys — it's one half
of the 2-of-2 attestation threshold that authorizes real Solana
settlement. **This is not a simple secret swap.** The allowlist it
must match, `ATTESTOR_PUBKEYS`, is a compile-time constant array
inside the `decision-relay` Solana program itself
(`chains/solana/programs/decision-relay/src/lib.rs`) — not read from
any `.env` file, and not enforced by the escrow program. Replacing the
private key without a corresponding `decision-relay` program upgrade
that recognizes the new public key does not rotate anything; it simply
breaks attestation, because the on-chain program will keep checking
signatures against the *old* compiled-in key and reject every
co-signature from the new one.

**Do not treat "set the new key on Fly" as sufficient at any point in
this procedure** — every step below is required, in order, not just
step 4.

1. Generate a new Ed25519 keypair, offline if possible (never through
   any AI assistant).
2. Before touching any live secret, check for and safely resolve any
   **in-flight cosignatures** against the old key — an attestation
   already partially co-signed (one of the 2-of-2 signatures gathered,
   the other still pending) must either complete under the old key or
   be explicitly abandoned before the cutover; a rotation that lands
   mid-flight can strand a settlement in a state where neither the old
   nor the new key can complete it. Confirm with whoever operates
   `anc-hor-worker` that no settlement is currently awaiting
   co-signature before proceeding.
3. Build and test a `decision-relay` program upgrade that replaces the
   old public key in `ATTESTOR_PUBKEYS` with the new one — this goes
   through the same real build/test/deploy path as any other program
   change (`cargo test -p decision-relay`, then
   `cargo-build-sbf -- -p decision-relay`; see
   `chains/solana/REPLAYGUARD_DEPLOYMENT.md` for the verified-working
   build command and its known-benign `hyperlane_core` stack-offset
   warning). Confirm via `solana program show` that whoever runs the
   upgrade actually holds the program's real upgrade authority
   (`EBea3UVndSrNdgdtfuXC6PoN7573GdS43XDoB6pja9fh` as of this pass —
   verify it hasn't changed) before attempting the deploy.
4. **Validate on Testnet before touching the private key anywhere
   real**: run a full attested-settlement test against the upgraded
   program — a real 2-of-2 co-signed settlement on an isolated,
   no-customer-funds test case, confirming the new public key is
   actually accepted by the upgraded on-chain allowlist. Do not
   proceed to step 5 without this passing.
5. Only once the program upgrade is live and validated, set the new
   private key on `anc-hor-worker` directly via
   `flyctl secrets set -a anc-hor-worker SOLANA_ATTESTOR_PRIVATE_KEY=...`
   — never in chat, never in shell history (use the same `read -s`
   pattern established earlier this pass for RPC secrets). Vercel
   holds no Solana signing key and is not part of this rotation.
6. Re-validate: run one more real co-signed settlement end-to-end
   against Testnet with the new key live in `anc-hor-worker`, before
   considering the new key authoritative.
7. Only after that validation passes, discard the old private key —
   there's no "deactivate" step for a raw private key the way there is
   for an AWS access key; discarding it and never using it again is
   the equivalent. The old public key is now also cryptographically
   dead — it's no longer in the upgraded program's `ATTESTOR_PUBKEYS`,
   so even an unrevoked old private key can no longer produce a valid
   co-signature.

### `SOLANA_RELAY_PRIVATE_KEY`

Lower consequence — this pays for and signs dispatch transactions, not
attestation, so it doesn't gate fund movement the way the attestor key
does. Still a real credential controlling a funded account.

1. Generate a new keypair.
2. Fund the new address with enough Testnet SOL for dispatch gas.
3. Set the new value directly on `anc-hor-worker` via
   `flyctl secrets set -a anc-hor-worker SOLANA_RELAY_PRIVATE_KEY=...`
   — this key is not read from Vercel/`apps/web`; see the app table in
   [DEPLOYMENT.md](../DEPLOYMENT.md).
4. Validate with a real (harmless) test dispatch, same pattern as this
   pass's own `tests/run-replayguard-delivery-proof.ts`.
5. Discard the old key once the new one is confirmed working. Unlike
   the attestor key, this one isn't checked against any on-chain
   allowlist — it just needs to be the account that actually pays for
   and signs the dispatch transaction, so no program upgrade is
   required for this one.

### The three RPC endpoint keys

Lowest consequence of the five — an RPC API key typically only grants
read/broadcast access to a blockchain node, not control over funds or
signing authority. Still worth rotating since a leaked key can be used
to exhaust your request quota or, depending on the provider's plan,
incur cost.

1. In each provider's dashboard (Infura for validator1, Alchemy for
   validator2 and the relayer), generate a new API key/endpoint.
2. Set it via `flyctl secrets set HYPERLANE_SEPOLIA_RPC_URL=<new-url>
   -a <app>` for each of the three apps — see
   `chains/hyperlane-validator/RPC_MIGRATION.md` for the exact,
   already-established command pattern (including the `read -s`
   non-echoed input flow).
3. Confirm via `flyctl logs -a <app> --no-tail | grep '\[rpc\]'` that
   each app picked up the new endpoint (host only ever logged, per this
   project's own startup-validation design).
4. Delete/deactivate the old key in the provider's dashboard once the
   new one is confirmed working.

## After all five are rotated

Update `docs/production-readiness-hardening-pass.md` to record that the
standing residual-risk items for these credentials are closed, with
real evidence (which apps/services confirmed working post-rotation) —
following this project's own established pattern of not marking
something resolved without the evidence to back it up.
