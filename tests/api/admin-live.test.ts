/**
 * /api/admin/live — the first endpoint to expose "is this person checked in
 * right now" to an admin.
 *
 * The distinction that matters: checked-in comes from an OPEN AttendanceSession
 * (status active | flagged), not from AttendanceDay.status, which stays
 * "present"/"late" long after someone has checked out.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: null as any,
  users: [] as any[],
  openSessions: [] as any[],
  days: [] as any[],
  pings: [] as any[],
  sites: [] as any[],
  capturedUserFilter: null as any,
  capturedSessionFilter: null as any,
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/company", () => ({ getCompanyTimezone: async () => "Asia/Kolkata" }));
vi.mock("@/lib/api-helpers", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    requireRole: async (allowed: string[]) => {
      if (!h.session) throw new actual.ApiError("Unauthenticated", 401);
      if (!allowed.includes(h.session.user.role)) throw new actual.ApiError("Forbidden", 403);
      return h.session;
    },
  };
});

vi.mock("@/models", () => {
  const chain = (resolve: () => any): any => {
    const c: any = { sort: () => c, select: () => c, lean: async () => resolve() };
    return c;
  };
  return {
    User: {
      find: vi.fn((f: any) => {
        h.capturedUserFilter = f;
        return chain(() => h.users);
      }),
    },
    AttendanceSession: {
      find: vi.fn((f: any) => {
        h.capturedSessionFilter = f;
        return chain(() => h.openSessions);
      }),
    },
    AttendanceDay: { find: vi.fn(() => chain(() => h.days)) },
    LocationPing: { aggregate: vi.fn(async () => h.pings) },
    WorkSite: { find: vi.fn(() => chain(() => h.sites)) },
  };
});

import { GET as live } from "@/app/api/admin/live/route";

const CO = "650000000000000000000099";
const ADMIN = "650000000000000000000001";
const EMP_A = "650000000000000000000011";
const EMP_B = "650000000000000000000012";
const SESSION_A = "650000000000000000000021";
const SITE = "650000000000000000000031";

const req = () => ({ url: "http://localhost/api/admin/live" }) as any;
const body = async (res: Response) => (await res.json()).data;

beforeEach(() => {
  h.session = { user: { id: ADMIN, companyId: CO, role: "admin" } };
  h.users = [
    { _id: EMP_A, fullName: "Alice", email: "a@x.com", employeeCode: "E1", role: "employee" },
    { _id: EMP_B, fullName: "Bob", email: "b@x.com", employeeCode: "E2", role: "employee" },
  ];
  h.openSessions = [];
  h.days = [];
  h.pings = [];
  h.sites = [];
  h.capturedUserFilter = null;
  h.capturedSessionFilter = null;
  vi.clearAllMocks();
});

describe("GET /api/admin/live", () => {
  it("401 when unauthenticated", async () => {
    h.session = null;
    expect((await live(req())).status).toBe(401);
  });

  it("403 for an employee", async () => {
    h.session = { user: { id: EMP_A, companyId: CO, role: "employee" } };
    expect((await live(req())).status).toBe(403);
  });

  it("reports nobody checked in when there are no open sessions", async () => {
    const d = await body(await live(req()));
    expect(d.summary).toMatchObject({ total: 2, checkedIn: 0 });
    expect(d.employees.every((e: any) => e.checkedIn === false)).toBe(true);
  });

  it("marks exactly the employee with an open session as checked in", async () => {
    h.openSessions = [
      {
        _id: SESSION_A,
        employeeId: EMP_A,
        siteId: SITE,
        checkInAt: "2026-08-17T09:00:00.000Z",
        status: "active",
        geofence: { lat: 12.97, lng: 77.59, radiusMeters: 100 },
      },
    ];
    h.sites = [{ _id: SITE, name: "Main Office", radiusMeters: 100, location: { coordinates: [77.59, 12.97] } }];

    const d = await body(await live(req()));
    const alice = d.employees.find((e: any) => e.id === EMP_A);
    const bob = d.employees.find((e: any) => e.id === EMP_B);

    expect(alice.checkedIn).toBe(true);
    expect(alice.siteName).toBe("Main Office");
    expect(alice.checkedInAt).toBe("2026-08-17T09:00:00.000Z");
    expect(bob.checkedIn).toBe(false);
    expect(d.summary.checkedIn).toBe(1);
  });

  it("does NOT infer checked-in from the day status alone", async () => {
    // Present for the day but already checked out — no open session.
    h.days = [{ employeeId: EMP_A, status: "present", totalWorkSeconds: 3600, isFlagged: false }];
    const d = await body(await live(req()));
    const alice = d.employees.find((e: any) => e.id === EMP_A);
    expect(alice.dayStatus).toBe("present");
    expect(alice.checkedIn).toBe(false);
    expect(d.summary.checkedIn).toBe(0);
  });

  it("computes distance from the frozen geofence and flags being away", async () => {
    h.openSessions = [
      {
        _id: SESSION_A,
        employeeId: EMP_A,
        siteId: SITE,
        checkInAt: "2026-08-17T09:00:00.000Z",
        status: "active",
        geofence: { lat: 12.97, lng: 77.59, radiusMeters: 100 },
      },
    ];
    h.pings = [
      {
        _id: SESSION_A,
        capturedAt: new Date().toISOString(),
        // ~0.01 degrees of latitude ≈ 1.1 km north.
        location: { coordinates: [77.59, 12.98] },
        isInsideGeofence: false,
      },
    ];

    const d = await body(await live(req()));
    const alice = d.employees.find((e: any) => e.id === EMP_A);
    expect(alice.isInsideGeofence).toBe(false);
    expect(alice.distanceFromSiteMeters).toBeGreaterThan(900);
    expect(d.summary.outsideGeofence).toBe(1);
  });

  it("scopes every lookup to the caller's company", async () => {
    await live(req());
    expect(String(h.capturedUserFilter.companyId)).toBe(CO);
    expect(String(h.capturedSessionFilter.companyId)).toBe(CO);
    expect(h.capturedSessionFilter.status.$in).toEqual(["active", "flagged"]);
  });


  it("scopes to the whole company for an admin", async () => {
    // The app has only admin and employee roles — there is no team sub-scoping.
    await live(req());
    expect(String(h.capturedUserFilter.companyId)).toBe(CO);
    expect(h.capturedUserFilter.isActive).toBe(true);
  });
});
