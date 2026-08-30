// Transactional email via Brevo's HTTP API (https://api.brevo.com/v3/smtp/email).
// No SDK dependency — it's a single JSON POST, not worth pulling in a package for.

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

const SENDER = {
  name: "Anchor",
  email: process.env.EMAIL_FROM_ADDRESS || "noreply@anchor.dev",
};

interface SendEmailParams {
  to: string;
  subject: string;
  htmlContent: string;
}

/**
 * Sends a transactional email via Brevo. Throws if BREVO_API_KEY is unset
 * or the API call fails — callers decide whether that should block the
 * request (e.g. invite creation still succeeds even if the email bounces,
 * since the link itself is the source of truth, not the email delivery).
 */
export async function sendEmail({ to, subject, htmlContent }: SendEmailParams): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error("BREVO_API_KEY is not set — see apps/web/.env.example");
  }

  const res = await fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: SENDER,
      to: [{ email: to }],
      subject,
      htmlContent,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo send failed (${res.status}): ${body}`);
  }
}

function baseTemplate(title: string, bodyHtml: string): string {
  return `
    <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #16130f;">
      <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #a15c2f; margin: 0 0 8px;">Anchor</p>
      <h1 style="font-size: 22px; margin: 0 0 20px;">${title}</h1>
      ${bodyHtml}
      <p style="margin-top: 32px; font-size: 12px; color: #7a746a;">If you didn't expect this email, you can safely ignore it.</p>
    </div>
  `;
}

export async function sendInviteEmail(params: {
  to: string;
  organizationName: string;
  inviteUrl: string;
}): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: `You've been invited to join ${params.organizationName} on Anchor`,
    htmlContent: baseTemplate(
      "You've been invited",
      `<p style="font-size: 15px; line-height: 1.6;">You've been invited to join <strong>${params.organizationName}</strong> on Anchor, an adjudication-as-a-service platform.</p>
       <p style="margin-top: 24px;"><a href="${params.inviteUrl}" style="display: inline-block; background: #a15c2f; color: #fff; padding: 10px 20px; text-decoration: none; font-size: 14px;">Accept invite</a></p>
       <p style="margin-top: 16px; font-size: 12px; color: #7a746a;">This link expires in 7 days.</p>`
    ),
  });
}

export async function sendVerificationEmail(params: {
  to: string;
  verifyUrl: string;
}): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: "Verify your Anchor email",
    htmlContent: baseTemplate(
      "Verify your email",
      `<p style="font-size: 15px; line-height: 1.6;">Confirm this is your email address to finish setting up your Anchor account.</p>
       <p style="margin-top: 24px;"><a href="${params.verifyUrl}" style="display: inline-block; background: #a15c2f; color: #fff; padding: 10px 20px; text-decoration: none; font-size: 14px;">Verify email</a></p>
       <p style="margin-top: 16px; font-size: 12px; color: #7a746a;">This link expires in 24 hours.</p>`
    ),
  });
}

export async function sendPasswordResetEmail(params: {
  to: string;
  resetUrl: string;
}): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: "Reset your Anchor password",
    htmlContent: baseTemplate(
      "Reset your password",
      `<p style="font-size: 15px; line-height: 1.6;">A password reset was requested for your Anchor account.</p>
       <p style="margin-top: 24px;"><a href="${params.resetUrl}" style="display: inline-block; background: #a15c2f; color: #fff; padding: 10px 20px; text-decoration: none; font-size: 14px;">Reset password</a></p>
       <p style="margin-top: 16px; font-size: 12px; color: #7a746a;">This link expires in 1 hour.</p>`
    ),
  });
}
