# Anchor

Adjudication-as-a-Service. Anchor decides what should happen when two parties
disagree about whether an obligation was fulfilled — starting with disputes
between AI agents transacting for data/API services.

Anchor does not move money and does not replace payment rails. It answers one
question, given evidence and an agreed policy: **what outcome should occur?**
GenLayer's Intelligent Contracts + Optimistic Democracy provide the
consensus-backed judgment primitive; everything else (case orchestration,
evidence handling, policy versioning, the API, the dashboard) is Anchor's own
infrastructure.

## MVP scope

One vertical, end to end: **agent-to-agent data/API task disputes.**

Agent A pays Agent B to perform a data task (fetch/aggregate/process data
against a stated spec). Agent B delivers. Agent A disputes that the delivery
met spec. Anchor collects the task spec, the delivery, and both agents'
statements into an evidence bundle, submits it to a GenLayer Intelligent
Contract under a versioned policy, and returns a structured, appealable
decision.

## Repo layout

```
apps/web/           Next.js app — API routes, case/evidence UI, Postgres via Prisma
genlayer/contracts/  Python Intelligent Contracts (GenVM)
genlayer/deploy/     TS deploy scripts for GenLayer Studio
genlayer/tests/      Direct-mode contract tests
packages/types/      Shared TypeScript types (Case, Evidence, Policy, Decision)
packages/genlayer-sdk/  Thin wrapper around GenLayer's JS SDK for Anchor's needs
packages/mcp-server/  MCP server exposing Anchor's API as tools for any MCP-compatible agent
chains/evm/          Hyperlane DecisionRelay/SolanaCaseReceiver contracts (Sepolia)
chains/solana/       Escrow + decision-relay Solana programs (Testnet/Devnet)
chains/hyperlane-relayer/  Self-hosted Hyperlane relayer config (see its README for why)
docs/                Policy specs, decision schema, architecture notes
```

## Trust boundary

```
YOUR INFRASTRUCTURE (apps/web, packages/*)
  Case lifecycle, evidence storage/hashing, policy versioning,
  privacy (party pseudonymization), API, dashboard

GENLAYER (genlayer/*)
  Intelligent Contract execution, AI validator evaluation,
  Optimistic Democracy consensus, appeals, finality

EXTERNAL (not in MVP)
  Payment rails / escrow that actually move funds on a decision
```

## Status

Scaffolding stage. See `docs/decision-schema.md` and `docs/policy-v1.md` for
the current case/evidence/decision contracts, and `genlayer/contracts/` for
the Intelligent Contract implementation.

## Local development

Prerequisites: Node 20+, Docker (for local Postgres + Redis), a GenLayer
Studio account/wallet (you're setting this up separately).

```bash
cd apps/web
cp .env.example .env       # fill in DATABASE_URL, REDIS_URL, GENLAYER_* vars
docker compose up -d       # starts local Postgres and Redis
npm install
npx prisma migrate dev
npm run dev
```

The adjudication job queue (BullMQ, backed by Redis) runs an in-process
worker inside `npm run dev`/`next start` by default — nothing extra to
start locally. For a standalone worker process instead (serverless web
deployments, or scaling job throughput independently), see `npm run
worker` in `apps/web` and `src/lib/queue.ts`'s header comment.

GenLayer contract development happens under `genlayer/` — see that
directory's own notes once the contract lands.
