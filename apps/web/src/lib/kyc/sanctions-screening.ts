// Documented future gate, NOT implemented. Track 3 scoped identity
// verification (a party proves who they are); sanctions/PEP/watchlist
// screening (checking a verified identity against OFAC/UN/EU lists) is
// a related but separate control this track does not build — there is
// no real screening provider account, real list data, or false-positive
// adjudication workflow behind this interface. Exists only so a future
// implementation has an agreed call shape to bind lib/kyc/kyc-gate.ts
// against, without a fake "always clear" implementation in the
// meantime that could be mistaken for a real control.

export interface SanctionsScreeningParams {
  partyVerificationId: string;
  fullName: string;
  dateOfBirth?: string;
  jurisdiction?: string;
}

export type SanctionsScreeningOutcome = "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";

export interface SanctionsScreeningResult {
  outcome: SanctionsScreeningOutcome;
  providerReference?: string;
  raw?: unknown;
}

export interface SanctionsScreeningProvider {
  readonly name: string;
  screenParty(params: SanctionsScreeningParams): Promise<SanctionsScreeningResult>;
}
