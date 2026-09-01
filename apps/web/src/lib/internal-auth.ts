import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

// Auth for operational endpoints that aren't scoped to any one
// organization (unlike everything under lib/auth.ts's
// resolveOrgFromRequest) — the M-of-N attestor co-signing endpoints are
// the first user of this, but any future platform-level internal route
// (not a per-org dashboard/API-key concern) should reuse it rather than
// inventing another bearer-secret check. A single shared secret, not a
// per-holder credential — anyone with ATTESTOR_COSIGN_SECRET can submit
// a co-signature, but submitting a signature that doesn't recover to a
// registered attestor address is rejected regardless (see the sign
// route), so this secret gates "can attempt to submit," not "can move
// funds" — that's still entirely gated by the attestor private key
// itself, which this secret never sees.
export function checkInternalSecret(req: NextRequest): NextResponse | null {
  const configured = process.env.ATTESTOR_COSIGN_SECRET;
  if (!configured) {
    return NextResponse.json({ error: "ATTESTOR_COSIGN_SECRET is not configured on this deployment" }, { status: 503 });
  }
  const header = req.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!provided) {
    return NextResponse.json({ error: "missing Authorization: Bearer <secret>" }, { status: 401 });
  }
  const expectedBuf = Buffer.from(configured);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return NextResponse.json({ error: "invalid secret" }, { status: 401 });
  }
  return null;
}
