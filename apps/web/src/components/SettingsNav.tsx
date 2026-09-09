"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Added after real user feedback: none of the settings pages linked to
// each other or back to a central index, so a page like
// /settings/settlement-integrations was only reachable if you already
// knew the URL. This renders once, above every settings page (see
// settings/layout.tsx), rather than each page hand-rolling its own
// partial set of links.
const SETTINGS_LINKS = [
  { href: "/settings/policies", label: "Policies" },
  { href: "/settings/reviews", label: "Review queue" },
  { href: "/settings/analytics", label: "Analytics" },
  { href: "/settings/settlement-integrations", label: "Settlement integrations" },
  { href: "/settings/webhooks", label: "Webhooks" },
  { href: "/settings/reconciliation-findings", label: "Reconciliation findings" },
  { href: "/settings/cutover-readiness", label: "Cutover readiness" },
  { href: "/settings/reliability", label: "Reliability" },
  { href: "/settings/audit-log", label: "Audit log" },
  { href: "/settings/members", label: "Members" },
  { href: "/settings/keys", label: "API keys" },
  { href: "/settings/usage", label: "Usage & billing" },
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-black/[0.02] px-5 py-8 dark:border-line-dark dark:bg-white/[0.02]">
      <Link
        href="/cases"
        className="shrink-0 px-3 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
      >
        ← Docket
      </Link>
      <div className="mt-6 border-t border-line dark:border-line-dark" />
      <div className="mt-6 flex flex-col gap-0.5">
        {SETTINGS_LINKS.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-2 font-mono text-xs tracking-wide ${
                active
                  ? "bg-seal-500/10 text-seal-500 dark:bg-seal-400/10 dark:text-seal-400"
                  : "text-muted hover:bg-black/[0.03] hover:text-seal-500 dark:text-muted-dark dark:hover:bg-white/[0.04] dark:hover:text-seal-400"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
