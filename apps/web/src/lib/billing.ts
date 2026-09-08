import { computeOrgUsage, OrgUsage } from "@/lib/usage";

// Phase 5, item B: billing STUB.
//
// THIS IS NOT REAL BILLING. There is no payment processor integration
// (no Stripe, no card on file, nothing), no money ever moves because of
// this file, and every invoice this produces is `status: "STUB_NOT_INVOICED"`
// — a constant, always the same value, never anything resembling "paid."
// It exists only to demonstrate the shape a real billing computation
// would have (line items derived from real usage counts), for a
// testnet-only product that has no live payment story at all. Do not
// wire this to anything that moves funds without a full re-design.
const STUB_LINE_ITEM_RATES_USD = {
  perCase: 2,
  perDecision: 1,
  perSettlement: 5,
} as const;

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPriceUsd: number;
  amountUsd: number;
}

export interface StubInvoice {
  organizationId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  lineItems: InvoiceLineItem[];
  totalUsd: number;
  status: "STUB_NOT_INVOICED";
  disclaimer: string;
}

export async function computeStubInvoice(organizationId: string, periodParam: string | null): Promise<StubInvoice> {
  const usage: OrgUsage = await computeOrgUsage(organizationId, periodParam);

  const lineItems: InvoiceLineItem[] = [
    {
      description: "Cases created",
      quantity: usage.cases,
      unitPriceUsd: STUB_LINE_ITEM_RATES_USD.perCase,
      amountUsd: usage.cases * STUB_LINE_ITEM_RATES_USD.perCase,
    },
    {
      description: "Decisions rendered",
      quantity: usage.decisions,
      unitPriceUsd: STUB_LINE_ITEM_RATES_USD.perDecision,
      amountUsd: usage.decisions * STUB_LINE_ITEM_RATES_USD.perDecision,
    },
    {
      description: "Settlements bound",
      quantity: usage.settlements,
      unitPriceUsd: STUB_LINE_ITEM_RATES_USD.perSettlement,
      amountUsd: usage.settlements * STUB_LINE_ITEM_RATES_USD.perSettlement,
    },
  ];

  return {
    organizationId,
    period: usage.period,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    lineItems,
    totalUsd: lineItems.reduce((sum, li) => sum + li.amountUsd, 0),
    status: "STUB_NOT_INVOICED",
    disclaimer:
      "STUB — no real payment processor is wired up. This is a computed preview only; nothing here has ever been charged, invoiced, or paid, and no code path in this repo can move money because of it.",
  };
}
