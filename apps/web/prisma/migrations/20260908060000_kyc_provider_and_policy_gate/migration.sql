-- AlterTable
ALTER TABLE "PartyVerification"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'didit',
  ADD COLUMN "providerReference" TEXT,
  ADD COLUMN "policyVersionId" TEXT,
  ADD COLUMN "jurisdiction" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PartyVerification_policyVersionId_idx" ON "PartyVerification"("policyVersionId");

-- AddForeignKey
ALTER TABLE "PartyVerification" ADD CONSTRAINT "PartyVerification_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "PartyVerificationEvent" (
    "id" TEXT NOT NULL,
    "partyVerificationId" TEXT NOT NULL,
    "fromStatus" "PartyVerificationStatus",
    "toStatus" "PartyVerificationStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "actingMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartyVerificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartyVerificationEvent_partyVerificationId_idx" ON "PartyVerificationEvent"("partyVerificationId");

-- AddForeignKey
ALTER TABLE "PartyVerificationEvent" ADD CONSTRAINT "PartyVerificationEvent_partyVerificationId_fkey" FOREIGN KEY ("partyVerificationId") REFERENCES "PartyVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "KycWebhookDelivery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KycWebhookDelivery_provider_dedupeKey_key" ON "KycWebhookDelivery"("provider", "dedupeKey");
