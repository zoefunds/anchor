-- Purely additive: distinct from relayTxHash (real settlement tx) and
-- relayMessageId (real Hyperlane message ID) — a prior version of
-- dispatchDecisionForCase's Solana branch wrongly collapsed all three
-- into one value. See apps/web/src/lib/hyperlane.ts's dispatchDecisionForCase.
ALTER TABLE "Decision" ADD COLUMN "relayNotificationTxHash" TEXT;
