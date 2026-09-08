# Mainnet readiness gate (Phase 6)

This document is the formal, evidence-based gate for the eleven items in
Phase 6's mandate. It does not replace `docs/mainnet-readiness-runbook.md`
— that file is the living operational tracker with exact current
addresses, dates, and section-by-section status; this file restates the
same gate as a set of falsifiable conditions, each one naming the concrete
mechanism that would produce the evidence, so "done" is never a matter of
opinion. Where the runbook and this file cover the same ground, this file
cites the runbook section rather than duplicating its narrative.

Every unchecked item below blocks mainnet. There is no partial credit —
this mirrors the runbook's own "Mainnet gate" section (its line 547).

## 1. Environment separation

**Condition**: every process that can sign or dispatch a settlement reads
its target chain/network from a single typed registry, and that registry
refuses to boot a live (non-testnet) environment with settlement unpaused.

**Evidence mechanism (real, exists now)**: `apps/web/src/lib/environment-registry.ts`
(added this phase) defines `AnchorEnvironment` with a `settlementPaused`
field, and `apps/web/src/lib/startup-checks.ts`'s `assertEnvironmentSafeToBoot`
throws `StartupCheckError` if a non-testnet environment's `settlementPaused`
is not strictly `true`. Proven by `apps/web/tests/unit/environment-registry.test.ts`,
which includes a revert-and-confirm test that mutates `ethereum-mainnet`'s
`settlementPaused` to `false` and asserts the throw, then reverts and
re-asserts the pass.

**Gap, stated honestly**: the registry is not yet wired into the actual
call sites that pick a chain today — `apps/web/src/lib/genlayer.ts`'s
`GENLAYER_NETWORK` env read, `apps/web/src/lib/hyperlane.ts`'s
`APPROVED_*` env reads, and `apps/web/src/lib/solana-settle.ts`'s
cluster-from-RPC-URL assumption all still operate independently of this
registry. Migrating each of those call sites to read from
`environment-registry.ts` instead of raw env vars is real, scoped,
non-trivial follow-up work — not done in this phase, which was
prepare-only.

## 2. Signer / Safe / validator independence

**Condition**: the 2-of-3 (EVM) / 2-of-3 (Solana) attestor set and the
Safe's owners are held by operators who do not share infrastructure,
cloud credentials, or a single point of compromise.

**Current reality (honestly stated)**: `docs/mainnet-readiness-runbook.md`
§2.1–2.3 already documents that today's testnet attestors and Safe owners
are effectively controlled by the same operator — this is the actual,
current, undisputed state, not a hypothetical risk. See
`docs/mainnet-custody-design.md` (this phase) for the target independent
design and what changes to get there.

**Evidence mechanism for "closed"**: three attestor operators, each running
their own signing service on separate cloud accounts/regions, each
independently verifiable via `apps/web/deployment-manifest.json`'s
`decisionRelay.attestors.active` list showing addresses that do not trace
to a shared key-generation event — the honest limitation already recorded
in that manifest's own `note` field about `isAttestor()` calls not being
an enumerable on-chain list.

## 3. External contract audit

**Condition**: the deployed bytecode (not just source) of the settlement
contracts (`DecisionRelay.sol`, the Solana escrow and decision-relay
programs) has been reviewed by a paid, named external auditor, with all
findings above low severity remediated and the remediation itself
re-verified.

