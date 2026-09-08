import type { KycProviderAdapter } from "@/lib/kyc/provider-adapter";
import { KycProviderMisconfiguredError } from "@/lib/kyc/provider-adapter";
import { personaAdapter } from "@/lib/kyc/persona-adapter";
import { testProviderAdapter } from "@/lib/kyc/test-provider-adapter";

// Selector for Track 3's provider abstraction. KYC_PROVIDER=persona|test,
// defaulting to "test" (this repo's whole real deployment is testnet —
// see environment-registry.ts — so an unset KYC_PROVIDER should never
// accidentally reach out to a real provider). Deliberately does NOT
// fall back from a misconfigured real provider to the test adapter:
// an operator who set KYC_PROVIDER=persona meant for real Persona calls
// to happen, and a silent fallback to a fake always-approving adapter
// would be a worse failure mode than a loud startup/call-time error.

export function isTestKycProviderAllowed(): boolean {
  // The one place this decision is made — see test-provider-adapter.ts's
  // own header comment. NODE_ENV is this repo's only real signal today
  // for "is this a production-shaped deploy" (environment-registry.ts's
  // AnchorEnvironmentId is prepare-only and not yet read by any live
  // request path — see that file's own header comment); a live Anchor
  // deploy always sets NODE_ENV=production, including on testnet chains,
  // so this intentionally does NOT mean "mainnet" — it means "not a
  // developer's own machine or a test run."
  return process.env.NODE_ENV !== "production";
}

export function getKycProvider(): KycProviderAdapter {
  const requested = process.env.KYC_PROVIDER ?? "test";

  if (requested === "persona") {
    // Throws KycProviderMisconfiguredError if PERSONA_API_KEY /
    // PERSONA_INQUIRY_TEMPLATE_ID / PERSONA_WEBHOOK_SECRET are missing —
    // persona-adapter.ts's own getters do this lazily per-call, but
    // resolving the adapter at all here still requires a valid intent:
    // there is no code path where KYC_PROVIDER=persona silently becomes
    // the test adapter.
    return personaAdapter;
  }

  if (requested === "test") {
    if (!isTestKycProviderAllowed()) {
      throw new KycProviderMisconfiguredError(
        "KYC_PROVIDER=test (or unset) is not allowed when NODE_ENV=production — set KYC_PROVIDER=persona with real credentials, or run with NODE_ENV!=production for local dev/tests"
      );
    }
    return testProviderAdapter;
  }

  throw new KycProviderMisconfiguredError(`unknown KYC_PROVIDER: "${requested}" — expected "persona" or "test"`);
}

export * from "@/lib/kyc/provider-adapter";
