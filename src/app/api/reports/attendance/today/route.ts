/**
 * Today's attendance summary across the company.
 */
import { NextRequest } from "next/server";
import { AttendanceDay, User } from "@/models";
import { requireAuth, ok, withApi } from "@/lib/api-helpers";
import { todayWorkDate } from "@/lib/workdate";
import { getCompanyTimezone } from "@/lib/company";

export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  const session = await requireAuth();

  // The timezone lookup and the manager's team lookup are independent, so run
  // them together. getCompanyTimezone is the cached helper every other route
  // uses — it usually answers from memory instead of hitting Company at all.
  const isManager = session.user.role === "manager";
  const [timezone, team] = await Promise.all([
    getCompanyTimezone(session.user.companyId),
    isManager
      ? User.find({ managerId: session.user.id }).select("_id").lean()
      : Promise.resolve([] as { _id: unknown }[]),
  ]);
  const workDate = todayWorkDate(timezone);

  const filter: any = { companyId: session.user.companyId, workDate };
  if (isManager) {
    filter.employeeId = { $in: team.map((u: { _id: unknown }) => u._id) };
  } else if (session.user.role === "employee") {
    filter.employeeId = session.user.id;
  }

  const days = await AttendanceDay.find(filter).lean();

  const summary = {
    total: days.length,
    present: days.filter((d: { status: string }) => d.status === "present").length,
    late: days.filter((d: { status: string }) => d.status === "late").length,
    absent: days.filter((d: { status: string }) => d.status === "absent").length,
    half_day: days.filter((d: { status: string }) => d.status === "half_day").length,
    flagged: days.filter((d: { isFlagged: boolean }) => d.isFlagged).length,
    on_leave: days.filter((d: { status: string }) => d.status === "on_leave").length,
  };

  return ok({ summary, days });
});