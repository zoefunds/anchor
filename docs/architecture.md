# Architecture diagrams

This is the visual companion to the README's [Architecture: the full
decision-to-settlement pipeline](../README.md#architecture-the-full-decision-to-settlement-pipeline)
section — that section is the authoritative prose description; the
diagrams here are kept in sync with it and with
[`docs/mainnet-readiness-runbook.md`](mainnet-readiness-runbook.md)'s
live baseline. If a diagram and the prose ever disagree, the prose in
the linked doc and the live on-chain/config state win — open an issue,
don't just trust the picture.

All diagrams are Mermaid, rendered natively by GitHub and by Claude
artifacts — no image files to keep in sync separately.

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
        Sweeps["Scheduled sweeps:<br/>finalize-appeals · retry-settlements ·<br/>confirm-deposits · reconciliation ·<br/>reliability-observation · audit-anchor"]
    end

    Postgres[("Postgres<br/>(Fly)")]
    Redis[("Redis<br/>(BullMQ queue/lock)")]

    subgraph GenLayer["GenLayer StudioNet"]
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

    subgraph SolanaChain["Solana Testnet"]
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

## 3. Validator checkpoint → message delivery (EVM side)

What actually has to be true before a message can settle — the flow the
`checkpoint-currency` and `decisionrelay:ism` checks in
`reliability-monitor.ts`/`verify-deployment.ts` exist to verify.

```mermaid
flowchart LR
    Dispatch["A message is dispatched<br/>via Mailbox.dispatch()"] --> Tree["MerkleTreeHook<br/>appends leaf, count() += 1"]

    subgraph Signing["Each validator, independently"]
        direction TB
        V1["validator1"] -->|reads| Tree
        V2["validator2"] -->|reads| Tree
        V3["validator3"] -->|reads| Tree
        V1 -->|"signs checkpoint<br/>over tree root + index"| C1["checkpoint_N.json → S3"]
        V2 --> C2["checkpoint_N.json → S3"]
        V3 --> C3["checkpoint_N.json → S3"]
    end

    C1 & C2 & C3 --> Relayer["Self-hosted relayer<br/>picks any 2-of-3 checkpoints"]
    Relayer --> Metadata["Builds ISM metadata<br/>(signatures + root + index)"]
    Metadata --> Process["Mailbox.process()"]
    Process --> Verify{"ISM.verify()<br/>≥2 valid validator sigs<br/>over the claimed root?"}
    Verify -->|no| Reject["Reverts — message stays undelivered"]
    Verify -->|yes| Deliver["DecisionRelay.handle()"]
    Deliver --> Settle["Escrow.settle()<br/>(also requires attestor threshold)"]
```

---

## 4. Trust-layer independence — current state

Companion diagram to
[`mainnet-readiness-runbook.md`](mainnet-readiness-runbook.md)'s §0/§2 —
this is what "independence" actually looks like today, layer by layer.
**Green = verified independent. Yellow = partially independent. Red =
known not independent.** Update this diagram whenever the underlying
runbook section changes — it should never silently go stale like
`reliability-monitor.ts`'s hardcoded validator list did.

```mermaid
flowchart TB
    subgraph SafeLayer["Safe (2-of-2 governance) — 🔴 NOT independent"]
        S1["Owner 1<br/>0x7401...058Eb"]
        S2["Owner 2<br/>0xEDc3...128c"]
        SameOp1["Same operator/entity controls both"]
        S1 -.-> SameOp1
        S2 -.-> SameOp1
    end

    subgraph AttestorLayer["Attestors (2-of-2 dispatch signing) — 🔴 NOT verified independent"]
        A1["Attestor 1<br/>0x3261...8b70"]
        A2["Attestor 2<br/>0x229d...6f732"]
        Unverified["Distinct keys, but operator<br/>independence never checked"]
        A1 -.-> Unverified
        A2 -.-> Unverified
    end

    subgraph ValidatorLayer["Validators (2-of-3 ISM) — 🟡 partially independent"]
        VA1["validator1<br/>Fly · priscilla-george-personal"]
        VA2["validator2<br/>AWS 069066994101<br/>gideon820001"]
        VA3["validator3<br/>AWS 269469928649<br/>bard775"]
        GreenNote["Operator/account/IAM/bucket:<br/>🟢 real, verified distinct"]
        YellowNote["Cloud provider:<br/>🟡 VA2 + VA3 both AWS<br/>(different accounts)"]
        VA1 -.-> GreenNote
        VA2 -.-> GreenNote
        VA3 -.-> GreenNote
        VA2 -.-> YellowNote
        VA3 -.-> YellowNote
    end

    subgraph RPCLayer["RPC provider — 🔴 not production-grade"]
        RPC["ethereum-sepolia-rpc.publicnode.com<br/>free, no SLA, shared by ALL of the above"]
    end

    SafeLayer --> Overall
    AttestorLayer --> Overall
    ValidatorLayer --> Overall
    RPCLayer --> Overall
    Overall["Mainnet gate:<br/>ALL FOUR layers must be independently<br/>controlled + on dedicated infra<br/>— see runbook Mainnet gate checklist"]
```

---

## Keeping these current

Every diagram here references specific addresses, accounts, or code
paths. When any of the following changes, update the matching diagram
**in the same commit**, the same discipline this project applies to
`deployment.json` and `reliability-monitor.ts`'s `VALIDATORS` constant:

- A validator is added, replaced, or moved to a different account/provider → §1, §3, §4.
- The Safe owners, attestor set, or their independence status changes → §4.
- `DecisionRelay`/`Escrow`/ISM is redeployed → §1.
- The RPC provider changes (e.g. once a dedicated provider replaces the
  public endpoint from `mainnet-readiness-runbook.md` §3) → §1, §4.
- The settlement dispatch flow itself changes (new chain, new attestation
  scheme) → §2.
