import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { WEBHOOK_EVENTS, generateWebhookSecret } from "@/lib/webhooks";

// GET /api/webhooks — list this org's webhooks (secrets included: the org
// needs to read its own signing secret back to verify deliveries).
export async function GET() {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const webhooks = await prisma.webhook.findMany({
    where: { organizationId: member.organizationId },
    orderBy: { createdAt: "desc" },
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

  const requestedEvents: string[] = Array.isArray(events) && events.length > 0 ? events : [...WEBHOOK_EVENTS];
  const invalid = requestedEvents.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `unknown event(s): ${invalid.join(", ")}`, validEvents: WEBHOOK_EVENTS }, { status: 400 });
  }

  const webhook = await prisma.webhook.create({
    data: {
      organizationId: member.organizationId,
      url,
      secret: generateWebhookSecret(),
      events: requestedEvents,
    },
  });

  logAction({
    organizationId: member.organizationId,
    memberId: member.memberId,
    action: "webhook.created",
    targetType: "webhook",
    targetId: webhook.id,
    metadata: { url, events: requestedEvents },
  });

  return NextResponse.json(webhook, { status: 201 });
}