**Evidence mechanism**: `docs/mainnet-readiness-runbook.md` §5 ("Priority
3 — external assurance") tracks this as not started, needing budget —
consistent with this phase's constraint against spending real money on an
audit. This item cannot be satisfied by documentation; it requires an
actual audit engagement, out of scope for any Claude session to perform
or fake evidence of.

## 4. 30-day reliability evidence

**Condition**: thirty consecutive days with zero unescalated
`MAX_RELAY_ATTEMPTS` exhaustions and zero unexplained canary SLA breaches.

**Evidence mechanism (real, exists now)**: the `CanaryRun` table
(`apps/web/prisma/migrations/20260908020000_add_canary_run/migration.sql`,
`apps/web/prisma/schema.prisma`) persists every canary execution's
outcome; `apps/web/src/app/api/ops-console/route.ts` surfaces this data,
and `MAX_RELAY_ATTEMPTS`-exhaustion escalation is implemented in
`apps/web/src/lib/adjudication-service.ts` / `apps/web/src/lib/signer-lifecycle.ts`.
A 30-day pass means: query `CanaryRun` for the trailing 30 days, confirm
zero rows with an unexplained SLA-breach status, and cross-reference the
ops console's escalation log for zero unescalated `MAX_RELAY_ATTEMPTS`
exhaustions in the same window. This is a real, exportable query against
real tables — not a manual attestation — but the 30-day clock itself
cannot be run by a documentation phase; it requires actual elapsed
production time. `docs/mainnet-readiness-runbook.md` §0 tracks the
observation window's current status.

## 5. Load and chaos testing

**Condition**: documented load test (sustained throughput at expected
peak dispute volume) and chaos test (RPC outage, validator lag, relayer
crash, Safe-owner unavailability) results, each with a defined pass
threshold, executed against a staging environment that mirrors production
topology.

**Evidence mechanism**: not built. `docs/mainnet-readiness-runbook.md` §4.2
records this honestly as "not built" today. The existing runbooks in
`docs/runbooks/` (`rpc-outage.md`, `validator-lag.md`, `relayer-failure.md`,
`signer-failure.md`, `worker-crash.md`) describe manual incident response
procedures for these failure modes but are not automated chaos
injections — a real distinction. This phase does not build the chaos
harness (that would be executable infrastructure, not documentation); it
is listed here as an open item with its exact current status.

## 6. Legal/custody decision

**Condition**: an explicit, counsel-reviewed decision on whether Anchor
operates as a non-custodial facilitator (does not hold keys to user
funds) or a custodial money transmitter, with the operating entity
structured accordingly.

**Evidence mechanism**: `docs/regulated-fintech-prerequisites.md` (this
phase) lays out the options and the reasoning; `docs/mainnet-readiness-runbook.md`
§6 tracks this as explicitly out of scope for engineering work alone. No
code change satisfies this item — it requires an actual legal decision by
the operating entity, which no engineering session can make.

## 7. Compliance policy

**Condition**: an active KYC/KYB/AML/sanctions-screening policy matching
the selected legal/custody model, with documented triggers and data
retention rules.

**Evidence mechanism**: `docs/regulated-fintech-prerequisites.md` outlines
the policy shape. Implementing actual screening (a real KYC/AML vendor
integration) is out of scope for this phase and would itself require the
item-6 legal decision first — sequencing matters here, not just
completeness.

## 8. Incident response

**Condition**: written incident runbooks for every settlement-affecting
failure mode, each drilled at least once (a real, timed rehearsal, not a
tabletop read-through).

**Evidence mechanism (real, exists now)**: `docs/runbooks/` already
contains nine runbooks (`failed-settlement.md`, `key-exposure-response.md`,
`relayer-failure.md`, `rpc-outage.md`, `safe-governance-config-change.md`,
`signer-failure.md`, `stuck-escrow.md`, `testnet-redeploy.md`,
`validator-lag.md`, `worker-crash.md`) from Phase 3. `docs/mainnet-readiness-runbook.md`
§4.1 tracks whether each has actually been drilled — written-but-undrilled
is explicitly called out there as insufficient for this gate.

## 9. Key rotation rehearsal

**Condition**: at least one full attestor/Safe-owner key rotation executed
end-to-end against testnet, following a written procedure, with the
procedure updated based on what the rehearsal actually revealed.

**Evidence mechanism**: `docs/mainnet-custody-design.md` (this phase)
writes the rotation/recovery procedure. `docs/mainnet-readiness-runbook.md`
§1.1 documents an actual key rotation that already happened on testnet
(rotating keys that touched an AI session's context) — real precedent
that a rotation has been executed before, though not yet the full
multi-attestor rehearsal this item requires for mainnet.

## 10. Funded loss/recovery policy

**Condition**: a defined, funded policy for what happens if a dispute
resolves incorrectly, a signer key is compromised, or funds are
misdirected — including who bears the loss, up to what amount, and the
concrete recovery mechanism.

**Evidence mechanism**: not yet written. This is flagged as an open gap:
neither this phase's docs nor prior phases define a funded loss policy.
It belongs in `docs/regulated-fintech-prerequisites.md`'s custody-model
section as a prerequisite of choosing custodial vs. non-custodial
operation, but a concrete funded number requires a business/legal decision
this phase cannot make on its own. Listed here explicitly rather than
silently omitted.

## 11. Dedicated RPC/provider failover

**Condition**: settlement-critical RPC calls (EVM and Solana) go through a
dedicated, SLA-backed provider with automatic failover to a second
independent provider, not a shared public endpoint.

**Evidence mechanism**: `docs/mainnet-readiness-runbook.md` §3 tracks
public RPC as "an accepted risk, not resolved reliability work" today —
`apps/web/tests/unit/reliability-monitor-rpc-provider-risk.test.ts`
already checks for this risk class in the reliability monitor, but
provisioning an actual dedicated/paid RPC provider is explicitly excluded
from this phase's scope (no spending real money on an RPC provider).

## Summary

Items 1 (partially — the registry exists, call-site migration doesn't),
4, 8, and 9 have real, already-existing or newly-added mechanisms in this
codebase producing genuine evidence. Items 2, 3, 5, 6, 7, 10, and 11
require real-world action (audits, legal decisions, paid infrastructure,
elapsed production time, actual independent operators) that no
documentation or code change in a single phase can satisfy — and this
document says so plainly rather than checking boxes that aren't earned.
