-- AlterTable
ALTER TABLE "Decision" ADD COLUMN "testRehearsalAuthToken" TEXT,
ADD COLUMN "testRehearsalConsumedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Decision_testRehearsalAuthToken_key" ON "Decision"("testRehearsalAuthToken");
