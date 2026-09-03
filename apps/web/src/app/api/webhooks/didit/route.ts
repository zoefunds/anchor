import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyDiditWebhookSignature, DiditWebhookVerificationError } from "@/lib/didit";
import { logAction } from "@/lib/audit";

// POST /api/webhooks/didit — real-time KYC status updates from Didit.
// Subscribed to "status.updated" only (see the "Anchor production"
// destination in the Didit console) — see lib/didit.ts's own header
// comment for why signature verification is a hard requirement here,
// not optional: an unverified POST here would let anyone forge an
// "Approved" identity-verification result for any party.
//
// Reads the RAW body text and verifies BEFORE parsing/trusting
// anything in it — verifying a re-serialized/re-parsed body would not
// actually prove the bytes Didit sent are what's being trusted (Didit's
// own docs are explicit about this: "do NOT parse JSON before signature
// verification").

const DIDIT_STATUS_TO_PARTY_VERIFICATION_STATUS: Record<string, string> = {
  "Not Started": "NOT_STARTED",
  "In Progress": "IN_PROGRESS",
  "Awaiting User": "IN_PROGRESS",
  Resubmitted: "IN_PROGRESS",
  Approved: "APPROVED",
  Declined: "DECLINED",
  "In Review": "IN_REVIEW",
  Abandoned: "ABANDONED",
  Expired: "EXPIRED",
  "Kyc Expired": "EXPIRED",
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signatureV2 = req.headers.get("x-signature-v2");
  const timestamp = req.headers.get("x-timestamp");

  if (!signatureV2 || !timestamp) {
    return NextResponse.json({ error: "missing X-Signature-V2 or X-Timestamp header" }, { status: 400 });
  }

  try {
    verifyDiditWebhookSignature({ rawBody, signatureV2, timestamp });
  } catch (err) {
    if (err instanceof DiditWebhookVerificationError) {
      // eslint-disable-next-line no-console
      console.error("Didit webhook signature verification failed:", err.message);
      return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
    }
    throw err;
  }

  const payload = JSON.parse(rawBody) as {
    webhook_type?: string;
    session_id?: string;
    status?: string;
    vendor_data?: string;
    decision?: unknown;
  };

  if (payload.webhook_type !== "status.updated") {
    // Subscribed events is currently just status.updated, but a
    // config/UI change on Didit's side could add another event type to
    // this same destination without warning — ignore anything this
    // handler doesn't know how to process instead of crashing on it.
    return NextResponse.json({ ok: true, ignored: payload.webhook_type ?? "unknown" });
  }

  const mappedStatus = payload.status ? DIDIT_STATUS_TO_PARTY_VERIFICATION_STATUS[payload.status] : undefined;
  if (!mappedStatus) {
    // eslint-disable-next-line no-console
    console.error(`Didit webhook: unrecognized status "${payload.status}" for session ${payload.session_id}`);
    return NextResponse.json({ ok: true, warning: `unrecognized status: ${payload.status}` });
  }

  // vendor_data carries our own PartyVerification.id, set at session
  // creation (see api/public/cases/:id/verification/route.ts) — looking
  // up by our own primary key sidesteps any race between this webhook
  // arriving and the session-creation response finishing its own
  // sessionId update.
  if (!payload.vendor_data) {
    // eslint-disable-next-line no-console
    console.error(`Didit webhook for session ${payload.session_id} has no vendor_data — cannot correlate to a PartyVerification row`);
    return NextResponse.json({ ok: true, warning: "no vendor_data to correlate" });
  }

  const existing = await prisma.partyVerification.findUnique({ where: { id: payload.vendor_data } });
  if (!existing) {
    // eslint-disable-next-line no-console
    console.error(`Didit webhook vendor_data ${payload.vendor_data} does not match any PartyVerification row`);
    return NextResponse.json({ ok: true, warning: "unknown vendor_data" });
  }

  const kase = await prisma.case.findUnique({ where: { id: existing.caseId }, select: { organizationId: true } });

  await prisma.$transaction(async (tx) => {
    await tx.partyVerification.update({
      where: { id: existing.id },
      data: {
        sessionId: payload.session_id ?? existing.sessionId,
        status: mappedStatus as never,
        decision: (payload.decision ?? undefined) as never,
      },
    });
    if (kase) {
      await logAction(
        {
          organizationId: kase.organizationId,
          action: "party_verification.status_updated",
          targetType: "partyVerification",
          targetId: existing.id,
          metadata: { caseId: existing.caseId, role: existing.role, status: mappedStatus, sessionId: payload.session_id },
        },
        tx
      );
    }
  });

  return NextResponse.json({ ok: true });
}
