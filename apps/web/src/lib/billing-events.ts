import { Prisma, BillableEventType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Track 5, item 3: append-only billable-event metering, matching
// SignerLifecycleEvent's convention — inserted, never updated or
// deleted, anywhere in this codebase. This is the raw, auditable fact
// ledger a real invoicing system would eventually meter off of; it is
// deliberately NOT wired to lib/billing.ts's computeStubInvoice, which
// stays a stub deriving its preview numbers from live table counts (see
// usage.ts). Recording here must never throw into the caller's own
// request path — a metering failure is not a reason to fail a case
// creation, evidence upload, or settlement.
export { BillableEventType };

export interface RecordBillableEventInput {
  organizationId: string;
  eventType: BillableEventType;
  subjectId: string;
  quantity?: number;
  metadata?: Prisma.InputJsonValue;
}

export async function recordBillableEvent(input: RecordBillableEventInput): Promise<void> {
  try {
    await prisma.billableEvent.create({
      data: {
        organizationId: input.organizationId,
        eventType: input.eventType,
        subjectId: input.subjectId,
        quantity: input.quantity ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });
  } catch (err) {
    // Best-effort: metering must never break the caller's real request.
    console.error("recordBillableEvent failed", { eventType: input.eventType, subjectId: input.subjectId, err });
  }
}

/** Same as recordBillableEvent, but writes inside an existing transaction so the event and its subject row commit atomically. */
export async function recordBillableEventTx(
  tx: Prisma.TransactionClient,
  input: RecordBillableEventInput
): Promise<void> {
  await tx.billableEvent.create({
    data: {
      organizationId: input.organizationId,
      eventType: input.eventType,
      subjectId: input.subjectId,
      quantity: input.quantity ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
}
