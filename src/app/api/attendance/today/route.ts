import { NextRequest } from "next/server";
import { AttendanceDay, AttendanceSession, WorkSite, EmployeeSchedule, ShiftTemplate } from "@/models";
import { requireAuth, ok, withApi } from "@/lib/api-helpers";
import { liveTotalsForActiveSession } from "@/lib/attendance-service";
import { getCompanyTimezone } from "@/lib/company";
import { todayWorkDate } from "@/lib/workdate";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export const GET = withApi(async (_req: NextRequest) => {
  const session = await requireAuth();

  const timezone = await getCompanyTimezone(session.user.companyId);
  const workDate = todayWorkDate(timezone);

  // The day and the live totals are independent — run them in parallel.
  const [day, live] = await Promise.all([
    AttendanceDay.findOne({ employeeId: session.user.id, workDate }).lean(),
    liveTotalsForActiveSession(session.user.id),
  ]);

  // These depend on `day`; once we have it, fetch them together.
  const [sessions, site, schedule] = await Promise.all([
    day ? AttendanceSession.find({ attendanceDayId: day._id }).sort({ checkInAt: 1 }).lean() : [],
    day ? WorkSite.findById(day.siteId).lean() : null,
    day?.scheduleId
      ? EmployeeSchedule.findById(day.scheduleId).lean()
      : EmployeeSchedule.findOne({ employeeId: session.user.id, workDate }).lean(),
  ]);

  const shift = schedule?.shiftTemplateId
    ? await ShiftTemplate.findById(schedule.shiftTemplateId).lean()
    : null;

  // Which site to show on the map: once checked in, the day's site; before that,
  // the SCHEDULED site for today (so the employee sees where to go on a rotation
  // day). Falls back to null when neither exists.
  const displaySite =
    site ?? (schedule?.siteId ? await WorkSite.findById(schedule.siteId).lean() : null);

  // If a session is open, overlay live (cumulative) totals so the dashboard shows
  // work/outside time changing while checked in.
  const dayOut = live && day ? { ...day, ...live } : day;

  // PING_INTERVAL_MS is a server-side env var, but the tracker that needs it runs
  // in the browser. Shipping it on this payload (which the employee page already
  // polls) keeps it runtime-configurable — change it on the host and every client
  // picks it up on the next poll, with no rebuild. A NEXT_PUBLIC_ var would be
  // baked in at build time instead, which the Capacitor WebView shell can't
  // refresh without a redeploy.
  return ok({
    day: dayOut,
    sessions,
    site: displaySite,
    schedule,
    shift,
    pingIntervalMs: env.PING_INTERVAL_MS,
    // Auto check-in config, delivered rather than bundled so it can be turned
    // off server-side without redeploying the client.
    autoCheckIn: {
      enabled: env.AUTO_CHECKIN_ENABLED,
      pollMs: env.AUTO_CHECKIN_POLL_MS,
      graceMinutes: shift?.graceMinutes ?? 0,
    },
  });
});
