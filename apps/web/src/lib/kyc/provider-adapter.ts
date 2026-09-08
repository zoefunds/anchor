// Track 3 — the interface every KYC provider adapter implements
// (lib/kyc/didit-adapter.ts for the real provider, lib/kyc/test-provider-adapter.ts
// for testnet-only local dev), selected by lib/kyc/index.ts. Six
// normalized statuses regardless of a given provider's own vocabulary —
// see each adapter's own status-mapping table for how its provider's
// real values fold into these.

export type NormalizedKycStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "MANUAL_REVIEW";

export interface CreateVerificationSessionParams {
  /** Anchor's own PartyVerification.id — echoed back by the provider in webhooks/status lookups so a callback can be correlated without trusting anything else the provider sends. */
  partyVerificationId: string;
  /** Where the provider should redirect the party back to once their hosted flow completes. */
  callbackUrl: string;
  jurisdiction?: string;
}

export interface VerificationSession {
  providerSessionId: string;
  hostedUrl: string;
  providerReference?: string;
}

export interface VerificationStatusResult {
  status: NormalizedKycStatus;
  providerReference?: string;
  raw?: unknown;
}

export interface WebhookVerificationInput {
  rawBody: string;
  headers: Record<string, string | null | undefined>;
}

export interface NormalizedWebhookEvent {
  /** Used for replay dedup (KycWebhookDelivery.dedupeKey) — must be stable for a genuine redelivery of the same event and distinct across real events. */
  providerEventId: string;
  providerSessionId: string;
  status: NormalizedKycStatus;
  providerReference?: string;
  raw?: unknown;
}

export interface KycProviderAdapter {
  readonly name: string;
  createVerificationSession(params: CreateVerificationSessionParams): Promise<VerificationSession>;
  getVerificationStatus(providerSessionId: string): Promise<VerificationStatusResult>;
  /** Throws (never returns false) on a signature that doesn't verify — same discipline as lib/didit.ts's verifyDiditWebhookSignature and lib/webhooks.ts's inbound checks: a caller cannot accidentally ignore a boolean it forgot to test. */
  verifyWebhookSignature(input: WebhookVerificationInput): NormalizedWebhookEvent;
}

export class KycProviderMisconfiguredError extends Error {}
