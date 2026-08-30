// Hyperlane message schemas. See docs/hyperlane-integration.md for the
// full architecture and open questions — these types are the wire contract
// once that's resolved, kept here so apps/web's relay dispatcher and the
// EVM/Solana contracts can share one definition.

export type ChainRef = `evm:${number}` | `solana:${string}`;

export interface DecisionRelayMessage {
  message_type: "DECISION_RELAY";
  case_id: string;
  policy_id: string;
  policy_version: string;
  outcome: string; // Outcome from index.ts
  // Integer basis points (0-10000), not floats — see decision-schema.md /
  // Decision.claimantShareBps in index.ts for why.
  claimant_share_bps: number;
  respondent_share_bps: number;
  reason_codes: string[];
  proof_hash: string;
  execution: {
    target_chain: ChainRef;
    target_contract: string;
    action: "settle";
    params: {
      escrow_id: string;
      claimant_amount_atto: string;
      respondent_amount_atto: string;
    };
  };
}

export interface CaseOriginateMessage {
  message_type: "CASE_ORIGINATE";
  origin_chain: ChainRef;
  origin_ref: string;
  claim: string;
  amount_atto: string;
  claimant_ref: string;
  respondent_ref: string;
  policy_id: string;
  policy_version: string;
  evidence_refs: string[];
}

export type HyperlaneMessage = DecisionRelayMessage | CaseOriginateMessage;
