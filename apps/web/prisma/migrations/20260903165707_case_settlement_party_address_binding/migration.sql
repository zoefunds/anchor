-- AlterTable
ALTER TABLE "CaseSettlement" ADD COLUMN     "claimantAddressSetAt" TIMESTAMP(3),
ADD COLUMN     "respondentAddressSetAt" TIMESTAMP(3),
ALTER COLUMN "claimantAddress" DROP NOT NULL,
ALTER COLUMN "respondentAddress" DROP NOT NULL;
