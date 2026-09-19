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

// Real, concrete sample content for the "Fill sample" action on both the
// org-side exhibit form (case detail page) and the public party evidence
// form (CasePanel.tsx) — content a first-time user can submit as-is to
// see a genuine GenLayer verdict, not a "Lorem ipsum" placeholder that
// would just produce an UNDETERMINED/INSUFFICIENT_EVIDENCE result.
//
// Three scenarios, not one: a spec-only sample can only ever plausibly
// steer toward "respondent fully complied" (or, as happened once in
// testing, toward an unintended REFUND_FULL if the delivery reads as
// fabricated) — there was no way to see a claimant-favorable or a split
// outcome without hand-writing your own dispute. Each scenario below
// keeps the SAME agreed spec (task_spec/milestone_spec/invoice_terms
// never change — the agreement itself doesn't change) and only varies
// how well the delivery and each party's statement reflect meeting it,
// same as a real dispute would. None of this forces GenLayer's actual
// verdict — the model still judges the content on its merits — but each
// scenario is written to make one outcome the honest, obvious reading.
export type SampleScenarioId = "respondent_full_release" | "claimant_full_refund" | "split_partial";

export const SAMPLE_SCENARIOS: { id: SampleScenarioId; label: string; description: string }[] = [
  {
    id: "respondent_full_release",
    label: "Respondent: full release",
    description: "Delivery genuinely meets the agreed spec in full.",
  },
  {
    id: "claimant_full_refund",
    label: "Claimant: full refund",
    description: "Delivery is materially incomplete against the agreed spec.",
  },
  {
    id: "split_partial",
    label: "Split between both",
    description: "Delivery partially meets the agreed spec — some done, some not.",
  },
];

// Scenario-independent: the agreed spec itself, shared by all three
// scenarios above (only the delivery and statements vary per scenario).
const SAMPLE_SPEC_CONTENT: Record<string, string> = {
  task_spec:
    "Scrape the top 10 posts from Hacker News' front page (https://news.ycombinator.com) and " +
    "return a JSON array of exactly 10 objects, each with: title (non-empty string), url " +
    "(non-empty string), points (non-negative integer). Output must be valid JSON with no " +
    "extra commentary.",
  milestone_spec:
    "Milestone 2 of 3 (\"Payment integration\"): implement Stripe Checkout for the subscription " +
    "flow, covering monthly and annual plans, a working webhook handler that marks orders paid, " +
    "and a passing test suite for the checkout API routes. Due within 10 business days of " +
    "milestone start.",
  invoice_terms:
    "PO #4471: Vendor to deliver 200 units of SKU AX-100 at $42.50/unit, net-30 payment terms, " +
    "delivery to the buyer's Chicago warehouse by the 15th of the month. Invoice is due in full " +
    "only upon confirmed delivery of the full 200-unit quantity.",
};

