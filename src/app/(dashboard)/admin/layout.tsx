import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/active-user";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");

  // The session cookie carries the role from login and lasts 7 days, so it
  // cannot be trusted on its own — a deactivated or demoted user would keep
  // rendering this shell until it expired. Read the live account instead.
  const live = await getActiveUser(session.user.id);
  if (!live) redirect("/login");
  if (live.role !== "admin") redirect("/employee");
  return children as any;
}
