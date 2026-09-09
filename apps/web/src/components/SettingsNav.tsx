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
    <nav className="sticky top-0 flex h-screen w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-black/[0.02] px-6 py-6 dark:border-line-dark dark:bg-white/[0.02]">
      <Link
        href="/cases"
        className="shrink-0 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
      >
        ← Docket
      </Link>
      <div className="flex flex-col gap-1">
        {SETTINGS_LINKS.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`font-mono text-xs ${
                active
                  ? "text-seal-500 dark:text-seal-400"
                  : "text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
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
