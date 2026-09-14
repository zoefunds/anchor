# Solana Testnet outage → Devnet migration — 2026-09-14

## Status: RESOLVED. Full case-creation-to-settlement flow re-proven live on Devnet, end to end, with real funds moving.

## Background

Public Solana Testnet went unreachable across multiple independent RPC
providers for several days, with no ETA from the network. Before treating
this as an RPC-specific problem, it was checked against three explanations
support gave:

- **Rate limiting** — ruled out: requests failed identically from two
  separate providers/IPs, not just one.
- **Cluster resets** — the actual cause: two independent providers agreed
  on an identical, frozen slot number across multiple days of polling.
  A live cluster's slot always advances; an identical frozen slot from
  two unrelated providers means the cluster itself halted, not that any
  one RPC endpoint was degraded.
- **Congestion** — ruled out: congestion produces slow/dropped responses,
  not a permanently frozen slot number.

With a hackathon deadline and no ETA for Testnet's recovery, the decision
was to pivot the whole Solana settlement path to **Devnet**, which was
confirmed alive.

## What moved, and why it was safe

- `SOLANA_RPC_URL` → `https://api.devnet.solana.com` (set on the Fly
  worker, then later also on Vercel — see "Bugs found" below).
- The `solanatestnet` string used throughout the DB schema, `Case.settlementChain`,
  and Hyperlane domain config was **deliberately left unchanged** — it's
  a schema-level identifier, not a cluster name, and renaming it would
  have touched migrations for zero behavioral benefit.
- `decision-relay`'s `TESTNET_GENESIS_HASH` domain-separator constant
  (both in `apps/web/src/lib/solana-settle.ts` and the Rust program's
  `lib.rs`) was confirmed to be a fixed build-time tag baked into both
  sides — Solana programs cannot query their own cluster's genesis hash
  via syscall, so this was never a live runtime check and needed no
  change.
- The `escrow` program's on-chain address (`825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn`)
  is deterministic from the deploy authority keypair, and was already
  deployed to Devnet independently (confirmed via `chains/solana/Anchor.toml`'s
  `[programs.devnet]` entry) — no redeploy needed for escrow itself.
- The `decision-relay` program at the same address on Devnet was found to
  be a **stale build** (119376 bytes on-chain vs. 159376 bytes for the
  current Testnet build — missing `attested_settle` entirely). Fixed with
  `anchor build` + `solana program deploy ... --url https://api.devnet.solana.com`,
  verified via a raw `getAccountInfo` RPC call showing the new size
  (151221 bytes) matched the fresh local build.
- A fresh Address Lookup Table was created for Devnet
  (`ARa48N2LsaA3D9uZDRkauTCLy8szbox7yWwVyZb9W7Qy`) rather than reusing the
  Testnet one (`DRSsBj3qsZ3YG2EmAivLPp4vjtJu54FmeZRaWqobeFEs`, now retired)
  — an ALT is a cluster-specific account, not portable across clusters.

## Bugs found and fixed during the migration

All four were found by actually running the full flow live end-to-end on
Devnet with a self-controlled test case, not by inspection alone.

### 1. Devnet deposit page crashed on a Solana case

