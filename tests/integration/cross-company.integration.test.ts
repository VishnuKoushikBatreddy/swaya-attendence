/**
 * DB-backed cross-company isolation tests. OPT-IN: only run with RUN_DB_TESTS=1
 * against a THROWAWAY database. See tests/integration/seed.ts.
 *
 *   RUN_DB_TESTS=1 MONGODB_URI="mongodb://localhost:27017" \
 *     MONGODB_DB_NAME="attendance_test" npx vitest run tests/integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const RUN = process.env.RUN_DB_TESTS === "1" && !!process.env.MONGODB_URI;

describe.skipIf(!RUN)("cross-company isolation (integration)", () => {
  let seed: typeof import("./seed");
  let models: typeof import("@/models");
  let service: typeof import("@/lib/attendance-service");
  let disconnectDB: typeof import("@/lib/db").disconnectDB;
  let data: Awaited<ReturnType<typeof import("./seed").seedTwoCompanies>>;

  beforeAll(async () => {
    seed = await import("./seed");
    models = await import("@/models");
    service = await import("@/lib/attendance-service");
    const db = await import("@/lib/db");
    disconnectDB = db.disconnectDB;

    // See the note in check-in.integration.test.ts: without an explicit connect,
    // every model call buffers until it times out.
    await db.connectDB();
    data = await seed.seedTwoCompanies();
  });

  afterAll(async () => {
    await seed.cleanupCompanies([data.a.companyId, data.b.companyId]);
    await service; // keep ref
    await disconnectDB();
  });

  it("an employee of company A cannot check into company B's geofence", async () => {
    // Stand exactly on company B's site, but as company A's employee.
    const res = await service.processCheckIn({
      employeeId: String(data.a.employeeId),
      companyId: String(data.a.companyId),
      timezone: "Asia/Kolkata",
      lat: data.b.center.lat,
      lng: data.b.center.lng,
      accuracyMeters: 5,
      deviceId: "x-co",
    });
    // The property under test is ISOLATION: the check-in is refused and no
    // session exists against company B. The exact reason depends on the
    // employee's own assignments — here they hold one for company A's site, so
    // standing on B's site rejects as "outside_geofence" rather than
    // "no_assignment". Asserting the reason string made this a test of an
    // implementation detail; asserting no cross-company session tests the
    // security boundary itself.
    expect(res.ok).toBe(false);
    expect(["no_assignment", "outside_geofence"]).toContain(
      (res as { reason: string }).reason
    );
    const leaked = await models.AttendanceSession.countDocuments({
      employeeId: data.a.employeeId,
      siteId: data.b.siteId,
    });
    expect(leaked).toBe(0);
    const anyInB = await models.AttendanceSession.countDocuments({
      companyId: data.b.companyId,
      employeeId: data.a.employeeId,
    });
    expect(anyInB).toBe(0);
  });

  it("IDOR: company A cannot mutate company B's site via a company-scoped update", async () => {
    const updated = await models.WorkSite.findOneAndUpdate(
      { _id: data.b.siteId, companyId: data.a.companyId },
      { $set: { name: "HIJACKED" } },
      { new: true }
    );
    expect(updated).toBeNull();
    const stillB = await models.WorkSite.findById(data.b.siteId).lean();
    expect(stillB.name).not.toBe("HIJACKED");
  });

  it("company A's site list never includes company B's sites", async () => {
    const aSites = await models.WorkSite.find({
      companyId: data.a.companyId,
      isActive: true,
    }).lean();
    const ids = aSites.map((s: { _id: unknown }) => String(s._id));
    expect(ids).toContain(String(data.a.siteId));
    expect(ids).not.toContain(String(data.b.siteId));
  });
});
