/*
  Warnings:

  - You are about to drop the column `autoSettlementCapUsd` on the `PolicyVersion` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PolicyVersion" DROP COLUMN "autoSettlementCapUsd",
ADD COLUMN     "autoSettlementCapNative" DECIMAL(65,30);
