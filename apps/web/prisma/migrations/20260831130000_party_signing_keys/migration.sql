-- Optional Ed25519 signing keypair per party, on top of the existing
-- bearer token, for real non-repudiation on signed submissions. See
-- lib/party-signing.ts.
ALTER TABLE "Case" ADD COLUMN "claimantPublicKey" TEXT;
ALTER TABLE "Case" ADD COLUMN "respondentPublicKey" TEXT;
ALTER TABLE "Evidence" ADD COLUMN "signatureVerified" BOOLEAN NOT NULL DEFAULT false;
