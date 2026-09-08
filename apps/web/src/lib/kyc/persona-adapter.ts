import { createHmac, timingSafeEqual } from "crypto";
import type {
  CreateVerificationSessionParams,
  KycProviderAdapter,
  NormalizedKycStatus,
  NormalizedWebhookEvent,
  VerificationSession,
  VerificationStatusResult,
  WebhookVerificationInput,
} from "@/lib/kyc/provider-adapter";
import { KycProviderMisconfiguredError } from "@/lib/kyc/provider-adapter";

// Persona (https://withpersona.com, docs at https://docs.withpersona.com)
// — built against Persona's PUBLICLY DOCUMENTED Inquiries API and
// webhook contract from training knowledge. NOT live-tested against a
// real Persona sandbox account: this sandbox has no internet access
// (verified with `curl https://api.persona.com` — DNS resolution
// failed) and this session was not given a real Persona API key. Do not
// treat this file as confirmed-working against Persona's live API
// without a real sandbox smoke test first.
//
// Chosen over Sumsub for this track only because Persona's inquiry
// creation and webhook-signing shapes are the ones this implementation
// is most confident reconstructing correctly from documentation alone;
// Anchor's actual already-integrated, already-webhook-tested real
// provider remains Didit (see lib/didit.ts), untouched by this track.

const PERSONA_API_BASE = "https://api.withpersona.com/api/v1";

function getApiKey(): string {
  const key = process.env.PERSONA_API_KEY;
  if (!key) throw new KycProviderMisconfiguredError("PERSONA_API_KEY is not set — see apps/web/.env.example");
  return key;
}

function getInquiryTemplateId(): string {
  const id = process.env.PERSONA_INQUIRY_TEMPLATE_ID;
  if (!id) throw new KycProviderMisconfiguredError("PERSONA_INQUIRY_TEMPLATE_ID is not set — see apps/web/.env.example");
  return id;
}

function getWebhookSecret(): string {
  const secret = process.env.PERSONA_WEBHOOK_SECRET;
  if (!secret) throw new KycProviderMisconfiguredError("PERSONA_WEBHOOK_SECRET is not set — see apps/web/.env.example");
  return secret;
}

// Documented Persona inquiry statuses (Inquiries API `attributes.status`):
// created, pending, completed, failed, expired, needs_review, approved,
// declined, marked_for_review — Persona's own docs describe `completed`
// as a transient state that resolves to `approved`/`declined` shortly
// after; `needs_review`/`marked_for_review` are its manual-review states.
const PERSONA_STATUS_TO_NORMALIZED: Record<string, NormalizedKycStatus> = {
  created: "NOT_STARTED",
  pending: "PENDING",
  completed: "PENDING",
  approved: "APPROVED",
  declined: "REJECTED",
  failed: "REJECTED",
  expired: "EXPIRED",
  needs_review: "MANUAL_REVIEW",
  marked_for_review: "MANUAL_REVIEW",
};

function normalizeStatus(personaStatus: string): NormalizedKycStatus {
  return PERSONA_STATUS_TO_NORMALIZED[personaStatus] ?? "MANUAL_REVIEW";
}

interface PersonaInquiryResource {
  data: {
    id: string;
    type: "inquiry";
    attributes: {
      status: string;
      "reference-id"?: string | null;
    };
  };
  meta?: { "session-token"?: string };
}

async function createInquiry(params: CreateVerificationSessionParams): Promise<PersonaInquiryResource> {
  const res = await fetch(`${PERSONA_API_BASE}/inquiries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
      "Persona-Version": "2023-01-05",
    },
    body: JSON.stringify({
      data: {
        attributes: {
          "inquiry-template-id": getInquiryTemplateId(),
          "reference-id": params.partyVerificationId,
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Persona inquiry creation failed: HTTP ${res.status} ${body}`);
  }
  return res.json();
}

export const personaAdapter: KycProviderAdapter = {
  name: "persona",

  async createVerificationSession(params) {
    const inquiry = await createInquiry(params);
    const sessionToken = inquiry.meta?.["session-token"];
    // Persona's hosted flow URL takes an inquiry-id (and, for a
    // one-time-use flow, a session-token) as query params — see
    // https://docs.withpersona.com/docs/hosted-flow.
    const hostedUrl = sessionToken
      ? `https://withpersona.com/verify?inquiry-id=${inquiry.data.id}&session-token=${sessionToken}`
      : `https://withpersona.com/verify?inquiry-id=${inquiry.data.id}`;
    const session: VerificationSession = {
      providerSessionId: inquiry.data.id,
      hostedUrl,
      providerReference: inquiry.data.attributes["reference-id"] ?? undefined,
    };
    return session;
  },

  async getVerificationStatus(providerSessionId): Promise<VerificationStatusResult> {
    const res = await fetch(`${PERSONA_API_BASE}/inquiries/${providerSessionId}`, {
      headers: { Authorization: `Bearer ${getApiKey()}`, "Persona-Version": "2023-01-05" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Persona inquiry fetch failed: HTTP ${res.status} ${body}`);
    }
    const inquiry: PersonaInquiryResource = await res.json();
    return {
      status: normalizeStatus(inquiry.data.attributes.status),
      providerReference: inquiry.data.attributes["reference-id"] ?? undefined,
      raw: inquiry,
    };
  },

  // Persona signs webhooks with a "Persona-Signature" header of shape
  // "t=<unix-seconds>,v1=<hex-hmac-sha256>" (documented at
  // https://docs.withpersona.com/docs/webhooks#verifying-webhooks),
  // computed over `${t}.${rawBody}` — same construction as Stripe's
  // webhook signing and this repo's own outbound scheme (see
  // lib/webhooks.ts's signPayload). A header can carry more than one
  // `v1=` value during secret rotation; any match is accepted.
  verifyWebhookSignature(input: WebhookVerificationInput): NormalizedWebhookEvent {
    const header = input.headers["persona-signature"];
    if (!header) throw new Error("missing Persona-Signature header");

    const parts = Object.fromEntries(
      header.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k, v];
      })
    ) as Record<string, string | undefined>;
    const t = parts.t;
    if (!t) throw new Error("Persona-Signature header missing t=");
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(t, 10);
    // Persona documents a 5-minute freshness recommendation, matching
    // this repo's existing Didit webhook window (lib/didit.ts).
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
      throw new Error(`Persona webhook timestamp outside freshness window (now=${now}, t=${t})`);
    }

    const candidateSigs = header
      .split(",")
      .filter((kv) => kv.startsWith("v1="))
      .map((kv) => kv.slice("v1=".length));
    if (candidateSigs.length === 0) throw new Error("Persona-Signature header missing v1=");

    const expected = createHmac("sha256", getWebhookSecret()).update(`${t}.${input.rawBody}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const matched = candidateSigs.some((sig) => {
      const sigBuf = Buffer.from(sig, "utf8");
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    });
    if (!matched) throw new Error("Persona webhook signature does not match");

    const parsed = JSON.parse(input.rawBody) as {
      data: {
        id: string;
        attributes: {
          name: string;
          payload: { data: PersonaInquiryResource["data"] };
        };
      };
    };
    const inquiry = parsed.data.attributes.payload.data;
    return {
      providerEventId: parsed.data.id,
      providerSessionId: inquiry.id,
      status: normalizeStatus(inquiry.attributes.status),
      providerReference: inquiry.attributes["reference-id"] ?? undefined,
      raw: parsed,
    };
  },
};
