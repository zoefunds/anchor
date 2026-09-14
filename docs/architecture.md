# Architecture diagrams

This is the visual companion to the README's [Architecture: the full
decision-to-settlement pipeline](../README.md#architecture-the-full-decision-to-settlement-pipeline)
section. It holds the two truly whole-system diagrams (below). Every
other diagram lives directly in the doc it's actually about — each doc
owns its own diagram rather than everything being centralized here:

| Diagram | Lives in |
|---|---|
| Worker sweep architecture | [`README.md`](../README.md#repo-layout) (Repo layout) |
| Deployment topology (who runs what, where) | [`README.md`](../README.md#live-deployment--every-address-every-app) (Live deployment) |
| Trust boundary | [`README.md`](../README.md#trust-boundary) (Trust boundary) |
| Validator checkpoint → ISM → delivery flow | [`docs/hyperlane-integration.md`](hyperlane-integration.md) |
| Trust-layer independence map | [`docs/mainnet-readiness-runbook.md`](mainnet-readiness-runbook.md) §0 |
| Attestor co-signing (EVM) | [`docs/multisig-attestor-setup.md`](multisig-attestor-setup.md) |
| Alert escalation path | [`docs/ops-alert-escalation.md`](ops-alert-escalation.md) |
| Key rotation procedure | [`docs/key-rotation-checklist.md`](key-rotation-checklist.md) |
| V1 → V2 Escrow cutover (historical) | [`docs/v1-v2-escrow-cutover.md`](v1-v2-escrow-cutover.md) |

If a diagram and its doc's prose ever disagree, the prose and the live
on-chain/config state win — open an issue, don't just trust the picture.
All diagrams are Mermaid, rendered natively by GitHub — no image files
to keep in sync separately.

---

## 1. System components

What runs where, end to end. Boxes are real deployed services; arrows
are real traffic, not conceptual data flow.

```mermaid
flowchart TB
    subgraph Client["Client"]
        Party["Claimant / Respondent<br/>(browser, wallet)"]
    end

    subgraph Vercel["Vercel — apps/web (Next.js)"]
        API["API routes + dashboard<br/>cases, evidence, settlement-integrations,<br/>webhooks, audit-log, reliability"]
    end

    subgraph FlyWorker["Fly.io — anc-hor-worker"]
        Worker["BullMQ worker<br/>(apps/web/src/worker.ts)"]
        Sweeps["Scheduled sweeps — see README's<br/>Repo layout section for the full diagram"]
    end

    Postgres[("Postgres<br/>(Fly)")]
    Redis[("Redis<br/>(BullMQ queue/lock)")]

    subgraph GenLayer["GenLayer Studio Next (61997)"]
        Adjudicator["adjudicator.py<br/>Intelligent Contract<br/>Optimistic Democracy consensus"]
    end

    subgraph Sepolia["Sepolia (EVM)"]
        Mailbox["Hyperlane Mailbox<br/>(shared canonical, NOT Anchor-owned)"]
        MTH["MerkleTreeHook"]
        ISM["StaticMerkleRootMultisigIsm<br/>2-of-3"]
        VA["ValidatorAnnounce"]
        DecisionRelay["DecisionRelay"]
        Escrow["Escrow (V2)"]
        Safe["Safe 2-of-2<br/>(governance owner)"]
    end

    subgraph Validators["Hyperlane validators (independent operators)"]
        V1["validator1<br/>Fly · priscilla-george-personal"]
        V2["validator2<br/>AWS EC2 · account 069066994101"]
        V3["validator3<br/>AWS EC2 · account 269469928649"]
    end

    S3_1[("S3: validator1<br/>checkpoints")]
    S3_2[("S3: validator2-new<br/>checkpoints")]
    S3_3[("S3: validator3<br/>checkpoints")]

    Relayer["Self-hosted relayer<br/>(Fly anc-hor-relayer)"]

    subgraph SolanaChain["Solana Devnet (migrated from Testnet 2026-09-14 — see docs/incidents/2026-09-14-solana-devnet-migration.md)"]
        DecisionRelaySol["decision-relay program"]
        ReplayGuard["ReplayGuard PDA"]
        TrustedISM["TRUSTED_ISM<br/>(relayer-trust, NOT quorum-verified —<br/>see mainnet-readiness-runbook.md §0)"]
        EscrowSol["Escrow (Solana)"]
    end

    Alerts["Slack / ntfy<br/>ops alerts"]

    Party -->|"create case, submit evidence"| API
    API -->|"runAdjudicationJob()"| Adjudicator
    Adjudicator -->|"outcome + shares + reason codes"| API
    API --> Postgres
    Worker --> Postgres
    Worker <--> Redis
    Sweeps -.->|"runs inside"| Worker

    Worker -->|"dispatchSettlementForDecision()<br/>(blocked while SETTLEMENT_PAUSED=true)"| Mailbox
    Worker -->|"submitAttestedSettle()<br/>direct tx, not via Hyperlane"| DecisionRelaySol

    Mailbox --> MTH
    V1 -->|"sign checkpoints"| S3_1
    V2 -->|"sign checkpoints"| S3_2
    V3 -->|"sign checkpoints"| S3_3
    Relayer -->|"read 2-of-3 checkpoints"| S3_1
    Relayer --> S3_2
    Relayer --> S3_3
    Relayer -->|"build metadata, call process()"| Mailbox
    Mailbox -->|"verify via"| ISM
    ISM -->|"checks validator signatures against"| VA
    Mailbox -->|"deliver"| DecisionRelay
    DecisionRelay -->|"handle(): ISM + attestor check"| Escrow
    Safe -.->|"owns / governs"| DecisionRelay

    DecisionRelaySol -->|"verify (relayer-trust only)"| TrustedISM
    DecisionRelaySol -->|"notification-only handle()"| ReplayGuard
    DecisionRelaySol -.->|"attested_settle() CPI<br/>(the only path that moves funds)"| EscrowSol

    Sweeps -->|"critical findings"| Alerts
```

---

## 2. Case lifecycle: adjudication to settlement

Mirrors the README pipeline text as a real sequence diagram.

```mermaid
sequenceDiagram
    actor Party
    participant API as apps/web API
    participant GL as GenLayer adjudicator.py
    participant Worker as Fly worker (sweeps)
    participant Hyperlane as Mailbox → ISM → DecisionRelay
    participant Escrow

    Party->>API: Create case + submit evidence + select policy
    API->>GL: runAdjudicationJob() → adjudicate()
    GL-->>API: outcome, claimant/respondent shares, reason codes
    API->>API: computeDecisionHash() (binds outcome to case/policy/evidence)
    Note over API: Case enters APPEAL_WINDOW (48h)

    alt No appeal
        Worker->>Worker: finalizeExpiredAppealWindows() (every 5 min)
    else Appeal filed
        Party->>API: Appeal
        API->>GL: fresh adjudication round
        GL-->>API: possibly-revised outcome
        Worker->>Worker: finalize after this round
    end

    Worker->>Worker: dispatchSettlementForDecision()
    Note over Worker: refuses to proceed if SETTLEMENT_PAUSED=true (fail-closed)

    Worker->>Worker: sign attestation w/ ATTESTOR_PRIVATE_KEYS
    alt fewer than attestorThreshold signatures held
        Worker->>Worker: throws InsufficientAttestorSignaturesError
        Note over Worker: waits for external co-signer via<br/>/api/internal/pending-attestations
    end

    Worker->>Hyperlane: dispatch via Mailbox (EVM) or direct tx (Solana)
    Hyperlane->>Hyperlane: ISM verifies validator checkpoint quorum
    Hyperlane->>Hyperlane: DecisionRelay verifies attestor signatures
    Hyperlane->>Escrow: settle() — only if both checks pass
    Escrow-->>Party: funds released per adjudicated shares
```

---

## Keeping these current

Every diagram in this project references specific addresses, accounts,
or code paths. When any of the following changes, update the matching
diagram **in the same commit**, the same discipline this project applies
to `deployment.json` and `reliability-monitor.ts`'s `VALIDATORS`
constant:

- A validator is added, replaced, or moved to a different account/provider → this doc's §1, README's Live deployment + Trust boundary diagrams, `hyperlane-integration.md`, `mainnet-readiness-runbook.md`.
- The Safe owners, attestor set, or their independence status changes → `mainnet-readiness-runbook.md`'s independence map, README's Trust boundary diagram.
- `DecisionRelay`/`Escrow`/ISM is redeployed → this doc's §1, README's Live deployment diagram.
- The RPC provider changes (e.g. once a dedicated provider replaces the public endpoint from `mainnet-readiness-runbook.md` §3) → this doc's §1, README's Live deployment diagram, `mainnet-readiness-runbook.md`'s independence map.
- The settlement dispatch flow itself changes (new chain, new attestation scheme) → this doc's §2, `multisig-attestor-setup.md`.
- A worker sweep is added, removed, or its interval changes → README's Repo layout diagram.
- An alert severity or escalation rule changes → `ops-alert-escalation.md`.
- The escrow cutover/migration story changes → `v1-v2-escrow-cutover.md`.
