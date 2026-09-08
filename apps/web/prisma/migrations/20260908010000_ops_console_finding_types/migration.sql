-- Phase 3 ops console: new ReconciliationFindingType values for
-- signer/quorum staleness, late Hyperlane delivery, and live governance
-- drift against the committed deployment manifest.
ALTER TYPE "ReconciliationFindingType" ADD VALUE 'STALE_PENDING_SIGNATURE';
ALTER TYPE "ReconciliationFindingType" ADD VALUE 'LATE_HYPERLANE_DELIVERY';
ALTER TYPE "ReconciliationFindingType" ADD VALUE 'GOVERNANCE_DRIFT';
