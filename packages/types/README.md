# @anchor/types

Shared TypeScript types used by `apps/web` and other packages — the
single source of truth for the shape of a Case, Evidence, Decision, and
the two Hyperlane cross-chain message bodies. No runtime code, no
dependencies — pure type definitions, consumed via the npm workspace
symlink (`"@anchor/types"` in any workspace package's `package.json`).

## `index.ts` — core domain types

- `CaseStatus` — the case lifecycle's states (created, in adjudication,
  appeal window, finalized, etc. — see the type definition for the
  exact set, which must match `apps/web/prisma/schema.prisma`'s `Case.status`
  string values).
- `Outcome`, `ReasonCode` — the fixed vocabularies a GenLayer decision's
  `outcome`/`reasonCodes` are drawn from — see `../../docs/policy-v1.md`
  and `../../docs/decision-schema.md` for what each value means.
- `Party`, `Case`, `Evidence`, `Decision`, `AdjudicationRequest` — the
  core domain objects. `Decision` in particular mirrors
  `../../docs/decision-schema.md`'s full contract (outcome, shares,
  reason codes, hashes, relay/settlement fields) — keep the two in sync
  by hand; this file has no schema-generation step.

## `cross-chain.ts` — Hyperlane message shapes

- `ChainRef` — a tagged union distinguishing an EVM chain (by numeric
  chain id) from a Solana cluster (by string name), used wherever a
  type needs to be explicit about which chain family it's talking
  about.
- `DecisionRelayMessage` — the TypeScript shape of the message
  `packages/hyperlane-relay`'s `encodeDecisionRelayBody` actually
  encodes on-chain for `DecisionRelay.sol`'s `handle()` to decode — keep
  these in lockstep; a mismatch here is a type error, not a runtime
  bug, but only if both sides actually import from this file.
- `CaseOriginateMessage` — the reverse-direction message (a dispute
  raised on Solana, carried to Sepolia via `SolanaCaseReceiver.sol`).
- `HyperlaneMessage` — the union of both, for code that needs to handle
  either direction generically.
