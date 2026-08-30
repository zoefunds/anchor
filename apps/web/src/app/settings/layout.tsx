import { redirect } from "next/navigation";
import { getSessionMember } from "@/lib/auth";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const member = await getSessionMember();
  if (!member) {
    redirect("/login");
  }
  return <>{children}</>;
}
