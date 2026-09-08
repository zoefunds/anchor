# Mainnet custody design (Phase 6 — design only, not deployed)

This is a design document. Nothing here is deployed, funded, or
operational. It describes the target custody model for a future mainnet
deployment and contrasts it explicitly against today's testnet reality.

## Today's actual testnet reality (stated honestly)

Per `docs/mainnet-readiness-runbook.md` §2.1–2.3, today's 3 EVM attestors,
the 3 mirrored Solana attestors, and the 2 Safe owners are effectively
controlled by the same operator, running on shared infrastructure. This
is not a hidden risk — it is the documented, current state of a
live-testnet system, appropriate for testnet, and explicitly insufficient
for mainnet. `apps/web/deployment-manifest.json`'s `flags` array already
carries a live warning to this effect ("Safe is 2-of-2 with only 2
owners... operator independence... is UNVERIFIED").

## Target design: independent 2-of-3 attestors

Each of 3 attestors is operated by a genuinely separate party:

1. **Anchor operator** (the current team) — runs one attestor.
2. **An independent second operator** — a separate legal entity, on
   separate cloud infrastructure (different cloud provider, not just a
   different account on the same provider), with its own key generation
   ceremony. Candidate model: a smart-contract-audit firm or infrastructure
   partner willing to run a signing service under a service agreement, or
   a validator-as-a-service provider (e.g. the kind of entity that already
   runs Hyperliquid/Cosmos validator infrastructure for hire).
3. **A third independent operator** — separate again from both 1 and 2,
   ideally on a third cloud provider or self-hosted, to avoid correlated
   failure if one cloud provider has an outage or is compromised.

Each attestor generates its own key material locally (never transmitted
between operators), and only the resulting public key/address is shared
to be added to `DecisionRelay.sol`'s attestor set via the Safe-gated
`addAttestor()` governance path already implemented in that contract.
2-of-3 threshold is unchanged from today's design — the change is
independence of the 3, not the M-of-N math.

**Verification mechanism carried forward from Phase 1**: the existing
`assertWorkerKeyCountBelowThreshold` check in
`apps/web/src/lib/startup-checks.ts` already refuses to let any single
process hold >= threshold keys. That property is necessary but not
sufficient for independence — it prevents one *process* from holding
quorum, but says nothing about whether the 3 key-holding *operators* are
actually distinct organizations. Operator independence is a governance
and contractual fact, not something code can verify; it is tracked as a
manifest flag (per `deployment-manifest.json`'s existing pattern) that a
human operator asserts and periodically re-attests to.

## Target design: independent Safe owners

Mirror the attestor logic: at least 3 Safe owners (not 2, to allow one
owner's unavailability without blocking governance), each a genuinely
separate party, with a threshold of at least 2. Safe owner keys should be
hardware-backed (see HSM/MPC evaluation below) rather than hot env-var
keys — a real change from today's testnet design, where
`docs/multisig-attestor-setup.md` documents env-key signers as the
deliberate testnet choice.

## Signer SLAs

Independence alone does not make a 3-operator attestor set operationally
reliable — each operator must carry an explicit service-level commitment,
agreed contractually before their key is added via `addAttestor()`:

- **Signing availability**: minimum uptime for the signing service itself
  (target 99.9% monthly, consistent with the `PENDING_ATTESTATION`
  external-signature path in `docs/multisig-attestor-setup.md` already
  assuming an attestor can be temporarily unavailable without breaking
  quorum at 2-of-3).
- **Signing latency**: a maximum time-to-sign for a well-formed pending
  attestation request (e.g. 15 minutes for routine dispatch, faster for
  an explicitly flagged incident), so the reliability-monitor SLA work
  from Phase 2/3 isn't undermined by a slow third-party signer.
- **Incident notification**: an operator must notify Anchor within a
  defined window (e.g. 1 hour) of any suspected key compromise, planned
  maintenance affecting signing availability, or change of the
  infrastructure/personnel with access to the key material — this is
  what makes emergency rotation (below) actionable rather than
  theoretical.
- **Rotation cooperation**: a contractual commitment to cooperate with
  both routine and emergency rotation within the timelines in this
  document's rotation/recovery section, including generating a new key
  under the same independence constraints (own infrastructure, own
  ceremony) rather than reusing compromised material.

These SLA terms are what turn "three separate legal entities hold keys"
into an operationally trustworthy 2-of-3, and must be captured in the
actual service agreement with each of operators 2 and 3 above — not
left as an unstated assumption. To be unambiguous about the point this
whole document exists to make: **three keys sitting on the same Fly
account, the same cloud provider, or under the same operator's control
is not independence, regardless of how the threshold math is
configured** — independence is about who can act unilaterally and who
would need to collude, not the number of key files involved.

## HSM/MPC vendor evaluation

Comparative table based on each vendor's publicly documented capabilities
(not fabricated pricing — costs are described qualitatively where exact
figures require a sales conversation):

| Vendor | Custody model | Approx. cost model | Chain support | Audit trail |
|---|---|---|---|---|
| AWS KMS (with CloudHSM) | Single-cloud HSM, key never leaves AWS's HSM boundary | Pay-per-key + per-request, no direct EVM/Solana signing primitive — requires custom signing service wrapping raw ECDSA/Ed25519 ops | Generic ECDSA (secp256k1 via custom curve import) and Ed25519 — chain-specific tx construction is the caller's responsibility | CloudTrail logs every key operation; strong but AWS-account-scoped, not independently auditable by a counterparty without cross-account setup |
| GCP Cloud KMS / Cloud HSM | Single-cloud HSM, analogous to AWS | Similar pay-per-key model | Same generic-curve limitation as AWS; no native multi-chain tx support | Cloud Audit Logs, same single-cloud-account caveat as AWS |
| Fireblocks | MPC (no single key ever fully materializes) + policy engine, multi-party computation across Fireblocks' infrastructure and the customer | Enterprise SaaS pricing (quote-based), historically positioned for institutional volume, not casual/testnet use | Broad native chain support including EVM chains and Solana, purpose-built for this | Built-in transaction policy engine and audit log designed for compliance review, a real differentiator over raw HSM services |
| Turnkey | MPC + secure enclave (AWS Nitro Enclaves), API-first, positions itself for developer-run custody without a large enterprise sales cycle | Usage-based pricing, more accessible to a smaller team than Fireblocks | EVM and Solana both supported natively as of its public docs | Enclave attestation plus its own activity log; newer company, shorter audit track record than Fireblocks |
| Privy | Primarily an embedded-wallet/auth product with MPC key management under the hood, aimed at consumer-facing apps rather than institutional custody | Usage-based, consumer-app pricing tier | EVM broad, Solana supported | Audit log exists but the product's design center is end-user wallets, not institutional multi-party settlement custody — a fit caveat worth naming plainly |

**Recommendation for evaluation priority (not a final decision)**: Fireblocks
or Turnkey are the more directly applicable candidates for Anchor's
attestor/Safe-owner use case, since both are purpose-built for
multi-party institutional signing across the exact EVM+Solana pair Anchor
already operates on. AWS/GCP KMS are viable but would require building
and maintaining custom multi-chain signing logic on top of a generic HSM
primitive — real additional engineering scope not reflected in their
lower headline pricing. Privy's product shape is the weakest fit for this
specific use case (attestor/Safe-owner custody, not end-user wallets).
This table is a starting point for a real vendor evaluation involving
actual sales conversations and a security review of each vendor's SOC 2 /
audit reports — not a purchase decision.

## Signer rotation and recovery procedures

Written in the same style as `docs/runbooks/signer-failure.md` and
`docs/runbooks/key-exposure-response.md` from Phase 3.

### Routine rotation (planned, not emergency)

1. New operator/key is generated per the independence model above.
2. Safe-gated `addAttestor()` call adds the new attestor address to
   `DecisionRelay.sol`, requiring the existing 2-of-3 Safe signature
   threshold — this is a governance action, never automated.
3. Confirm the new attestor is signing correctly on testnet-equivalent
   canary traffic for a defined soak period (mirroring the 30-day
   reliability evidence bar in `docs/mainnet-readiness-gate.md` item 4,
   scaled down for a single-attestor swap rather than the whole system).
4. Safe-gated `removeAttestor()` retires the old attestor only after step
   3's soak period passes cleanly.
5. `apps/web/scripts/generate-deployment-manifest.ts` is re-run and the
   resulting manifest (and its `manifest-signature.ts` hash, per this
   phase's item-2 code) is committed in the same change as the rotation.

### Emergency rotation (key compromise suspected)

Follows `docs/runbooks/key-exposure-response.md`'s existing structure:
immediate `removeAttestor()` (or Safe owner swap) via the surviving
quorum, verify the compromised key cannot reach quorum alone (the
`assertWorkerKeyCountBelowThreshold` invariant in `startup-checks.ts`
already guarantees this for any properly-configured worker), then
rotation per the routine steps above, compressed and prioritized over the
soak period.

### Recovery (quorum loss)

If enough attestors or Safe owners become unreachable that quorum cannot
be met, this design has no code-level fallback by intent — that would
reintroduce a single point of unilateral control, defeating the reason
for M-of-N. Recovery is a governance/legal escalation (the funded
loss/recovery policy in `docs/mainnet-readiness-gate.md` item 10, and the
regulated-fintech prerequisites doc's custody section), not an
engineering fix.

## Automated vs. human-approval boundary

Consistent with this project's mandate from the start (Phases 1–5: routine
settlement dispatch is automated, backed by attestor signatures and
policy-engine checks), this design keeps that boundary in place for
mainnet rather than reversing it:

- **Stays automated**: routine settlement dispatch once quorum signatures
  exist, canary monitoring, reliability-monitor risk detection, retry/
  escalation logic (Phase 2), policy-engine risk gating (Phase 5) for
  case-level decisions within defined risk bounds.
- **Requires human/Safe approval**: adding or removing an attestor,
  changing the attestor threshold, adding or removing a Safe owner,
  changing the Safe threshold, approving a settlement-contract allowlist
  addition (`isApprovedForEnvironment` in
  `apps/web/src/lib/environment-registry.ts`), and unpausing any
  `settlementPaused: true` environment. None of these governance actions
  should ever be reachable by an automated process — they are exactly the
  actions `DecisionRelay.sol`'s existing Safe-owner gating already
  requires human multisig approval for today, and this design extends
  that same boundary to the environment-registry-level pause flag.
