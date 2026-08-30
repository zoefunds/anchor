import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

interface LogActionParams {
  organizationId: string;
  memberId?: string | null;
  apiKeyId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records one audit-log entry. Fire-and-forget by design (never await this
 * to block a response) — an audit-log write failing should never fail the
 * user-facing action it's recording, but every mutating route should still
 * call this inline (not "eventually"), so the log stays trustworthy.
 */
export function logAction(params: LogActionParams): void {
  void prisma.auditLog
    .create({
      data: {
        organizationId: params.organizationId,
        memberId: params.memberId ?? null,
        apiKeyId: params.apiKeyId ?? null,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId ?? null,
        metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("audit log write failed:", err instanceof Error ? err.message : err);
    });
}
