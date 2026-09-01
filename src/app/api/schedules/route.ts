/**
 * Schedules: list + bulk upsert for a given date.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { EmployeeSchedule, ShiftTemplate, WorkSite, Company, User } from "@/models";
import { requireAuth, requireRole, ok, withApi } from "@/lib/api-helpers";
import { ScheduleBulkSchema } from "@/lib/validators";
import { zonedDateTimeToUtc } from "@/lib/workdate";
import { resolveShiftEnd } from "@/lib/attendance-logic";

export const GET = withApi(async (req: NextRequest) => {
  const session = await requireAuth();
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const filter: any = { companyId: session.user.companyId };
  if (from || to) {
    filter.workDate = {};
    if (from) filter.workDate.$gte = from;
    if (to) filter.workDate.$lte = to;
  }
  const schedules = await EmployeeSchedule.find(filter).lean();
  return ok({ schedules });
});

export const POST = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const body = ScheduleBulkSchema.parse(await req.json());
  const companyId = new Types.ObjectId(session.user.companyId);
  const company = await Company.findById(companyId).lean();
  const timezone = company?.timezone || "Asia/Kolkata";

  const valid = (v: string) => Types.ObjectId.isValid(v);
  // Only act on employees / sites / shifts that belong to THIS company — prevents
  // a caller from reaching across tenants by supplying foreign ids.
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

  const created: any[] = [];
  for (const e of body.entries) {
    if (!validEmp.has(e.employeeId) || !validSite.has(e.siteId) || !shiftMap.has(e.shiftTemplateId)) {
      continue;
    }
    const shift = shiftMap.get(e.shiftTemplateId);
    const expectedStartAt = zonedDateTimeToUtc(body.workDate, shift.startTime, timezone);
    const endRaw = zonedDateTimeToUtc(body.workDate, shift.endTime, timezone);
    // Overnight shift (end time is on the next calendar day).
    const expectedEndAt = new Date(
      resolveShiftEnd(expectedStartAt.getTime(), endRaw.getTime())
    );
    const result = await EmployeeSchedule.findOneAndUpdate(
      {
        companyId,
        employeeId: new Types.ObjectId(e.employeeId),
        workDate: body.workDate,
      },
      {
        $set: {
          companyId,
          siteId: new Types.ObjectId(e.siteId),
          shiftTemplateId: new Types.ObjectId(e.shiftTemplateId),
          isWorkingDay: e.isWorkingDay,
          expectedStartAt,
          expectedEndAt,
        },
      },
      { upsert: true, new: true }
    );
    created.push(result.toObject());
  }
  return ok({ schedules: created }, { status: 201 });
});