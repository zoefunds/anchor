-- AlterTable
ALTER TABLE "CaseSettlement" ADD COLUMN     "depositAuthorizeTxHash" TEXT,
ADD COLUMN     "depositAuthorizedAt" TIMESTAMP(3);
