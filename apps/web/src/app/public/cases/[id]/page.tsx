"use client";

import { useParams, useSearchParams } from "next/navigation";
import { usePublicCase } from "./usePublicCase";
import { CasePanel } from "./CasePanel";

export default function PublicCasePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const token = searchParams.get("token");
  const { kase, error, refresh, token: activeToken } = usePublicCase(id, token);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">{error}</p>
      </main>
    );
  }

  if (!kase) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="font-mono text-sm text-muted dark:text-muted-dark">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <CasePanel id={id} kase={kase} token={activeToken} onRefresh={refresh} />
    </main>
  );
}
