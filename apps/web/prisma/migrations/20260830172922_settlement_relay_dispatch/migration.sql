-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "settlementChain" TEXT,
ADD COLUMN     "settlementContract" TEXT;

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "relayError" TEXT,
ADD COLUMN     "relayMessageId" TEXT,
ADD COLUMN     "relayTxHash" TEXT;
