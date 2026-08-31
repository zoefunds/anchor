-- Short-lived claim/lease on settlement dispatch to prevent double-send
-- when a retry sweep and the original dispatch path race. See
-- Decision.relayClaimedAt's schema comment.
ALTER TABLE "Decision" ADD COLUMN "relayClaimedAt" TIMESTAMP(3);