`/public/cases/[id]/deposit` was EVM/viem-only throughout (AppKit's EVM
adapter, viem's Sepolia chain, `getAddress()` checksum validation).
`getAddress()` on a base58 Solana pubkey throws synchronously — without a
guard, this crashed the whole page before any of its own render-time
checks ran. Fixed by gating every EVM-specific value on `chain === "sepolia"`,
initially with a "deposit manually via a CLI script" fallback for Solana,
later replaced entirely by a real wallet-connect UI (see below).

### 2. Fresh Devnet ALT was missing its static accounts

`submitAttestedSettle` (`apps/web/src/lib/solana-settle.ts`) automatically
extends the configured ALT with the *dynamic*, per-case accounts
(claimant, respondent, case PDA) the first time it sees them — but nothing
in the codebase ever populated the ALT with the *static* accounts every
settlement transaction also needs: the decision-relay program id, its
storage PDA, the escrow program id, the escrow_authority PDA, and the
`Sysvar1nstructions` sysvar. The Testnet ALT had these from whenever it
was originally set up by hand; the fresh Devnet ALT did not. Symptom:
`SendTransactionError: ... VersionedTransaction too large: 1696 bytes
(max: encoded/raw 1644/1232)` — the transaction fit for legacy (0-signer)
cases but overflowed the moment a real 2-of-2 attestation was attached.
Fixed with a one-off script extending the ALT with the five missing
static accounts.

### 2b. `SOLANA_DECISION_RELAY_LOOKUP_TABLE` was empty on Vercel

Separately from the ALT's own contents, Vercel's copy of this env var was
never set at all (only the Fly worker had it) — meaning any Solana
settlement dispatch that happened to run through a Vercel API route
(e.g. clicking "sync now" in the browser, which calls
`dispatchSettlementForDecision` inline) would hit the same "transaction
too large" failure regardless of the ALT's contents, because it would
silently fall back to a legacy (non-versioned) transaction. Fixed via
`vercel env rm` + `vercel env add` with the correct ALT address, then a
redeploy.

### 2c. `SOLANA_RPC_URL` was also empty on Vercel

Found while debugging bug #3 below: Vercel's `SOLANA_RPC_URL` was empty
too — used not just by reconciliation but by the actual settlement
dispatch path (`lib/deposit-execution.ts`, `lib/hyperlane.ts`). Any
Solana settlement dispatched via a Vercel API route, not just the Fly
worker's sweep, would have silently failed. Fixed the same way, then
redeployed.

### 3. `CaseSettlement.status` never advances past `DEPOSITED` for Solana

The most consequential bug: a real case (`cmu0xelfd000u6sh8rrl5kskz`,
on-chain case id `sol-devnet-test-3`) went through the entire flow
correctly — real GenLayer adjudication (`RELEASE_FULL`, consensus
accepted), real deposit, real 2-of-2 attestor signatures collected, real
`attested_settle()` transaction confirmed on-chain (verified directly:
`err: null`, and the respondent's wallet balance moved by the full
deposit amount) — but the case page kept showing "Deposited — awaiting
settlement" indefinitely.

Root cause: `checkDispatchedButStale` in `apps/web/src/lib/reconciliation.ts`
is the sweep responsible for self-healing exactly this drift (a
`Decision.relayTxHash` is set, meaning dispatch succeeded, but
`CaseSettlement.status` is still `DEPOSITED`) — its own doc comment says
"nothing in this codebase automatically advances CaseSettlement to
SETTLED after a successful dispatch; this sweep is what actually closes
that gap." But the sweep only ever implemented the Sepolia branch
(`kase.settlementChain !== "sepolia"` → skip), so every Solana case hit
this gap with no automatic correction at all, forever.

Fixed by adding `checkSolanaDispatchedButStale`, which reads the escrow
program's own `Case.status` account field on-chain (via a new
`fetchCaseStatus` helper added to `@anchor/solana-escrow-client`) — the
same "never trust the DB's own claim about itself" pattern the Sepolia
check already used — and flips `CaseSettlement.status` to `SETTLED` (with
`settledTxHash`/`settledAt`) once it observes `Settled` on-chain. Applied
manually to the one already-stuck case, then deployed so it self-heals
automatically going forward.

## New capability added during this pass: Solana wallet-connect deposit UI

Previously, a Solana claimant had no in-app way to deposit — the deposit
page showed the raw on-chain values and told them to use a CLI script
(`scripts/claimant-deposit-solana-devnet.ts`) or coordinate with the
organization. This is now a real, first-class UI:

- `apps/web/src/lib/wallet-solana.tsx` — `@solana/wallet-adapter-react`
  provider (Devnet, auto-detects any wallet-standard wallet — Phantom,
  Solflare, Backpack, etc. — no explicit adapter list needed)
- `apps/web/src/app/public/cases/[id]/deposit/SolanaDeposit.tsx` — builds
  the real `initializeCase` instruction via `@anchor/solana-escrow-client`'s
  typed `program.methods` builder and signs/sends it with the party's own
  connected wallet
- `GET /api/public/cases/:id` now also returns `decisionRelayProgramId`
  (a public on-chain fact, same justification as the existing
  `escrowContractAddress`/`escrowId` fields) so the client can derive the
  `escrow_authority` PDA that `initializeCase`'s `adjudicator` argument
  must be set to.

### Collateral dependency bug found while adding this

`@solana/wallet-adapter-react` transitively depends on
`@solana-mobile/wallet-adapter-mobile` (React Native's mobile
deep-linking wallet support) even though this app only needs
browser/extension wallet-standard support. That pulled `react-native`
into the dependency graph, which hoisted `react@19` and
`@noble/curves@2.x` to the workspace root — breaking the Next.js
production build (`Cannot read properties of undefined (reading
'ReactCurrentDispatcher')`, a classic React-version-mismatch crash) and
an existing EVM KMS-signer file that imports `@noble/curves/secp256k1`
without a `.js` extension (a v1-only import form; v2's `exports` map
requires the extension). Fixed via `overrides` in the root `package.json`
pinning `react`, `react-dom`, `@types/react`, `@types/react-dom` to
`^18.3.0` and `@noble/curves` to `^1.9.7` — confirmed with a clean
`rm -rf node_modules package-lock.json && npm install` and a successful
local production build before redeploying.

## Verification

One full case (`sol-devnet-test-3` / DB id `cmu0xelfd000u6sh8rrl5kskz`)
was run through the entire pipeline on Devnet using self-generated,
self-funded throwaway keypairs (so every step — including the deposit,
which the operator cannot sign on a real party's behalf — could be
verified directly, not just observed):

```
Case created → escrow bound → both party addresses set → 4 exhibits filed
  → real GenLayer adjudication (RELEASE_FULL, consensus ACCEPTED)
  → real on-chain deposit (0.01 SOL, self-signed)
  → appeal window closed → 2-of-2 attestor signatures collected
  → attested_settle() confirmed on-chain (err: null)
  → respondent balance verified to have received the full 0.01 SOL
  → CaseSettlement.status confirmed SETTLED after the reconciliation fix
```

Everything above was verified with direct on-chain RPC calls
(`getBalance`, `getTransaction`, `getAccountInfo`), not just the app's
own UI reporting success.
