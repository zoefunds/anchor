// Creates realistic marketplace-delivery-dispute sample cases for a new
// pilot org via the real HTTP API (not Prisma fixtures) so a design
// partner's dashboard has real, inspectable data after onboarding.
//
// Usage:
//   ANCHOR_API_BASE_URL=http://localhost:3000 \
//   ANCHOR_API_KEY=ak_live_... \
//   npx tsx apps/web/scripts/seed-pilot-sample-cases.ts

const BASE_URL = process.env.ANCHOR_API_BASE_URL;
const API_KEY = process.env.ANCHOR_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error("Set ANCHOR_API_BASE_URL and ANCHOR_API_KEY before running this script.");
  process.exit(1);
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  return res.json();
}

type SampleCase = {
  claim: string;
  amount: string;
  claimantRef: string;
  respondentRef: string;
  evidence: { type: string; content: string; submittedBy: "claimant" | "respondent" }[];
  appeal?: boolean;
};

const SAMPLE_CASES: SampleCase[] = [
  {
    claim: "Buyer reports package marked delivered but never received; seeking full refund.",
    amount: "84.50",
    claimantRef: "pilot-buyer-001",
    respondentRef: "pilot-seller-101",
    evidence: [
      { type: "text", content: "Carrier tracking shows 'delivered' at 14:02 but no package found at address; ring camera shows no delivery.", submittedBy: "claimant" },
      { type: "text", content: "Tracking number 9400111899223197428490 confirms delivery signature not required; carrier investigation opened.", submittedBy: "respondent" },
    ],
  },
  {
    claim: "Item received significantly not as described (wrong size/color); buyer wants partial refund.",
    amount: "42.00",
    claimantRef: "pilot-buyer-002",
    respondentRef: "pilot-seller-102",
    evidence: [
      { type: "text", content: "Photos show item is size M, listing and order confirmation both state size L.", submittedBy: "claimant" },
      { type: "text", content: "Listing photo and SKU description on file match size L; possible warehouse pick error, offering 50% partial refund.", submittedBy: "respondent" },
    ],
    appeal: true,
  },
  {
    claim: "Delivery delayed 3 weeks past estimated window; buyer requests shipping refund.",
    amount: "12.99",
    claimantRef: "pilot-buyer-003",
    respondentRef: "pilot-seller-101",
    evidence: [
      { type: "text", content: "Order placed with 5-7 day shipping estimate; item arrived 26 days later, no proactive delay notice.", submittedBy: "claimant" },
      { type: "text", content: "Carrier-side customs delay outside seller's control, confirmed by carrier status log.", submittedBy: "respondent" },
    ],
  },
];

async function main() {
  for (const sample of SAMPLE_CASES) {
    const created = await api("/api/cases", {
      method: "POST",
      body: JSON.stringify({
        claim: sample.claim,
        amount: sample.amount,
        claimantRef: sample.claimantRef,
        respondentRef: sample.respondentRef,
      }),
    });
    const caseId = created.id;
    console.log(`Created case ${caseId}: ${sample.claim.slice(0, 60)}...`);

    for (const ev of sample.evidence) {
      await api(`/api/cases/${caseId}/evidence`, {
        method: "POST",
        body: JSON.stringify(ev),
      });
    }
    console.log(`  -> submitted ${sample.evidence.length} evidence items`);

    if (sample.appeal) {
      try {
        await api(`/api/cases/${caseId}/appeal`, { method: "POST", body: JSON.stringify({ reason: "Sample appeal for pilot walkthrough." }) });
        console.log("  -> filed sample appeal");
      } catch (err) {
        console.log(`  -> appeal skipped (likely requires a prior decision): ${(err as Error).message}`);
      }
    }
  }
  console.log("Done. Open the dashboard to see these sample cases.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
