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
| `SOLANA_ATTESTOR_PRIVATE_KEY` | Backend's one half of the 2-of-2 Solana Ed25519 attestor threshold | `apps/web/.env`, read by `lib/solana-settle.ts` | Raw byte array echoed into this session's own tool output during an accidental shell-quoting bug |
| `SOLANA_RELAY_PRIVATE_KEY` | Signs/pays for Solana-side dispatch transactions | `apps/web/.env`, read by relay dispatch code | Same incident, same mechanism |
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
settlement. Rotating it changes which on-chain public key
`ATTESTOR_PUBKEYS` in `apps/web/src/lib/solana-settle.ts` must contain.

1. Generate a new Ed25519 keypair, offline if possible (never through
   any AI assistant).
2. **Do not deploy the new key alone** — until the escrow program's
   `ATTESTOR_PUBKEYS`/threshold logic is updated to recognize the new
   public key, replacing the secret without also updating the
   registered attestor set will simply break attestation entirely
   (both attestors would need to co-sign against a threshold that no
   longer matches). Check `chains/solana/programs/escrow` (or wherever
   the attestor set is actually enforced on-chain — confirm the exact
   file before touching anything) for how the attestor public key is
   registered, and whether updating it requires its own governance
   action.
3. Update the new public key wherever `ATTESTOR_PUBKEYS` is read from
   (both the on-chain program's expected set, if applicable, and
   `apps/web/.env`'s corresponding value).
4. Set the new private key directly via the deployment platform's own
   secret manager (Vercel env vars for `apps/web`) — never in chat,
   never in shell history (use the same `read -s` pattern established
   earlier this pass for Fly secrets).
5. Validate: run a real co-signing test (mirroring
   `tests/integration/solana-cosign.test.ts`'s pattern) against Testnet
   before considering this done.
6. Only after the new key is confirmed working, revoke/discard the old
   one — there's no "deactivate" step for a raw private key the way
   there is for an AWS access key; discarding it and never using it
   again is the equivalent.

### `SOLANA_RELAY_PRIVATE_KEY`

Lower consequence — this pays for and signs dispatch transactions, not
attestation, so it doesn't gate fund movement the way the attestor key
does. Still a real credential controlling a funded account.

1. Generate a new keypair.
2. Fund the new address with enough Testnet SOL for dispatch gas.
3. Set the new value via Vercel's secret manager.
4. Validate with a real (harmless) test dispatch, same pattern as this
   pass's own `tests/run-replayguard-delivery-proof.ts`.
5. Discard the old key once the new one is confirmed working.

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
