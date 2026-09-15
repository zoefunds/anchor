import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { castReviewApproval, addReviewNote, openManualReview, EscalationError } from "@/lib/escalation";
import { logAction } from "@/lib/audit";

// GET /api/cases/:id/review — the review record (if any), its
// approvals, and its append-only reviewer notes. Org-scoped, same auth
// as the rest of the case API — a reviewer must be a member of the case's
// own organization.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({ where: { id: (await params).id } });
  if (!kase || kase.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const review = await prisma.caseReview.findUnique({
    where: { caseId: (await params).id },
    include: { approvals: { orderBy: { createdAt: "asc" } }, notes: { orderBy: { createdAt: "asc" } } },
  });
  return NextResponse.json(review);
}

// POST /api/cases/:id/review — either open a manual review
// ({ action: "open", requiresDualApproval? }), cast a vote
// ({ action: "vote", decision: "APPROVE"|"REJECT", reason? }), or append
// an immutable reviewer note ({ action: "note", note }).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;
  const scopeError = requireScope(auth, "cases:write");
  if (scopeError) return scopeError;
  if (!auth.memberId) {
    return NextResponse.json({ error: "review actions require a dashboard session, not an API key" }, { status: 403 });
  }

  const kase = await prisma.case.findUnique({ where: { id: (await params).id } });
  if (!kase || kase.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const body = await req.json();

  try {
    if (body.action === "open") {
      const review = await openManualReview((await params).id, Boolean(body.requiresDualApproval));
      await logAction({ organizationId: auth.organizationId, memberId: auth.memberId, action: "case.review_opened", targetType: "case_review", targetId: review.id, metadata: { caseId: (await params).id } });
      return NextResponse.json(review, { status: 201 });
    }
    if (body.action === "vote") {
      const existing = await prisma.caseReview.findUnique({ where: { caseId: (await params).id } });
      if (!existing) return NextResponse.json({ error: "no review exists for this case" }, { status: 404 });
      if (body.decision !== "APPROVE" && body.decision !== "REJECT") {
        return NextResponse.json({ error: "decision must be APPROVE or REJECT" }, { status: 400 });
      }
      const review = await castReviewApproval(existing.id, auth.memberId, body.decision, body.reason, auth.organizationId);
      return NextResponse.json(review);
    }
    if (body.action === "note") {
      const existing = await prisma.caseReview.findUnique({ where: { caseId: (await params).id } });
      if (!existing) return NextResponse.json({ error: "no review exists for this case" }, { status: 404 });
      if (!body.note || typeof body.note !== "string") {
        return NextResponse.json({ error: "note is required" }, { status: 400 });
      }
      const note = await addReviewNote(existing.id, auth.memberId, body.note);
      await logAction({ organizationId: auth.organizationId, memberId: auth.memberId, action: "case.review_note_added", targetType: "case_review_note", targetId: note.id, metadata: { caseId: (await params).id } });
      return NextResponse.json(note, { status: 201 });
    }
    return NextResponse.json({ error: "action must be one of: open, vote, note" }, { status: 400 });
  } catch (err) {
    if (err instanceof EscalationError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
