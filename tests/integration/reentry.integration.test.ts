/**
 * Leave and come back on the SAME day.
 *
 *   enter -> check in -> leave -> auto check-out (geofence EXIT) -> re-enter
 *
 * The re-entry has to get past processGeofenceEnter's replay guard, which
 * suppresses an ENTER that looks like a stale queued event. A guard that is too
 * eager would silently refuse to check the employee back in — they would be on
 * site, off the clock, with nothing on screen to say so.
 *
 *   RUN_DB_TESTS=1 MONGODB_URI=... MONGODB_DB_NAME=attendance_ci \
 *     npx vitest run tests/integration/reentry.integration.test.ts --hookTimeout=120000
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Types } from "mongoose";
import { giveOpenEndedSchedule } from "./schedule-helper";

const RUN = process.env.RUN_DB_TESTS === "1" && !!process.env.MONGODB_URI;
const center = { lat: 12.915356916409525, lng: 77.64286120026878 };
/** ~1.1 km north — well beyond the fence. */
const away = { lat: center.lat + 0.01, lng: center.lng };
const MIN = 60_000;

describe.skipIf(!RUN)("leave and re-enter (integration)", () => {
  let service: typeof import("@/lib/attendance-service");
  let models: typeof import("@/models");
  let disconnectDB: typeof import("@/lib/db").disconnectDB;

  const companyId = new Types.ObjectId();
  const employeeId = new Types.ObjectId();
  let siteId: Types.ObjectId;

  beforeAll(async () => {
    service = await import("@/lib/attendance-service");
    models = await import("@/models");
    const db = await import("@/lib/db");
    disconnectDB = db.disconnectDB;
    await db.connectDB();

    const site = await models.WorkSite.create({
      companyId,
      name: "Re-entry Site",
      location: { type: "Point", coordinates: [center.lng, center.lat] },
      radiusMeters: 175,
      isActive: true,
    });
    siteId = site._id;
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId,
      siteId,
      isActive: true,
      isPrimary: true,
    });
    await giveOpenEndedSchedule(models, { companyId, employeeId: employeeId, siteId });
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

  it("checks the employee back in when they return after an auto check-out", async () => {
    // No EmployeeSchedule is created for this employee, so the shift-hours gate
    // does not apply — this isolates the replay guard, which is what the
    // question is actually about.
    const base = Date.now() - 240 * MIN;
    const at = (min: number) => new Date(base + min * MIN).toISOString();

    // 1. Arrive and check in.
    const first = await service.processCheckIn({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "reentry-1",
      capturedAt: at(0),
    });
    expect(first.ok).toBe(true);

    // 2. Leave — the OS geofence EXIT auto-checks them out.
    const exit = await service.processGeofenceExit({
      employeeId: String(employeeId),
      companyId: String(companyId),
      lat: away.lat,
      lng: away.lng,
      accuracyMeters: 10,
      capturedAt: at(60),
    });
    expect(exit.ok, "geofence EXIT should have closed the session").toBe(true);

    const closed = await models.AttendanceSession.findOne({ employeeId }).lean();
    expect((closed as any).status).toBe("auto_closed");

    // 3. Come back an hour later — the OS fires ENTER.
    const reentry: any = await service.processGeofenceEnter({
      employeeId: String(employeeId),
      companyId: String(companyId),
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 8,
      capturedAt: at(120),
    });

    // The replay guard must NOT treat a genuine later return as a stale replay.
    expect(reentry.superseded, "genuine re-entry was rejected as a stale replay").toBeFalsy();
    expect(reentry.ok, "re-entry did not check the employee back in").toBe(true);

    // A SECOND, open session now exists, starting at the moment of return.
    const sessions = await models.AttendanceSession.find({ employeeId })
      .sort({ checkInAt: 1 })
      .lean();
    expect(sessions).toHaveLength(2);
    expect((sessions[1] as any).status).toMatch(/active|flagged/);
    expect(new Date((sessions[1] as any).checkInAt).toISOString()).toBe(at(120));

    // The STORED day totals are not refreshed by a check-in — only a check-out
    // or an incoming ping rolls them up — so the break is not on the document
    // yet. The dashboard does not read this stale copy: /api/attendance/today
    // recomputes live totals for an open session. Close the second session and
    // the gap is recorded as a BREAK (off the clock), not as outside time.
    await service.processCheckOut({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      capturedAt: at(180),
    });

    const day: any = await models.AttendanceDay.findOne({ employeeId }).lean();
    expect(day.breakCount).toBe(1);
    expect(day.totalBreakSeconds).toBe(60 * 60);
    expect(day.totalOutsideSeconds, "the off-clock gap must not count as outside").toBe(0);
  }, 120_000);

  it("never opens a SECOND session when two check-ins race", async () => {
    // The native geofence ENTER and the app's own auto check-in fired within the
    // same second in production and BOTH created a session, because
    // processCheckIn's "already checked in" guard is a read followed by a write
    // with nothing between them. That split one employee's pings across two
    // records. The one_open_session_per_employee partial unique index is what
    // actually holds the invariant, inside the database at insert time.
    const empId = new Types.ObjectId();
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId: empId,
      siteId,
      isActive: true,
      isPrimary: true,
    });
    await giveOpenEndedSchedule(models, { companyId, employeeId: empId, siteId });

    const base = Date.now() - 90 * MIN;
    const call = (min: number, device: string) =>
      service.processCheckIn({
        employeeId: String(empId),
        companyId: String(companyId),
        timezone: "Asia/Kolkata",
        lat: center.lat,
        lng: center.lng,
        accuracyMeters: 5,
        deviceId: device,
        capturedAt: new Date(base + min * MIN).toISOString(),
      });

    // Fire both at once, exactly as the two paths did.
    const [a, b] = await Promise.all([call(0, "geofence"), call(1, "web-abc")]);

    const ok = [a, b].filter((r) => r.ok);
    const refused = [a, b].filter((r) => !r.ok);
    expect(ok, "exactly one check-in may succeed").toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as any).reason).toBe("already_checked_in");

    const open = await models.AttendanceSession.countDocuments({
      employeeId: empId,
      status: { $in: ["active", "flagged"] },
    });
    expect(open, "employee ended up with more than one open session").toBe(1);
  }, 120_000);

  it("does not undo a MANUAL check-out when the geofence re-registers", async () => {
    // Seen in production: a manual check-out at 10:51:03 was followed by an
    // auto check-in at 10:51:14 — eleven seconds later, without the employee
    // going anywhere. GeofenceHelper registers with INITIAL_TRIGGER_ENTER, so
    // the OS fires ENTER the moment the geofence is (re-)registered whenever the
    // phone is already inside it. Every app relaunch replayed a check-in.
    //
    // evaluateAutoCheckIn already refused after a manual check-out; this path
    // did not, and the two disagreeing is what produced the loop.
    const empId = new Types.ObjectId();
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId: empId,
      siteId,
      isActive: true,
      isPrimary: true,
    });
    await giveOpenEndedSchedule(models, { companyId, employeeId: empId, siteId });

    const base = Date.now() - 120 * MIN;
    const at = (min: number) => new Date(base + min * MIN).toISOString();

    await service.processCheckIn({
      employeeId: String(empId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "manual-1",
      capturedAt: at(0),
    });
    // The employee deliberately checks out, still standing on site.
    await service.processCheckOut({
      employeeId: String(empId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      capturedAt: at(30),
    });
    const closed: any = await models.AttendanceSession.findOne({ employeeId: empId }).lean();
    expect(closed.status).toBe("completed"); // manual, not auto

    // The app relaunches; the geofence is registered and immediately fires
    // ENTER because the phone never left.
    const replay: any = await service.processGeofenceEnter({
      employeeId: String(empId),
      companyId: String(companyId),
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 8,
      capturedAt: at(30.2),
    });

    expect(replay.manualCheckout, "an INITIAL_TRIGGER ENTER undid a manual check-out").toBe(true);
    const open = await models.AttendanceSession.countDocuments({
      employeeId: empId,
      status: { $in: ["active", "flagged"] },
    });
    expect(open, "employee was put back on the clock after checking out").toBe(0);
  }, 120_000);

  it("refuses a check-in on a day with no shift scheduled", async () => {
    // Observed in production: an employee with nothing rostered for the day was
    // still able to check in. scheduleGate short-circuited with
    // `if (!schedule) return { ok: true }`, reading the absence of a record as
    // the absence of a rule — so rostering constrained nobody.
    //
    // Every other employee in this file deliberately has no schedule (to isolate
    // the replay logic), which is exactly why the gap went unnoticed here too.
    const empId = new Types.ObjectId();
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId: empId,
      siteId,
      isActive: true,
      isPrimary: true,
    });
    // Deliberately NO schedule — that is the whole point of this test.

    const result = await service.processCheckIn({
      employeeId: String(empId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "unscheduled-1",
      capturedAt: new Date().toISOString(),
    });

    expect(result.ok, "checked in on a day with no schedule").toBe(false);
    expect((result as { reason: string }).reason).toMatch(/no shift scheduled/i);
    expect(
      await models.AttendanceSession.countDocuments({ employeeId: empId })
    ).toBe(0);
  }, 120_000);

  it("ignores a STALE enter that predates the last check-out", async () => {
    // The opposite case the guard exists for: an ENTER queued on the device
    // before the employee left, flushed after the session already closed.
    // Replaying it would open a session back-dated into a finished stretch and
    // double-count the day.
    const empId = new Types.ObjectId();
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId: empId,
      siteId,
      isActive: true,
      isPrimary: true,
    });
    await giveOpenEndedSchedule(models, { companyId, employeeId: empId, siteId });

    const base = Date.now() - 200 * MIN;
    const at = (min: number) => new Date(base + min * MIN).toISOString();

    await service.processCheckIn({
      employeeId: String(empId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "reentry-2",
      capturedAt: at(0),
    });
    await service.processGeofenceExit({
      employeeId: String(empId),
      companyId: String(companyId),
      lat: away.lat,
      lng: away.lng,
      capturedAt: at(60),
    });

    // An ENTER captured at minute 30 — DURING the session that has since closed.
    const stale: any = await service.processGeofenceEnter({
      employeeId: String(empId),
      companyId: String(companyId),
      lat: center.lat,
      lng: center.lng,
      capturedAt: at(30),
    });
    expect(stale.superseded, "a stale ENTER must not open a session").toBe(true);
    expect(await models.AttendanceSession.countDocuments({ employeeId: empId })).toBe(1);
  }, 120_000);
});
