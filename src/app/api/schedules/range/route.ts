/**
 * Assign a shift + site to employees across a date range.
 *
 * For each date in [fromDate, toDate], an EmployeeSchedule is upserted per
 * employee. Sundays (when skipSundays)
 * are marked `isWorkingDay: false` so those days do not require a check-in.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { EmployeeSchedule, ShiftTemplate, Company, WorkSite, User } from "@/models";
import { requireRole, ok, fail, withApi } from "@/lib/api-helpers";
import { ScheduleRangeSchema } from "@/lib/validators";
import { enumerateWorkDates, isSunday, zonedDateTimeToUtc } from "@/lib/workdate";
import { resolveShiftEnd } from "@/lib/attendance-logic";

const MAX_OPERATIONS = 10_000; // guard against accidental huge writes

export const POST = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const body = ScheduleRangeSchema.parse(await req.json());

  if (body.toDate < body.fromDate) {
    return fail("End date must be on or after the start date", 400);
  }

  const dates = enumerateWorkDates(body.fromDate, body.toDate);
  if (dates.length > 366) {
    return fail("Date range too large (max 366 days)", 400);
  }
  if (dates.length * body.entries.length > MAX_OPERATIONS) {
    return fail("Too many schedule entries at once — narrow the range or employees", 400);
  }

  const companyId = new Types.ObjectId(session.user.companyId);
  const company = await Company.findById(companyId).lean();
  const timezone = company?.timezone || "Asia/Kolkata";

  const valid = (v: string) => Types.ObjectId.isValid(v);
  // Ownership sets (employees/sites/shifts of THIS company).
  const [emps, sites, shifts] = await Promise.all([
    User.find({ companyId, _id: { $in: body.entries.map((e) => e.employeeId).filter(valid) } })
      .select("_id")
      .lean(),
    WorkSite.find({ companyId, _id: { $in: body.entries.map((e) => e.siteId).filter(valid) } })
      .select("_id")
      .lean(),
    ShiftTemplate.find({ companyId, _id: { $in: body.entries.map((e) => e.shiftTemplateId).filter(valid) } }).lean(),
  ]);
  const validEmp = new Set(emps.map((u: any) => String(u._id)));
  const validSite = new Set(sites.map((s: any) => String(s._id)));
  const shiftMap = new Map<string, any>(shifts.map((s: any) => [String(s._id), s]));

  const operations: any[] = [];
  let workingDays = 0;
  let offDays = 0;

  for (const e of body.entries) {
    if (!validEmp.has(e.employeeId) || !validSite.has(e.siteId) || !shiftMap.has(e.shiftTemplateId)) {
      continue;
    }
    const shift = shiftMap.get(e.shiftTemplateId);

    for (const date of dates) {
      const isWorkingDay = !(body.skipSundays && isSunday(date));
      isWorkingDay ? workingDays++ : offDays++;

      const set: any = {
        companyId,
        siteId: new Types.ObjectId(e.siteId),
        shiftTemplateId: new Types.ObjectId(e.shiftTemplateId),
        isWorkingDay,
      };
      const update: any = { $set: set };

      if (isWorkingDay && shift) {
        set.expectedStartAt = zonedDateTimeToUtc(date, shift.startTime, timezone);
        const endRaw = zonedDateTimeToUtc(date, shift.endTime, timezone);
        // Overnight shift — end time is on the next calendar day.
        set.expectedEndAt = new Date(
          resolveShiftEnd(set.expectedStartAt.getTime(), endRaw.getTime())
        );
      } else {
        // Off day — clear any stale expected times.
        update.$unset = { expectedStartAt: "", expectedEndAt: "" };
      }

      operations.push({
        updateOne: {
          filter: { companyId, employeeId: new Types.ObjectId(e.employeeId), workDate: date },
          update,
          upsert: true,
        },
      });
    }
  }

  if (operations.length) {
    await EmployeeSchedule.bulkWrite(operations);
  }

  return ok({
    fromDate: body.fromDate,
    toDate: body.toDate,
    totalDays: dates.length,
    employees: body.entries.length,
    workingDays,
    offDays,
  });
});
