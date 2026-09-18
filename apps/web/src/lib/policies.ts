// Anchor's policy library — must stay in exact sync with the POLICIES
// registry in genlayer/contracts/adjudicator.py (policy_id, version,
// required evidence types). The contract is the source of truth for the
// actual adjudication logic (prompt, reason codes); this file only needs
// enough to validate requests and drive the UI before a case ever reaches
// GenLayer.

export interface RequiredEvidence {
  type: string;
  label: string;
  /**
   * Who is allowed to file this exhibit. Undefined means the filing
   * organization only (the case documentation it already holds — task
   * specs, delivery payloads, invoice terms, etc). "claimant"/"respondent"
   * restrict it to that party's own authenticated submission (their side
   * of the story) — neither the org nor the other party can file it.
   */
  restrictedTo?: "claimant" | "respondent";
}

export interface PolicyDefinition {
  id: string;
  version: string;
  label: string;
  description: string;
  requiredEvidence: RequiredEvidence[];
}

export const POLICIES: Record<string, PolicyDefinition> = {
  agent_data_task_v1: {
    id: "agent_data_task_v1",
    version: "1.0.0",
    label: "Agent data/API task delivery",
    description: "Agent A paid Agent B for a data/API task; A disputes the delivery didn't meet spec.",
    requiredEvidence: [
      { type: "task_spec", label: "Task spec" },
      { type: "delivery_payload", label: "Delivery payload" },
      { type: "claimant_statement", label: "Claimant statement", restrictedTo: "claimant" },
      { type: "respondent_statement", label: "Respondent statement", restrictedTo: "respondent" },
    ],
  },
  escrow_release_v1: {
    id: "escrow_release_v1",
    version: "1.0.0",
    label: "Escrow / milestone release",
    description: "Client disputes whether a service provider's deliverable meets an agreed milestone.",
    requiredEvidence: [
      { type: "milestone_spec", label: "Milestone spec" },
      { type: "deliverable", label: "Deliverable" },
      { type: "claimant_statement", label: "Claimant statement", restrictedTo: "claimant" },
      { type: "respondent_statement", label: "Respondent statement", restrictedTo: "respondent" },
    ],
  },
  invoice_dispute_v1: {
    id: "invoice_dispute_v1",
    version: "1.0.0",
    label: "B2B invoice dispute",
    description: "Buyer disputes an invoice against agreed contract/PO terms; seller defends it.",
    requiredEvidence: [
      { type: "invoice_terms", label: "Invoice terms" },
      { type: "delivery_record", label: "Delivery record" },
      { type: "claimant_statement", label: "Claimant statement", restrictedTo: "claimant" },
      { type: "respondent_statement", label: "Respondent statement", restrictedTo: "respondent" },
    ],
  },
};

// Realistic sample content per evidence type, for the "Fill sample"
// action on both the org-side exhibit form (case detail page) and the
// public party evidence form (CasePanel.tsx) — real, concrete dispute
// content a first-time user can submit as-is to see a genuine GenLayer
// verdict, not a "Lorem ipsum" placeholder that would just produce an
// UNDETERMINED/INSUFFICIENT_EVIDENCE result. Keyed by evidence type, not
// by policy, since claimant_statement/respondent_statement are shared
// across all three policies above. Each policy's pair (spec + delivery)
// is written to plausibly resolve as a clean, fully-met delivery — the
// point of a sample is a fast, legible first adjudication, not a demo of
// ambiguous edge cases.
export const SAMPLE_EVIDENCE_CONTENT: Record<string, string> = {
  task_spec:
    "Scrape the top 10 posts from Hacker News' front page (https://news.ycombinator.com) and " +
    "return a JSON array of exactly 10 objects, each with: title (non-empty string), url " +
    "(non-empty string), points (non-negative integer). Output must be valid JSON with no " +
    "extra commentary.",
  delivery_payload: JSON.stringify([
    { title: "Show HN: I built a tiny Postgres replacement in Rust for embedded use", url: "https://news.ycombinator.com/item?id=41823156", points: 412 },
    { title: "The Byzantine Generals Problem, twenty years later", url: "https://news.ycombinator.com/item?id=41822980", points: 287 },
    { title: "Why we moved off Kubernetes after three years", url: "https://news.ycombinator.com/item?id=41823301", points: 356 },
    { title: "Ask HN: How do you structure a monorepo at 50 engineers?", url: "https://news.ycombinator.com/item?id=41822844", points: 198 },
    { title: "A visual guide to TCP congestion control algorithms", url: "https://news.ycombinator.com/item?id=41823512", points: 267 },
    { title: "Show HN: Self-hosted alternative to Notion, written in Elixir", url: "https://news.ycombinator.com/item?id=41822711", points: 331 },
    { title: "The economics of running a solo SaaS in 2026", url: "https://news.ycombinator.com/item?id=41823088", points: 175 },
    { title: "Reverse engineering a 1980s calculator's floating point unit", url: "https://news.ycombinator.com/item?id=41822955", points: 224 },
    { title: "Why static site generators are having a resurgence", url: "https://news.ycombinator.com/item?id=41823420", points: 143 },
    { title: "Ask HN: Best resources for learning distributed systems from scratch?", url: "https://news.ycombinator.com/item?id=41822677", points: 259 },
  ]),
  milestone_spec:
    "Milestone 2 of 3 (\"Payment integration\"): implement Stripe Checkout for the subscription " +
    "flow, covering monthly and annual plans, a working webhook handler that marks orders paid, " +
    "and a passing test suite for the checkout API routes. Due within 10 business days of " +
    "milestone start.",
  deliverable:
    "PR #142 merged to main: Stripe Checkout session creation for both monthly/annual plans, " +
    "webhook handler at /api/webhooks/stripe verifying signatures and marking Order.status=PAID, " +
    "and 14 passing tests in tests/checkout.test.ts (CI run: green, 14/14). Delivered on day 8 of " +
    "the 10-day window.",
  invoice_terms:
    "PO #4471: Vendor to deliver 200 units of SKU AX-100 at $42.50/unit, net-30 payment terms, " +
    "delivery to the buyer's Chicago warehouse by the 15th of the month. Invoice is due in full " +
    "only upon confirmed delivery of the full 200-unit quantity.",
  delivery_record:
    "Warehouse receiving log #R-8823, dated the 12th: 200 units of SKU AX-100 received and " +
    "counted against PO #4471, no shortages or damage noted, signed off by receiving staff. " +
    "Delivery occurred 3 days ahead of the invoice terms' deadline.",
  claimant_statement:
    "The file arrived on time and looks complete, but I haven't independently verified the " +
    "contents myself — flagging for adjudication out of caution before releasing payment, not " +
    "because I've found a specific defect.",
  respondent_statement:
    "Delivery matches the agreed spec exactly — every requirement listed was met on time. " +
    "Requesting release of payment.",
};

export function getPolicy(policyId: string): PolicyDefinition | undefined {
  return POLICIES[policyId];
}

export const DEFAULT_POLICY_ID = "agent_data_task_v1";
