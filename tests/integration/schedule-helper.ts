/**
 * Give an integration-test employee a schedule for the day.
 *
 * Check-in now requires one: an unscheduled day means "you are not working
 * today", so a fixture without a schedule is refused before it reaches whatever
 * the test is actually about. Most of these tests predate that rule and were
 * quietly relying on the old "no schedule, no gate" behaviour — which is exactly
 * why an employee with nothing rostered could check in.
 *
 * The schedule is a WORKING DAY WITH NO HOURS. isWorkingDay passes the gate,
 * and leaving expectedStartAt/expectedEndAt unset means no shift-hours window is
 * enforced, so tests can use whatever timestamps they like without every one of
 * them having to model a realistic shift.
 */
import { Types } from "mongoose";

export async function giveOpenEndedSchedule(
  models: typeof import("@/models"),
  opts: {
    companyId: Types.ObjectId;
    employeeId: Types.ObjectId;
    siteId: Types.ObjectId;
    /** Defaults to today plus the surrounding days, covering back-dated fixtures. */
    workDates?: string[];
  }
) {
  const shift =
    (await models.ShiftTemplate.findOne({ companyId: opts.companyId }).lean()) ??
    (await models.ShiftTemplate.create({
      companyId: opts.companyId,
      name: "Test Shift",
      startTime: "00:00",
      endTime: "23:59",
      graceMinutes: 0,
      isActive: true,
    }));

  // Fixtures routinely back-date by several hours and can land on the previous
  // calendar day, so cover a window rather than just today.
  const dates =
    opts.workDates ??
    [-2, -1, 0, 1].map((offset) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    );

  await models.EmployeeSchedule.bulkWrite(
    dates.map((workDate) => ({
      updateOne: {
        filter: { employeeId: opts.employeeId, workDate },
        update: {
          $set: {
            companyId: opts.companyId,
            siteId: opts.siteId,
            shiftTemplateId: (shift as { _id: Types.ObjectId })._id,
            isWorkingDay: true,
          },
          // No expectedStartAt/EndAt: a working day with no hours window.
          $unset: { expectedStartAt: "", expectedEndAt: "" },
        },
        upsert: true,
      },
    }))
  );
}
