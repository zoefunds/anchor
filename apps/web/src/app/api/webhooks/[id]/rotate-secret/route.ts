import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { generateWebhookSecret, encryptWebhookSecret, webhookSecretPreview } from "@/lib/webhooks";

// POST /api/webhooks/:id/rotate-secret — real P1 fix (external audit
// finding, raised twice): "encrypt secrets... add a rotate-secret
// endpoint" — this project had no way to rotate a webhook's signing
// secret at all before this. Issues a fresh secret, returns it exactly
// once (never again after this response, same convention as creation),
// and audits the rotation. OWNER-only, same posture as webhook
// create/delete — a webhook's secret is what an external receiver uses
// to authenticate Anchor, so rotating it is exactly as privileged as
// creating one.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const webhook = await prisma.webhook.findUnique({ where: { id: params.id } });
  if (!webhook || webhook.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "webhook not found" }, { status: 404 });
  }

  const rawSecret = generateWebhookSecret();
  const encrypted = encryptWebhookSecret(rawSecret);

  await prisma.$transaction(async (tx) => {
    await tx.webhook.update({
      where: { id: webhook.id },
      data: {
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        secretPreview: webhookSecretPreview(rawSecret),
      },
    });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "webhook.secret_rotated",
        targetType: "webhook",
        targetId: webhook.id,
      },
      tx
    );
  });

  return NextResponse.json({ id: webhook.id, secret: rawSecret });
}
