import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionMember, generateApiKey } from "@/lib/auth";

// API keys can only be managed via a dashboard session, not another API
// key — otherwise a leaked key could mint itself unlimited replacements.
export async function GET() {
  const member = await getSessionMember();
  if (!member) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const keys = await prisma.apiKey.findMany({
    where: { organizationId: member.organizationId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, keyPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
  return NextResponse.json(keys);
}

export async function POST(req: NextRequest) {
  const member = await getSessionMember();
  if (!member) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { name } = await req.json();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { raw, prefix, hash } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: { organizationId: member.organizationId, name, keyHash: hash, keyPrefix: prefix },
  });

  // The raw key is returned exactly once, here — it is never retrievable
  // again after this response.
  return NextResponse.json(
    { id: key.id, name: key.name, keyPrefix: key.keyPrefix, key: raw, createdAt: key.createdAt },
    { status: 201 }
  );
}
