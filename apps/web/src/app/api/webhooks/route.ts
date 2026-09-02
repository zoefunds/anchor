import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { WEBHOOK_EVENTS, generateWebhookSecret, encryptWebhookSecret, webhookSecretPreview } from "@/lib/webhooks";
import { isDangerousHostname } from "@/lib/ssrf-guard";

// GET /api/webhooks — list this org's webhooks. Real P1 fixed here
// (external audit finding, raised twice): this used to return the full
// plaintext signing secret on every call. It now returns only
// secretPreview (a short masked prefix) — the raw secret is shown once,
// at creation (POST below) or rotation (POST .../rotate-secret), never
// again after that.
export async function GET() {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const webhooks = await prisma.webhook.findMany({
    where: { organizationId: member.organizationId },
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, secretPreview: true, events: true, active: true, createdAt: true },
  });
  return NextResponse.json(webhooks);
}

// POST /api/webhooks — subscribe a URL to case-lifecycle events.
// OWNER-only, dashboard-only: a webhook can leak case details to whatever
// URL it's pointed at, so this isn't something an API key should be able
// to set up unilaterally.
export async function POST(req: NextRequest) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const { url, events } = await req.json();
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "url is not a valid URL" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return NextResponse.json({ error: "url must be http(s)" }, { status: 400 });
  }
  // Cheap, obvious-pattern rejection now; the real defense (resolved-IP
  // check, catches DNS rebinding this can't) happens again right before
  // every actual delivery — see lib/ssrf-guard.ts.
  if (isDangerousHostname(parsed.hostname)) {
    return NextResponse.json({ error: "url must not point at a private/internal address" }, { status: 400 });
  }

  const requestedEvents: string[] = Array.isArray(events) && events.length > 0 ? events : [...WEBHOOK_EVENTS];
  const invalid = requestedEvents.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `unknown event(s): ${invalid.join(", ")}`, validEvents: WEBHOOK_EVENTS }, { status: 400 });
  }

  const rawSecret = generateWebhookSecret();
  const encrypted = encryptWebhookSecret(rawSecret);
  const webhook = await prisma.$transaction(async (tx) => {
    const created = await tx.webhook.create({
      data: {
        organizationId: member.organizationId,
        url,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        secretPreview: webhookSecretPreview(rawSecret),
        events: requestedEvents,
      },
    });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "webhook.created",
        targetType: "webhook",
        targetId: created.id,
        metadata: { url, events: requestedEvents },
      },
      tx
    );
    return created;
  });

  // The raw secret is returned exactly once, here — it is never
  // retrievable again after this response (same convention as API keys).
  const { secretCiphertext: _c, secretIv: _iv, secretAuthTag: _at, ...webhookWithoutCiphertext } = webhook;
  return NextResponse.json({ ...webhookWithoutCiphertext, secret: rawSecret }, { status: 201 });
}
