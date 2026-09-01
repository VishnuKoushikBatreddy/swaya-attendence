/**
 * Employee layout (nested under dashboard) — redirects non-employees.
 */
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/active-user";

export default async function EmployeeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");

  // Same reason as the admin layout: the 7-day session cookie is not proof the
  // account is still active or still an employee.
  const live = await getActiveUser(session.user.id);
  if (!live) redirect("/login");
  if (live.role !== "employee") redirect("/admin");
  return children as any; // satisfy TS — layout wraps content
}
