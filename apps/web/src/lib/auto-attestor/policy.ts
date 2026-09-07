import { prisma } from "@/lib/prisma";

// Policy gate for the automated (KMS-backed) attestor signers — see
// scripts/auto-attestor-sign.ts. By the time a Decision has
// pendingAttestationHash set, dispatchDecisionForCase has ALREADY passed
// KYC (assertKycRequirementMet), the settlement-target binding checks,
// and the deposit-match checks (see hyperlane.ts) — that's what put it
// in "waiting on more attestor signatures" state rather than failing
// outright. The one gate NOT already enforced anywhere is the amount
// cap below — everything above threshold still requires human review
// (i.e. this script simply does not sign it, and the case's existing
// operator-alerting/relayError surfacing takes over), never an
// automatic override.
//
// AUTO_ATTESTOR_MAX_AMOUNT_USD unset means "do not auto-sign anything" —
// a missing cap must fail closed, not open, given what auto-signing
// this hash actually authorizes (this account's share of a real fund
// movement).
function getMaxAutoSettleAmountUsd(): number | null {
  const raw = process.env.AUTO_ATTESTOR_MAX_AMOUNT_USD;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`AUTO_ATTESTOR_MAX_AMOUNT_USD is set but not a positive number: "${raw}"`);
  }
  return parsed;
}

export interface AutoSignEligibility {
  eligible: boolean;
  reason: string;
}

/** Whether the automated signer is allowed to sign this decision's pending attestation hash — the amount-cap gate, on top of everything dispatchDecisionForCase already enforced before this hash existed. */
export async function checkAutoSignEligibility(decisionId: string): Promise<AutoSignEligibility> {
  const maxUsd = getMaxAutoSettleAmountUsd();
  if (maxUsd === null) {
    return { eligible: false, reason: "AUTO_ATTESTOR_MAX_AMOUNT_USD is not set — auto-signing is disabled by default, fail closed" };
  }

  const decision = await prisma.decision.findUnique({
    where: { id: decisionId },
    select: { case: { select: { amount: true, currency: true } } },
  });
  if (!decision) {
    return { eligible: false, reason: "decision not found" };
  }
  if (decision.case.currency !== "USD") {
    // The cap is expressed in USD; refuse rather than silently comparing
    // a raw numeric amount in an unknown currency against a USD limit.
    return { eligible: false, reason: `case currency is ${decision.case.currency}, not USD — cannot compare against AUTO_ATTESTOR_MAX_AMOUNT_USD` };
  }

  const amountUsd = Number(decision.case.amount);
  if (amountUsd > maxUsd) {
    return { eligible: false, reason: `case amount $${amountUsd} exceeds AUTO_ATTESTOR_MAX_AMOUNT_USD ($${maxUsd}) — requires human review` };
  }

  return { eligible: true, reason: `case amount $${amountUsd} is within the $${maxUsd} auto-settle cap` };
}
