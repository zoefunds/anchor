"use client";

import { useEffect, useState } from "react";

export function EmailVerificationBanner() {
  const [verified, setVerified] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (res) => (res.ok ? res.json() : null))
      .then((body) => setVerified(body ? Boolean(body.member.emailVerified) : null));
  }, []);

  async function resend() {
    setSending(true);
    try {
      await fetch("/api/auth/verify-email", { method: "POST" });
      setSent(true);
    } finally {
      setSending(false);
    }
  }

  if (verified !== false) return null;

  return (
    <div className="mb-8 flex items-center justify-between border-l-2 border-status-pending bg-status-pending/5 py-2 pl-4 pr-4 text-sm text-status-pending">
      <span>{sent ? "Verification email sent. Check your inbox." : "Your email address isn't verified yet."}</span>
      {!sent && (
        <button onClick={resend} disabled={sending} className="font-mono text-xs underline hover:no-underline">
          {sending ? "Sending…" : "Resend link"}
        </button>
      )}
    </div>
  );
}
