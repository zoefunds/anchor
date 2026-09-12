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
// Caps are per-currency, not USD: Anchor settles only native chain
// assets (real bug found and fixed 2026-09-12 — a USD-only cap made
// every real case, which is always ETH or SOL since USDC support was
// removed, permanently ineligible for automated signing). A missing cap
// for a currency must fail closed, not open, given what auto-signing
// this hash actually authorizes (this account's share of a real fund
// movement).
const AUTO_ATTESTOR_MAX_AMOUNT_ENV: Record<string, string> = {
  ETH: "AUTO_ATTESTOR_MAX_AMOUNT_ETH",
  SOL: "AUTO_ATTESTOR_MAX_AMOUNT_SOL",
};

function getMaxAutoSettleAmountNative(currency: string): number | null {
  const envVar = AUTO_ATTESTOR_MAX_AMOUNT_ENV[currency];
  if (!envVar) return null;
  const raw = process.env[envVar];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envVar} is set but not a positive number: "${raw}"`);
  }
  return parsed;
}

export interface AutoSignEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Whether the automated signer is allowed to sign this decision's
 * pending attestation hash — the amount-cap gate, on top of everything
 * dispatchDecisionForCase already enforced before this hash existed.
 *
 * A case bound to a PolicyVersion with autoSettlementCapNative set uses
 * THAT value (in the case's own settlement currency) instead of the
 * global per-currency env cap; a case with no bound policy (or a policy
 * that leaves autoSettlementCapNative null) falls back to the env-var
 * for its currency.
 */
export async function checkAutoSignEligibility(decisionId: string): Promise<AutoSignEligibility> {
  const decision = await prisma.decision.findUnique({
    where: { id: decisionId },
    select: {
      case: {
        select: {
          amount: true,
          currency: true,
          policyVersionRecord: { select: { autoSettlementCapNative: true } },
        },
      },
    },
  });
  if (!decision) {
    return { eligible: false, reason: "decision not found" };
  }

  const currency = decision.case.currency;
  if (!(currency in AUTO_ATTESTOR_MAX_AMOUNT_ENV)) {
    return { eligible: false, reason: `case currency ${currency} has no configured auto-settle cap env var — auto-signing is disabled by default, fail closed` };
  }

  const policyCap = decision.case.policyVersionRecord?.autoSettlementCapNative;
  const maxAmount = policyCap != null ? Number(policyCap) : getMaxAutoSettleAmountNative(currency);
  if (maxAmount === null) {
    return { eligible: false, reason: `no per-policy autoSettlementCapNative is bound and ${AUTO_ATTESTOR_MAX_AMOUNT_ENV[currency]} is not set — auto-signing is disabled by default, fail closed` };
  }

  const amount = Number(decision.case.amount);
  if (amount > maxAmount) {
    return { eligible: false, reason: `case amount ${amount} ${currency} exceeds the configured auto-settle cap (${maxAmount} ${currency}) — requires human review` };
  }

  return { eligible: true, reason: `case amount ${amount} ${currency} is within the ${maxAmount} ${currency} auto-settle cap` };
}
