/**
 * DB-backed end-to-end check of the work/outside/break time accounting.
 *
 * The pure maths is unit-tested in time-accounting-fixes.test.ts. This exercises
 * the WIRING that unit tests cannot: that recomputeDayTotals passes the trust
 * window through, that the new AttendanceDay fields are actually persisted, and
 * that resolveDayStatus is applied on finalize.
 *
 * OPT-IN, same as the other integration tests:
 *   RUN_DB_TESTS=1 MONGODB_URI=... MONGODB_DB_NAME=attendance_ci \
 *     npx vitest run tests/integration --hookTimeout=120000
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Types } from "mongoose";

const RUN = process.env.RUN_DB_TESTS === "1" && !!process.env.MONGODB_URI;
const center = { lat: 12.915356916409525, lng: 77.64286120026878 };
/** A point far outside the 50m site radius (~1.1km north). */
const away = { lat: center.lat + 0.01, lng: center.lng };

const MIN = 60_000;

describe.skipIf(!RUN)("time accounting (integration)", () => {
  let service: typeof import("@/lib/attendance-service");
  let models: typeof import("@/models");
  let disconnectDB: typeof import("@/lib/db").disconnectDB;

  const companyId = new Types.ObjectId();
  const employeeId = new Types.ObjectId();
  let siteId: Types.ObjectId;

  // Back-date the whole scenario so it never collides with "now".
  const T0 = Date.now() - 6 * 60 * MIN;
  const iso = (offsetMin: number) => new Date(T0 + offsetMin * MIN).toISOString();

  beforeAll(async () => {
    service = await import("@/lib/attendance-service");
    models = await import("@/models");
    const db = await import("@/lib/db");
    disconnectDB = db.disconnectDB;
    await db.connectDB();

    const site = await models.WorkSite.create({
      companyId,
      name: "Accounting Site",
      location: { type: "Point", coordinates: [center.lng, center.lat] },
      radiusMeters: 50,
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

  it("persists work/inside/outside/break/unaccounted through a full lifecycle", async () => {
    // Check in at T0, inside the fence.
    const checkIn = await service.processCheckIn({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "acct-1",
      capturedAt: iso(0),
    });
    expect(checkIn.ok).toBe(true);

    // Inside, then a BRIEF excursion, then back inside. Only two consecutive
    // away pings, staying under AUTO_CHECKOUT_CONSECUTIVE_PINGS (3) so the
    // sustained-absence rule does not close the session — otherwise the employee
    // is off the clock from the moment they leave and no on-clock outside time
    // can accrue, which is exactly what a longer absence should do.
    const pings = [];
    for (let m = 3; m <= 15; m += 3) {
      pings.push({ lat: center.lat, lng: center.lng, accuracyMeters: 5, capturedAt: iso(m) });
    }
    for (const m of [18, 21]) {
      pings.push({ lat: away.lat, lng: away.lng, accuracyMeters: 5, capturedAt: iso(m) });
    }
    for (let m = 24; m <= 30; m += 3) {
      pings.push({ lat: center.lat, lng: center.lng, accuracyMeters: 5, capturedAt: iso(m) });
    }
    await service.processPings({
      employeeId: String(employeeId),
      companyId: String(companyId),
      pings,
    });

    // The sustained-absence rule may already have closed the session (3 pings
    // beyond radius+buffer). Close it explicitly only if it is still open.
    const stillOpen = await models.AttendanceSession.findOne({
      employeeId,
      status: { $in: ["active", "flagged"] },
    }).lean();
    if (stillOpen) {
      await service.processCheckOut({
        employeeId: String(employeeId),
        companyId: String(companyId),
        timezone: "Asia/Kolkata",
        lat: center.lat,
        lng: center.lng,
        accuracyMeters: 5,
        capturedAt: iso(30),
      });
    }

    const day: any = await models.AttendanceDay.findOne({ employeeId }).lean();
    expect(day).toBeTruthy();

    // The new fields must actually exist on the persisted document — this is the
    // wiring the unit tests cannot prove.
    expect(day.totalBreakSeconds).toBeDefined();
    expect(day.breakCount).toBeDefined();
    expect(day.totalUnaccountedSeconds).toBeDefined();

    // Single continuous session, so no break.
    expect(day.totalBreakSeconds).toBe(0);
    expect(day.breakCount).toBe(0);

    // Outside time was recorded despite there being no mid-day check-out — the
    // loophole that used to discard it.
    expect(day.totalOutsideSeconds).toBeGreaterThan(0);

    // Totals reconcile: work = inside + outside + unaccounted.
    expect(
      day.totalInsideSeconds + day.totalOutsideSeconds + day.totalUnaccountedSeconds
    ).toBe(day.totalWorkSeconds);

    // Nothing is invented: presence never exceeds the elapsed session.
    expect(day.totalInsideSeconds).toBeLessThanOrEqual(day.totalWorkSeconds);
  }, 120_000);

  it("does not credit a whole shift from a single check-in ping", async () => {
    // Fresh employee: check in, send NO pings, then close 4 hours later.
    const loneId = new Types.ObjectId();
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId: loneId,
      siteId,
      isActive: true,
      isPrimary: true,
    });

    const start = Date.now() - 5 * 60 * MIN;
    await service.processCheckIn({
      employeeId: String(loneId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "acct-2",
      capturedAt: new Date(start).toISOString(),
    });
    await service.processCheckOut({
      employeeId: String(loneId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      capturedAt: new Date(start + 4 * 60 * MIN).toISOString(),
    });

    const day: any = await models.AttendanceDay.findOne({ employeeId: loneId }).lean();
    expect(day.totalWorkSeconds).toBe(4 * 60 * 60);
    // Only the trust window is credited; the rest is reported as unknown.
    expect(day.totalInsideSeconds).toBeLessThan(20 * 60);
    expect(day.totalUnaccountedSeconds).toBeGreaterThan(3 * 60 * 60);

    await models.AttendanceDay.deleteMany({ employeeId: loneId });
    await models.AttendanceSession.deleteMany({ employeeId: loneId });
  }, 120_000);

  it("recomputes day status instead of latching it", async () => {
    const shortId = new Types.ObjectId();
    await models.EmployeeSiteAssignment.create({
      companyId,
      employeeId: shortId,
      siteId,
      isActive: true,
      isPrimary: true,
    });

    const base = Date.now() - 8 * 60 * MIN;
    const cycle = async (fromMin: number, toMin: number) => {
      await service.processCheckIn({
        employeeId: String(shortId),
        companyId: String(companyId),
        timezone: "Asia/Kolkata",
        lat: center.lat,
        lng: center.lng,
        accuracyMeters: 5,
        deviceId: "acct-3",
        capturedAt: new Date(base + fromMin * MIN).toISOString(),
      });
      await service.processCheckOut({
        employeeId: String(shortId),
        companyId: String(companyId),
        timezone: "Asia/Kolkata",
        lat: center.lat,
        lng: center.lng,
        accuracyMeters: 5,
        capturedAt: new Date(base + toMin * MIN).toISOString(),
      });
    };

    await cycle(0, 3 * 60); // 3h -> half_day
    let day: any = await models.AttendanceDay.findOne({ employeeId: shortId }).lean();
    expect(day.status).toBe("half_day");

    await cycle(3 * 60 + 30, 6 * 60 + 30); // +3h -> 6h total
    day = await models.AttendanceDay.findOne({ employeeId: shortId }).lean();
    // Previously latched at half_day forever, because the status test required
    // the day to still be "present".
    expect(day.totalWorkSeconds).toBeGreaterThanOrEqual(6 * 60 * 60);
    expect(day.status).toBe("present");
    // The 30-minute gap between the two sessions is a BREAK, not outside time.
    expect(day.totalBreakSeconds).toBe(30 * 60);
    expect(day.breakCount).toBe(1);

    await models.AttendanceDay.deleteMany({ employeeId: shortId });
    await models.AttendanceSession.deleteMany({ employeeId: shortId });
  }, 120_000);
});
