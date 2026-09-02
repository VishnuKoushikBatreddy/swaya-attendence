/**
 * isFlagged must never contradict flagReasons.
 *
 * Two separate defects used to break that, in opposite directions, which is why
 * both cases are pinned here. Each test names the wrong behaviour it replaces.
 *
 *   RUN_DB_TESTS=1 MONGODB_URI=... MONGODB_DB_NAME=attendance_ci \
 *     npx vitest run tests/integration/flag-consistency.integration.test.ts --hookTimeout=120000
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Types } from "mongoose";
import { giveOpenEndedSchedule } from "./schedule-helper";

const RUN = process.env.RUN_DB_TESTS === "1" && !!process.env.MONGODB_URI;
const center = { lat: 12.915356916409525, lng: 77.64286120026878 };
const MIN = 60_000;

describe.skipIf(!RUN)("flag consistency (integration)", () => {
  let service: typeof import("@/lib/attendance-service");
  let models: typeof import("@/models");
  let disconnectDB: typeof import("@/lib/db").disconnectDB;

  const companyId = new Types.ObjectId();
  let siteId: Types.ObjectId;

  beforeAll(async () => {
    service = await import("@/lib/attendance-service");
    models = await import("@/models");
    const db = await import("@/lib/db");
    disconnectDB = db.disconnectDB;
    await db.connectDB();

    const site = await models.WorkSite.create({
      companyId,
      name: "Flag Site",
      location: { type: "Point", coordinates: [center.lng, center.lat] },
      radiusMeters: 50,
      isActive: true,
    });
    siteId = site._id;
  }, 120_000);

  afterAll(async () => {
    for (const m of [
      models.LocationPing,
      models.AttendanceSession,
      models.AttendanceDay,
      models.AttendanceEvent,
      models.GeofenceEvent,
      models.OutsideSiteLog,
      models.EmployeeSiteAssignment,
      models.WorkSite,
    ]) {
      await (m as any).deleteMany({ companyId });
    }
    await disconnectDB();
  }, 120_000);

  async function newEmployee() {
    const employeeId = new Types.ObjectId();
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId,
      siteId,
      isActive: true,
      isPrimary: true,
    });
    await giveOpenEndedSchedule(models, { companyId, employeeId: employeeId, siteId });
    return employeeId;
  }

  const at = (base: number, min: number) => new Date(base + min * MIN).toISOString();

  it("keeps the flag when the employee checks in again after a break", async () => {
    const employeeId = await newEmployee();
    const base = Date.now() - 300 * MIN;

    // Session 1: one hour on the clock with only the check-in ping, so almost
    // all of it is offline -> the day is legitimately flagged.
    await service.processCheckIn({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "flag-1",
      capturedAt: at(base, 0),
    });
    await service.processCheckOut({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      capturedAt: at(base, 60),
    });

    let day: any = await models.AttendanceDay.findOne({ employeeId }).lean();
    expect(day.flagReasons).toContain("excessive_offline_time");
    expect(day.isFlagged).toBe(true); // correct so far

    // Session 2: the employee simply checks in again after a break.
    await service.processCheckIn({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "flag-1",
      capturedAt: at(base, 90),
    });

    day = await models.AttendanceDay.findOne({ employeeId }).lean();

    // WAS: processCheckIn did `$set: { isFlagged: false }` unconditionally on
    // the day upsert, so the second check-in of a day (i.e. after any lunch
    // break) wiped a flag raised that morning while leaving the reason behind.
    // Admin reports read isFlagged, so the day silently left the flagged list.
    expect(day.flagReasons).toContain("excessive_offline_time");
    expect(day.isFlagged, "isFlagged must not contradict flagReasons").toBe(true);
  }, 120_000);

  it("clears the flag once only benign audit markers remain", async () => {
    const employeeId = await newEmployee();
    const base = Date.now() - 200 * MIN;

    await service.processCheckIn({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "flag-2",
      capturedAt: at(base, 0),
    });

    // Reachable state: an auto-close has stamped a benign marker on the day, and
    // an earlier rollup flagged it. Both live in the same flagReasons array.
    const dayId = (await models.AttendanceSession.findOne({ employeeId }).lean())!
      .attendanceDayId;
    await models.AttendanceDay.updateOne(
      { _id: dayId },
      {
        $set: {
          isFlagged: true,
          flagReasons: ["auto_checkout_shift_ended", "excessive_outside_time"],
        },
      }
    );

    // Now close the session cleanly: the employee never left the fence, so
    // excessive_outside_time no longer holds and the day should come back clean.
    await service.processCheckOut({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      capturedAt: at(base, 20),
    });

    const day: any = await models.AttendanceDay.findById(dayId).lean();

    // The reason IS correctly removed...
    expect(day.flagReasons).not.toContain("excessive_outside_time");

    // WAS: isFlagged was only cleared when the reasons array was EMPTY, and the
    // benign "auto_checkout_shift_ended" marker shares that array — so any day
    // that had ever auto-closed stayed flagged forever with nothing to justify
    // it. isFlagged is now derived from the REAL flags only.
    const realFlags = (day.flagReasons || []).filter((r: string) =>
      r.startsWith("excessive_") || r.includes("mock") || r === "impossible_speed"
    );
    expect(realFlags).toHaveLength(0);
    expect(day.isFlagged, "flagged with no flag reason left").toBe(false);
  }, 120_000);
});
