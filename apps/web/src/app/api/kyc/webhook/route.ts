import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getKycProvider } from "@/lib/kyc";
import type { NormalizedKycStatus } from "@/lib/kyc/provider-adapter";
import type { PartyVerificationStatus } from "@prisma/client";
import { logAction } from "@/lib/audit";

// POST /api/kyc/webhook — the single inbound endpoint for whichever
// provider lib/kyc's KYC_PROVIDER selects. Order of operations here is
// the security-critical part (per this track's brief): verify the raw
// body's signature FIRST, reject a replay SECOND, and only THEN ever
// touch a PartyVerification's status — reversing any of those three
// steps reopens the exact hole lib/didit.ts's own webhook route was
// built to close (see that route's header comment).
//
// Never stores raw ID-document images or document numbers: the
// provider's own status/reference values (and, for the real Persona
// adapter, its documented inquiry-decision JSON) are all this route
// ever writes to `decision` — actual document images and PII stay
// hosted by the provider's own flow, never uploaded to or proxied
// through this app.

const NORMALIZED_TO_DB_STATUS: Record<NormalizedKycStatus, PartyVerificationStatus> = {
  NOT_STARTED: "NOT_STARTED",
  PENDING: "IN_PROGRESS",
  APPROVED: "APPROVED",
  REJECTED: "DECLINED",
  EXPIRED: "EXPIRED",
  MANUAL_REVIEW: "IN_REVIEW",
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headers: Record<string, string | null> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const adapter = getKycProvider();

  let event;
  try {
    event = adapter.verifyWebhookSignature({ rawBody, headers });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`KYC webhook (${adapter.name}) signature verification failed:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
  }

  // Replay defense: a (provider, providerEventId) pair is accepted at
  // most once, ever. The unique-constraint insert IS the dedup check —
  // doing a separate findFirst-then-create would race two concurrent
  // deliveries of the same replayed event past a naive check-then-act.
  try {
    await prisma.kycWebhookDelivery.create({
      data: { provider: adapter.name, dedupeKey: event.providerEventId },
    });
  } catch {
    // Unique-constraint violation == genuine replay (or a real
    // redelivery of an already-processed event, which must have the
    // same non-effect). Either way: acknowledge with 200 so the
    // provider doesn't keep retrying, but never re-transition anything.
    return NextResponse.json({ ok: true, deduped: true });
  }

  const existing = await prisma.partyVerification.findFirst({
    where: { sessionId: event.providerSessionId },
  });
  if (!existing) {
    // eslint-disable-next-line no-console
    console.error(`KYC webhook (${adapter.name}): no PartyVerification for session ${event.providerSessionId}`);
    return NextResponse.json({ ok: true, warning: "unknown session" });
  }

  const toStatus = NORMALIZED_TO_DB_STATUS[event.status];
  const kase = await prisma.case.findUnique({ where: { id: existing.caseId }, select: { organizationId: true } });

  await prisma.$transaction(async (tx) => {
    await tx.partyVerification.update({
      where: { id: existing.id },
      data: {
        status: toStatus,
        providerReference: event.providerReference ?? existing.providerReference,
        decision: (event.raw ?? undefined) as never,
      },
    });

    await tx.partyVerificationEvent.create({
      data: {
        partyVerificationId: existing.id,
        fromStatus: existing.status,
        toStatus,
        source: "webhook",
      },
    });

    if (kase) {
      await logAction(
        {
          organizationId: kase.organizationId,
          action: "party_verification.status_updated",
          targetType: "partyVerification",
          targetId: existing.id,
          metadata: { caseId: existing.caseId, role: existing.role, status: toStatus, provider: adapter.name },
        },
        tx
      );
    }
  });

  // Track 5, item 5 — deterministic human-escalation trigger: a real
  // KYC/sanctions decline from the actual provider adapter (Track 3),
  // not a fabricated confidence score. See docs/api/csv-export-schema.md
  // sibling comment in webhooks/didit/route.ts for the same trigger on
  // the legacy Didit-specific webhook path.
  if (toStatus === "DECLINED") {
    const { escalateForKycSanctions } = await import("@/lib/escalation");
    await escalateForKycSanctions(existing.caseId);
  }

  return NextResponse.json({ ok: true });
}
