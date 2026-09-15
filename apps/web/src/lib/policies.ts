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

export function getPolicy(policyId: string): PolicyDefinition | undefined {
  return POLICIES[policyId];
}

export const DEFAULT_POLICY_ID = "agent_data_task_v1";
