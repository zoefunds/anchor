import { NextRequest, NextResponse } from "next/server";
import { POLICIES } from "@/lib/policies";

// GET /.well-known/internet-court.json — the live Internet Court discovery
// manifest for Anchor's adjudication connector, matching the convention
// agent-to-agent discovery protocols use for a machine-readable capability
// card (e.g. A2A's /.well-known/agent.json). Deliberately public/
// unauthenticated: a directory or another agent needs to be able to decide
// whether Anchor is a fit *before* it has an API key, the same way you'd
// read a README before signing up for anything.
//
// The policy list is pulled live from lib/policies.ts (the same registry
// /api/policies serves to authenticated callers) rather than duplicated
// here by hand, so this manifest can't drift out of sync with what the
// API actually accepts. See docs/internet-court/anchor-adjudication/
// SKILL.md for the full connector documentation this manifest summarizes
// in machine-readable form.
export async function GET(req: NextRequest) {
  const baseUrl = process.env.APP_ORIGIN || req.nextUrl.origin;

  return NextResponse.json({
    connector: "anchor-adjudication",
    name: "Anchor",
    description:
      "Policy-driven Adjudication-as-a-Service, backed by GenLayer Intelligent Contracts with real independent-validator consensus — not a single LLM call rubber-stamping an outcome. Settles transaction disputes (release/refund/split funds) between two parties, not agent-permission/mandate decisions.",
    version: "1.0.0",
    documentation: "docs/internet-court/anchor-adjudication/SKILL.md in Anchor's own repo",
    policies: Object.values(POLICIES),
    decisionSchema: {
      caseId: "string",
      policyId: "string",
      policyVersion: "string",
      outcome: ["RELEASE_FULL", "RELEASE_PARTIAL", "REFUND_FULL", "REFUND_PARTIAL", "REQUEST_MORE_EVIDENCE", "UNDETERMINED"],
      claimantShareBps: "integer 0-10000 (never a float — GenVM calldata rejects native float)",
      respondentShareBps: "integer 0-10000, claimantShareBps + respondentShareBps == 10000",
      reasonCodes: "string[] — fixed vocabulary, see docs/policy-v1.md",
      consensus: ["ACCEPTED", "UNDETERMINED"],
    },
    settlement: {
      selfExecuting: false,
      note: "Anchor's decision does not move funds itself — the caller executes settlement (release escrow, trigger refund, etc.) using the decision output.",
      crossChainRelay: {
        mechanism: "hyperlane",
        proven: true,
        supportedDestinations: ["sepolia", "solanatestnet"],
        note: "Auto-dispatched the moment a case with settlementChain/settlementContract configured reaches an ACCEPTED decision — no manual trigger. Both directions (dispatch and delivery) are proven live on-chain, not just dispatch.",
      },
    },
    api: {
      baseUrl,
      auth: { type: "api_key", header: "Authorization: Bearer ak_live_..." },
      endpoints: {
        createCase: "POST /api/cases",
        getCase: "GET /api/cases/:id",
        submitEvidence: "POST /api/cases/:id/evidence",
        uploadEvidenceFile: "POST /api/cases/:id/evidence/upload",
        submitForAdjudication: "POST /api/cases/:id/adjudicate",
        appeal: "POST /api/cases/:id/appeal",
        listPolicies: "GET /api/policies",
        webhooks: "POST /api/webhooks",
      },
    },
  });
}