const SAMPLE_SCENARIO_CONTENT: Record<SampleScenarioId, Record<string, string>> = {
  respondent_full_release: {
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
    deliverable:
      "PR #142 merged to main: Stripe Checkout session creation for both monthly/annual plans, " +
      "webhook handler at /api/webhooks/stripe verifying signatures and marking Order.status=PAID, " +
      "and 14 passing tests in tests/checkout.test.ts (CI run: green, 14/14). Delivered on day 8 of " +
      "the 10-day window.",
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
  },
  claimant_full_refund: {
    delivery_payload: JSON.stringify([
      { title: "Show HN: my new project", url: "https://news.ycombinator.com/item?id=41820001" },
      { title: "", url: "https://news.ycombinator.com/item?id=41820002", points: 88 },
      { title: "Random blog post", url: "", points: 12 },
      { title: "Some other thread" },
    ]),
    deliverable:
      "PR #142 was opened but never merged — CI is failing (3 of 14 tests error out), the webhook " +
      "handler at /api/webhooks/stripe returns a 500 on every test transaction, and annual-plan " +
      "checkout was never implemented. The milestone's 10-business-day deadline passed 6 days ago " +
      "with no working checkout flow in production.",
    delivery_record:
      "Warehouse receiving log #R-8830, dated the 21st: only 60 of the 200 units contracted under " +
      "PO #4471 arrived; the remaining 140 units were never shipped and the vendor has not provided " +
      "a revised delivery date. Delivery is 9 days past the invoice terms' deadline.",
    claimant_statement:
      "The delivery is materially incomplete and does not come close to meeting what we agreed to " +
      "pay for — most of what was promised was never delivered. Requesting a full refund.",
    respondent_statement:
      "We acknowledge the delivery fell well short of what was agreed and was significantly " +
      "delayed. We don't dispute the claimant's account.",
  },
  split_partial: {
    // Exactly 7 of the 10 spec-required items, each one individually
    // complete (title/url/points all present) - a clean, unambiguous 70%
    // completion rather than a mix of complete and malformed rows. The
    // old version left 3 rows in place but missing "points", which reads
    // as "data is broken" (SPEC_NOT_MET / DATA_MALFORMED) rather than
    // "70% delivered" to an adjudicator, and independent LLM runs split
    // on which framing applied - the real cause of this scenario
    // consistently landing UNDETERMINED (outcome-level disagreement, not
    // just a share-percentage mismatch).
    delivery_payload: JSON.stringify([
      { title: "Show HN: I built a tiny Postgres replacement in Rust for embedded use", url: "https://news.ycombinator.com/item?id=41823156", points: 412 },
      { title: "The Byzantine Generals Problem, twenty years later", url: "https://news.ycombinator.com/item?id=41822980", points: 287 },
      { title: "Why we moved off Kubernetes after three years", url: "https://news.ycombinator.com/item?id=41823301", points: 356 },
      { title: "Ask HN: How do you structure a monorepo at 50 engineers?", url: "https://news.ycombinator.com/item?id=41822844", points: 198 },
      { title: "A visual guide to TCP congestion control algorithms", url: "https://news.ycombinator.com/item?id=41823512", points: 267 },
      { title: "Show HN: Self-hosted alternative to Notion, written in Elixir", url: "https://news.ycombinator.com/item?id=41822711", points: 331 },
      { title: "The economics of running a solo SaaS in 2026", url: "https://news.ycombinator.com/item?id=41823088", points: 175 },
    ]),
    deliverable:
      "PR #142 merged: Stripe Checkout implemented and working for monthly plans; annual-plan " +
      "billing was descoped to a fast-follow PR after hitting a Stripe API limitation. Webhook " +
      "handler is live and tested. 9 of the 14 planned tests pass (5 are skipped, covering the " +
      "deferred annual-plan path). Delivered on day 9 of the 10-day window.",
    delivery_record:
      "Warehouse receiving log #R-8827, dated the 14th: 150 of the 200 units contracted under " +
      "PO #4471 arrived on schedule; the remaining 50 units are confirmed in transit with the " +
      "vendor's carrier, expected within 5 days.",
    // Deliberately domain-neutral (no "units"/"order"/"carrier") - this
    // pair is shared across all three policies (agent_data_task,
    // escrow_release, invoice_dispute), and wording tied to one policy's
    // domain contradicted the other two policies' spec/delivery fields
    // when this same text reached them, reading as inconsistent evidence
    // rather than a clean partial-completion case.
    claimant_statement:
      "Part of what was agreed arrived on time and in good condition, but a meaningful portion — " +
      "about 30% of what we're paying for — is still outstanding. Requesting payment reflect only " +
      "what was actually completed.",
    respondent_statement:
      "We delivered the large majority of what was agreed — around 70% — on schedule. The remaining " +
      "portion is a short, already-in-progress delay, not a failure to perform — requesting payment " +
      "reflecting substantial completion, with the balance to follow once the remainder is done.",
  },
};

export function getSampleEvidenceContent(scenario: SampleScenarioId, evidenceType: string): string | undefined {
  return SAMPLE_SPEC_CONTENT[evidenceType] ?? SAMPLE_SCENARIO_CONTENT[scenario][evidenceType];
}

// Sample text for the "Reason for appeal" field, keyed the same way as
// evidence content so a party appealing after an unfavorable verdict has
// something concrete to file, not just an empty optional box.
export const SAMPLE_APPEAL_REASON: Record<SampleScenarioId, string> = {
  respondent_full_release:
    "The verdict overlooked that the delivery met every requirement in the agreed spec. Requesting " +
    "a fresh review of the delivery record against the spec.",
  claimant_full_refund:
    "The verdict didn't fully account for how far the delivery fell short of the agreed spec. " +
    "Requesting a fresh review of the delivery record against the spec.",
  split_partial:
    "The verdict's split doesn't reflect the actual portion delivered versus outstanding. Requesting " +
    "a fresh review of the delivery record against the spec.",
};

export function getPolicy(policyId: string): PolicyDefinition | undefined {
  return POLICIES[policyId];
}

export const DEFAULT_POLICY_ID = "agent_data_task_v1";
