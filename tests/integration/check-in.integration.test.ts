/**
 * DB-backed integration tests for the check-in flow.
 *
 * These are OPT-IN: they only run when RUN_DB_TESTS=1 and MONGODB_URI point at a
 * THROWAWAY database (they create and delete documents). Run with, e.g.:
 *
 *   RUN_DB_TESTS=1 MONGODB_URI="mongodb://localhost:27017" \
 *     MONGODB_DB_NAME="attendance_test" npx vitest run tests/integration
 *
 * Without RUN_DB_TESTS the whole file is skipped so the default suite stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Types } from "mongoose";

const RUN = process.env.RUN_DB_TESTS === "1" && !!process.env.MONGODB_URI;

const center = { lat: 12.915356916409525, lng: 77.64286120026878 };

describe.skipIf(!RUN)("processCheckIn (integration)", () => {
  let processCheckIn: typeof import("@/lib/attendance-service").processCheckIn;
  let models: typeof import("@/models");
  let disconnectDB: typeof import("@/lib/db").disconnectDB;

  const companyId = new Types.ObjectId();
  const otherCompanyId = new Types.ObjectId();
  const employeeId = new Types.ObjectId();
  let siteId: Types.ObjectId;

  beforeAll(async () => {
    ({ processCheckIn } = await import("@/lib/attendance-service"));
    models = await import("@/models");
    const db = await import("@/lib/db");
    disconnectDB = db.disconnectDB;

    // MUST connect before touching a model. Without this every operation sits in
    // Mongoose's buffer until it times out — which is what these tests did, silently,
    // because they are skipped unless RUN_DB_TESTS=1.
    await db.connectDB();

    const site = await models.WorkSite.create({
      companyId,
      name: "Test Site",
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
    });
  });

  afterAll(async () => {
    // Clean up everything we created, scoped to the test companies only.
    const ids = { companyId: { $in: [companyId, otherCompanyId] } };
    await Promise.all([
      models.WorkSite.deleteMany(ids),
      models.EmployeeSiteAssignment.deleteMany(ids),
      models.AttendanceSession.deleteMany(ids),
      models.AttendanceDay.deleteMany(ids),
      models.LocationPing.deleteMany(ids),
      models.GeofenceEvent.deleteMany(ids),
      // The check-in flow also writes the audit ledger and outside-site logs;
      // omitting them left rows behind in the test database on every run.
      models.AttendanceEvent.deleteMany(ids),
      models.OutsideSiteLog.deleteMany(ids),
    ]);
    await disconnectDB();
  });

  it("succeeds for a first check-in inside the geofence", async () => {
    const res = await processCheckIn({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "dev-int-1",
    });
    expect(res.ok).toBe(true);
  });

  it("BUG 1 GUARD: a second check-in while already checked in is rejected", async () => {
    const res = await processCheckIn({
      employeeId: String(employeeId),
      companyId: String(companyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "dev-int-1",
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("already_checked_in");

    // And there must be exactly ONE open session, not two.
    const open = await models.AttendanceSession.countDocuments({
      employeeId,
      status: { $in: ["active", "flagged"] },
    });
    expect(open).toBe(1);
  });

  it("ISOLATION: an employee cannot check into another company's site", async () => {
    // Same coordinates, but the site belongs to a different company and the
    // employee has no assignment to it -> no assignment found.
    const otherEmployee = new Types.ObjectId();
    await models.WorkSite.create({
      companyId: otherCompanyId,
      name: "Other Co Site",
      location: { type: "Point", coordinates: [center.lng, center.lat] },
      radiusMeters: 50,
      isActive: true,
    });
    const res = await processCheckIn({
      employeeId: String(otherEmployee),
      companyId: String(otherCompanyId),
      timezone: "Asia/Kolkata",
      lat: center.lat,
      lng: center.lng,
      accuracyMeters: 5,
      deviceId: "dev-int-2",
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("no_assignment");
  });
});
