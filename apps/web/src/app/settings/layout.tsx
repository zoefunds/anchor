import { redirect } from "next/navigation";
import { getSessionMember } from "@/lib/auth";
import { SettingsNav } from "@/components/SettingsNav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const member = await getSessionMember();
  if (!member) {
    redirect("/login");
  }
  if (!member.emailVerified) {
    redirect("/verify-required");
  }
  return (
    <div className="flex">
      <SettingsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
