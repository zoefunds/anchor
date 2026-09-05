# Signed live deployment manifest — 2026-09-05

**Environment: Sepolia testnet.** Everything in this manifest — contracts, validators, Safe, attestors — runs on Sepolia, not a mainnet. "Live" and "production" below describe the *deployment's* operational status (real infrastructure, real on-chain state, not a simulation), not readiness for real customer funds. Do not represent this environment as production in customer-facing material.

Produced in response to the re-audit's Phase 1, item 1. Every value below was read directly from the live Sepolia chain or the production database at the timestamp shown — nothing here is inferred from source code or prior documentation. `SETTLEMENT_PAUSED` remains `true` throughout; this manifest does not authorize lifting it.

**Captured**: 2026-09-05T00:00Z (approx.) via direct `eth_call`/`cast` against `https://ethereum-sepolia-rpc.publicnode.com`, and a live read of the production Postgres database (`anc-hor-worker`).

## DecisionRelay

| Field | Value |
|---|---|
| Address | `0xdddc52e9D20957Fb3Afe0dbee165857Cd6ADE968` |
| Deployed bytecode hash (keccak256 of `eth_getCode`) | `0x3c33046ad6918987d367bea5a8c883c57cea4d8833481e42336b0f06c1fd75a5` |
| `owner` | `0xc200534F7DEbF2816C085C5A156aBd686fA19f4C` (the Safe, below) |
| `mailbox` | `0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766` (Hyperlane's real Sepolia Mailbox) |
| `attestorThreshold` | 2 |
| `attestorCount` | 2 |
| `settlementMode(11155111)` | `1` (SETTLEMENT) |
| `settlementTarget(11155111)` | `0xE6d9Dac24458ea4f759472A3269275217e780ED6` (the active Escrow, below) |
| `trustedSender(11155111)` | `0x0000000000000000000000007401c129edfc26e68fe19309fe461eb3db1058eb` (padded `0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb`) |
| Deployed | 2026-09-04, this session (Phase 0 finding #1 remediation — the prior relay at `0x94f3FF552CC879a36B19b829af3325Ea72cbC71C` predated `SettlementMode`/`emergencyRefund` entirely and is now retired) |

## Escrow (active)

| Field | Value |
|---|---|
| Address | `0xE6d9Dac24458ea4f759472A3269275217e780ED6` |
| Deployed bytecode hash (keccak256 of `eth_getCode`) | `0x7a614c7b89e0d42797dc70904427e856aa89640cd98169ba45b6af81a7b0d6a4` |
| `decisionRelay` | `0xdddc52e9D20957Fb3Afe0dbee165857Cd6ADE968` (matches above) |
| `depositAuthorizer` | `0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb` |
| `emergencyRefundTimeoutSeconds` | 2,592,000 (30 days) |
| Code-identity status | Passes `lib/escrow-code-identity.ts`'s real byte-for-byte check against Anchor's own compiled `Escrow.sol` (immutables/metadata masked) — confirmed live this session |
| Deployed | 2026-09-04, this session (audit findings #2/#3 remediation — front-running fix + claimant-only deposit) |

## Superseded escrows (retired, inactive, zero unsettled funds — kept for audit trail only)

| Address | Version | Status |
|---|---|---|
| `0x5314725C32b58d0e1CACa510d491c8492D0BE997` | V1 | Inactive. 1 deposit ever, SETTLED. |
| `0x76f0eaABbe379A0fBd56516D76C0201272ab5Ad5` | V2 (pre-fix) | Inactive. 1 deposit ever, SETTLED. |
| `0xeee898e9dC575cd5d2938BCe99a749F85fc92b90` | V2 (pre-fix) | Inactive. 0 deposits ever. |

## Safe (governance owner)

| Field | Value |
|---|---|
| Address | `0xc200534F7DEbF2816C085C5A156aBd686fA19f4C` |
| Owners | `0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb`, `0xEDc300fb7Bd8437C90aF68393381514722FE128c` |
| Threshold | 2-of-2 |
| Nonce (as of capture) | 10 |
| **Independence note** | Both owner keys are held/controlled by the same operator as of this manifest — this is **not** independent dual control in the sense a production launch requires, only in the sense that two distinct signatures are cryptographically required per transaction. See re-audit item 2 (validator independence) — the same concern applies here. |

## ISM (Hyperlane multisig)

| Field | Value |
|---|---|
| Address | `0xf9Ceb195C295c496952649574A78B2Da6dD7b05f` |
| Type | `StaticMerkleRootMultisigIsm`, 2-of-2 |
| Validators | `0x2ffFd80d446835214EF87Eb3753B48935550f73f` (validator1), `0x0eD86FBF8cb56622BB3094FeCde2872018e0f4B3` (validator2) — per `docs/self-hosted-validator-setup.md` |
| **Independence note (re-audit item 1 — release blocker)** | Both validators run under one operator's Fly account, one AWS account, one S3 bucket. **This is explicitly not independent security actors.** No third validator exists. The prior 24-hour reliability observation **failed on checkpoint-currency grounds** and has not been re-run to a passing result since. |

## Attestors (EVM decision/emergency-refund signing)

| Address | Custody |
|---|---|
| `0x3261CEF8Ca14FCc9EF1Cd584209D7c3b7f578b70` | Backend-held (`ATTESTOR_PRIVATE_KEYS` on `anc-hor-worker`) |
| `0x229d46B4C22B5AA42fE7cDAae37cf611e726f732` | Held offline by the operator — backend never holds this key |

## Active settlement integrations (production database, live read)

| Integration ID | Chain | Escrow | Version | Active | Deposits | Unsettled |
|---|---|---|---|---|---|---|
| `cmtnddy2000028n3ak7hx6gf5` | sepolia | `0xE6d9Dac24458ea4f759472A3269275217e780ED6` | V2 | **yes** | 0 | 0 |
| `cmtlfw1f6000111gz42rvc3vo` | sepolia | `0x5314725C32b58d0e1CACa510d491c8492D0BE997` | V1 | no | 1 | 0 |
| `cmtn0uimm0002ycn6dpiiaq2r` | sepolia | `0x76f0eaABbe379A0fBd56516D76C0201272ab5Ad5` | V2 | no | 1 | 0 |
| `cmtn8p4et00026e5gziaqw18i` | sepolia | `0xeee898e9dC575cd5d2938BCe99a749F85fc92b90` | V2 | no | 0 | 0 |

**Total unsettled deposits across all integrations, live: 0.**

## Alert routing (configured, live on `anc-hor-worker`)

| Channel | Status |
|---|---|
| Slack (`OPS_ALERT_WEBHOOK_URL`) | Configured — full detail, private channel |
| ntfy.sh (`NTFY_TOPIC_URL`) | Configured — generic, non-identifying escalation content only (per this session's fix) |
| `OPS_ALERT_OWNER` | Configured |

## Settlement pause state

`SETTLEMENT_PAUSED = true`, confirmed via `flyctl secrets list -a anc-hor-worker` at capture time. This manifest is evidence for the re-audit's Phase 1 gate — it does **not** constitute or recommend an unpause. The re-audit's stated Phase 5 gate (independent validator quorum, a **passed** 30-day reliability window, external smart-contract review, a chosen and legally-vetted settlement model, active compliance controls, proven on-call/reconciliation) is **not met** as of this manifest.

## Signature

This manifest's own SHA-256 hash (of the file content above this section, at the time of signing) is `0x029419eb3d3f11e3557356f9aed30a0b523f73cfb94c73ca14bd8a9caeb6b387`.

Signed by `0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb` (verified by ECDSA recovery, not merely asserted):

```
0xe610d7c06d56f551093c9d6d2f59dd5c92c0b807ae592973acda80ebac0c5a4567628e8727c07bd205ff2abbd51c991521b7a77df55972320775ffca0a5f904d1c
```

Any party can independently verify this: compute `keccak256`/`sha256` of this file up to (not including) this Signature section, and `ecrecover` the signature above against that hash — it must recover to `0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb`.

## What this manifest deliberately does not claim

- It does not attest to reliability over time (that's the 30-day observation window, not yet re-run to a pass).
- It does not attest to Safe/attestor key independence (both explicitly flagged as single-operator above).
- It does not constitute an external security review of the deployed bytecode.
- It is a point-in-time, on-chain-verified snapshot — re-run before any decision that depends on it, since state can and does change (as this session repeatedly found).
