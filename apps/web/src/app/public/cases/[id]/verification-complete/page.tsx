"use client";

import { useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";

// /public/cases/:id/verification-complete — the callback URL Didit
// redirects the party to after they finish (or abandon) the hosted
// verification flow (see lib/didit.ts's createDiditSession callback
// param). Didit appends verificationSessionId and status as query
// params, but the real, trustworthy status update comes from the
// webhook (api/webhooks/didit/route.ts), not this redirect — a
// redirect can be replayed or forged by the browser/user, so this page
// never trusts its own query params for anything beyond a friendly
// "hang on" message. It just bounces back to /verify, which reads the
// real status from the database.
export default function VerificationCompletePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const status = searchParams.get("status");

  useEffect(() => {
    const timer = setTimeout(() => {
      window.location.href = `/public/cases/${id}/verify`;
    }, 1500);
    return () => clearTimeout(timer);
  }, [id]);

  return (
    <main className="mx-auto max-w-lg px-8 py-16">
      <p className="font-display text-lg font-semibold text-ink-950 dark:text-ink">Anchor</p>
      <p className="kicker mt-2 text-seal-500 dark:text-seal-400">Identity verification</p>
      <div className="dossier mt-6">
        <p className="font-display text-xl font-semibold text-ink-950 dark:text-ink">
          {status === "Approved" ? "Verification submitted" : "Returning…"}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted dark:text-muted-dark">
          Redirecting you back to check your real, confirmed status…
        </p>
      </div>
    </main>
  );
}
