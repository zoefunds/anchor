import { describe, it, expect } from "vitest";
import { encryptWebhookSecret, decryptWebhookSecret, webhookSecretPreview } from "@/lib/webhooks";

// Real regression coverage for the plaintext-webhook-secret fix
// (external audit finding, raised twice) — see lib/webhooks.ts's own
// header comment.
describe("webhook secret encryption", () => {
  it("round-trips a secret through encrypt/decrypt", () => {
    const original = "whsec_abcdef1234567890abcdef1234567890abcdef12";
    const encrypted = encryptWebhookSecret(original);
    expect(decryptWebhookSecret(encrypted)).toBe(original);
  });

  it("produces a different ciphertext/iv each time (real randomness, not deterministic)", () => {
    const original = "whsec_samevalueeverytime000000000000000000";
    const a = encryptWebhookSecret(original);
    const b = encryptWebhookSecret(original);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    // Both still decrypt to the same original value.
    expect(decryptWebhookSecret(a)).toBe(original);
    expect(decryptWebhookSecret(b)).toBe(original);
  });

  it("rejects decryption with a tampered auth tag (real GCM authentication, not just obfuscation)", () => {
    const encrypted = encryptWebhookSecret("whsec_realsecretvalue00000000000000000000");
    const tampered = { ...encrypted, authTag: encrypted.authTag.slice(0, -2) + (encrypted.authTag.slice(-2) === "00" ? "ff" : "00") };
    expect(() => decryptWebhookSecret(tampered)).toThrow();
  });

  it("never returns the full secret from webhookSecretPreview", () => {
    const original = "whsec_abcdef1234567890abcdef1234567890abcdef12";
    const preview = webhookSecretPreview(original);
    expect(preview).not.toBe(original);
    expect(preview.length).toBeLessThan(original.length);
    expect(preview.startsWith("whsec_")).toBe(true);
  });
});
