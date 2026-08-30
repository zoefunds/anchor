import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { LogoutButton } from "@/components/LogoutButton";

// Server-side guard: every route under /cases requires a dashboard
// session. Checked here (a Server Component) rather than client-side so
// an unauthenticated request never even receives the page shell.
export default async function CasesLayout({ children }: { children: React.ReactNode }) {
  const member = await getSessionMember();
  if (!member) {
    redirect("/login");
  }
  if (!member.emailVerified) {
    redirect("/verify-required");
  }

  const organization = await prisma.organization.findUnique({ where: { id: member.organizationId } });

  return (
    <div>
      <nav className="border-b border-line dark:border-line-dark">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-4">
          <Link href="/cases" className="font-display text-base font-semibold text-ink-950 dark:text-ink">
            Anchor
          </Link>
          <div className="flex items-center gap-6 font-mono text-xs text-muted dark:text-muted-dark">
            <span>{organization?.name}</span>
            <Link href="/settings/keys" className="hover:text-seal-500 dark:hover:text-seal-400">
              API keys
            </Link>
            <LogoutButton />
          </div>
        </div>
      </nav>
      {children}
    </div>
  );
}
