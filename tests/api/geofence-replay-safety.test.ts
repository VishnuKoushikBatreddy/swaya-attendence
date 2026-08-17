/**
 * Replay safety for queued geofence events.
 *
 * The Android retry queue means an EXIT/ENTER can now arrive long after the
 * moment it describes — something that was impossible when failed uploads were
 * discarded. A replayed event must never be applied to state that came into
 * existence AFTER the event happened.
 *
 * The case that motivated these tests: employee leaves at 09:00 (EXIT queued
 * offline), returns and checks in at 10:00, the EXIT then flushes at 10:05. With
 * no time constraint it closes the 10:00 session back-dated to 09:00, which
 * clampCheckOut pins to the check-in instant — a zero-length session and an
 * employee silently checked out again.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const T09 = new Date("2026-08-17T09:00:00.000Z");
const T10 = new Date("2026-08-17T10:00:00.000Z");

const state = vi.hoisted(() => ({
  sessions: [] as any[],
  capturedFilter: null as any,
  finalized: [] as any[],
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/company", () => ({ getCompanyTimezone: async () => "UTC" }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({})) }));

vi.mock("@/models", () => {
  const chain = (resolve: () => any): any => {
    const c: any = {
      sort: () => c,
      select: () => c,
      lean: async () => resolve(),
      then: (r: any) => Promise.resolve(resolve()).then(r),
    };
    return c;
  };

  const inRange = (value: any, range: any) => {
    if (value == null) return false;
    const t = new Date(value).getTime();
    if (range?.$lte != null && t > new Date(range.$lte).getTime()) return false;
    if (range?.$gte != null && t < new Date(range.$gte).getTime()) return false;
    return true;
  };

  /** Honours status $in, checkInAt/checkOutAt ranges and a top-level $or. */
  const matchSessions = (f: any) =>
    state.sessions.filter((s) => {
      if (f?.status?.$in && !f.status.$in.includes(s.status)) return false;
      if (f?.checkInAt && !inRange(s.checkInAt, f.checkInAt)) return false;
      if (f?.checkOutAt && !inRange(s.checkOutAt, f.checkOutAt)) return false;
      if (Array.isArray(f?.$or)) {
        const any = f.$or.some((clause: any) => {
          if (clause.checkInAt) return inRange(s.checkInAt, clause.checkInAt);
          if (clause.checkOutAt) return inRange(s.checkOutAt, clause.checkOutAt);
          return false;
        });
        if (!any) return false;
      }
      return true;
    });

  return {
    AttendanceSession: {
      findOne: vi.fn((f: any) => {
        state.capturedFilter = f;
        return chain(() => matchSessions(f)[0] ?? null);
      }),
      find: vi.fn(() => chain(() => [])),
      countDocuments: vi.fn(async () => 1),
    },
    AttendanceDay: {
      findById: vi.fn(() => chain(() => null)),
      findOne: vi.fn(() => chain(() => null)),
      findOneAndUpdate: vi.fn(() => chain(() => ({ _id: "day1" }))),
      findByIdAndUpdate: vi.fn(() => chain(() => null)),
    },
    LocationPing: {
      find: vi.fn(() => chain(() => [])),
      findOne: vi.fn(() => chain(() => null)),
      create: vi.fn(async () => ({})),
    },
    OutsideSiteLog: { updateMany: vi.fn(async () => ({})), findOne: vi.fn(() => chain(() => null)) },
    AttendanceEvent: { create: vi.fn(async () => ({})) },
    WorkSite: { findById: vi.fn(() => chain(() => null)), find: vi.fn(() => chain(() => [])) },
    User: { find: vi.fn(() => chain(() => [])), findById: vi.fn(() => chain(() => null)) },
    EmployeeSiteAssignment: { find: vi.fn(() => chain(() => [])) },
    EmployeeSchedule: { findOne: vi.fn(() => chain(() => null)), findById: vi.fn(() => chain(() => null)) },
    GeofenceEvent: { create: vi.fn(async () => ({})) },
    ShiftTemplate: { findById: vi.fn(() => chain(() => null)) },
  };
});

import { processGeofenceExit, processGeofenceEnter } from "@/lib/attendance-service";

const EMP = "650000000000000000000001";
const CO = "650000000000000000000099";

const mkSession = (id: string, checkInAt: Date) => ({
  _id: id,
  attendanceDayId: "day1",
  employeeId: EMP,
  companyId: CO,
  siteId: "site1",
  checkInAt,
  geofence: { lat: 12.97, lng: 77.59, radiusMeters: 100 },
  checkInLocation: { coordinates: [77.59, 12.97] },
  status: "active",
  save: vi.fn(async function (this: any) {
    state.finalized.push({ id: this._id, checkOutAt: this.checkOutAt });
    return this;
  }),
});

beforeEach(() => {
  state.sessions = [];
  state.capturedFilter = null;
  state.finalized = [];
  vi.clearAllMocks();
});

describe("processGeofenceExit — replay safety", () => {
  it("does NOT close a session that started after the exit happened", async () => {
    // Employee left at 09:00 (event queued offline), then checked in again at
    // 10:00. The queued EXIT flushes now.
    state.sessions = [mkSession("session-10am", T10)];

    const res = await processGeofenceExit({
      employeeId: EMP,
      companyId: CO,
      lat: 12.97,
      lng: 77.59,
      capturedAt: T09.toISOString(),
    });

    expect(res.ok).toBe(false);
    expect(state.finalized).toEqual([]); // the 10:00 session must survive
  });

  it("still closes a session that was genuinely open at the exit time", async () => {
    // Session opened 08:00, exit at 09:00 — the normal late-delivery case.
    state.sessions = [mkSession("session-8am", new Date("2026-08-17T08:00:00.000Z"))];

    const res = await processGeofenceExit({
      employeeId: EMP,
      companyId: CO,
      lat: 12.97,
      lng: 77.59,
      capturedAt: T09.toISOString(),
    });

    expect(res.ok).toBe(true);
    expect(state.finalized).toHaveLength(1);
    expect(state.finalized[0].id).toBe("session-8am");
    // Back-dated to when they actually left, not to now.
    expect(new Date(state.finalized[0].checkOutAt).toISOString()).toBe(T09.toISOString());
  });

  it("constrains the lookup by check-in time", async () => {
    state.sessions = [mkSession("s", T10)];
    await processGeofenceExit({
      employeeId: EMP,
      companyId: CO,
      lat: 12.97,
      lng: 77.59,
      capturedAt: T09.toISOString(),
    });
    expect(state.capturedFilter?.checkInAt?.$lte).toBeDefined();
  });

  it("is unaffected when no capturedAt is supplied (live event)", async () => {
    state.sessions = [mkSession("s-live", new Date(Date.now() - 3600_000))];
    const res = await processGeofenceExit({
      employeeId: EMP,
      companyId: CO,
      lat: 12.97,
      lng: 77.59,
    });
    expect(res.ok).toBe(true);
    expect(state.finalized).toHaveLength(1);
  });
});

describe("processGeofenceEnter — replay safety", () => {
  const enter = (capturedAt?: string) =>
    processGeofenceEnter({
      employeeId: EMP,
      companyId: CO,
      lat: 12.97,
      lng: 77.59,
      ...(capturedAt ? { capturedAt } : {}),
    });

  it("does NOT re-open a session for a stretch the employee already worked", async () => {
    // Worked 10:00–14:00 and checked out normally; the ENTER from 10:00 only
    // now flushes. Replaying it would add a second, overlapping session and
    // computeDayTotals would count that stretch twice.
    state.sessions = [
      { ...mkSession("worked", T10), checkOutAt: new Date("2026-08-17T14:00:00.000Z"), status: "completed" },
    ];

    const res: any = await enter(T10.toISOString());

    expect(res.superseded).toBe(true);
    // Never reached the check-in path.
    expect(res.reason).toBeUndefined();
  });

  it("does NOT replay an ENTER that a later session already supersedes", async () => {
    state.sessions = [
      { ...mkSession("later", T10), checkOutAt: null, status: "completed" },
    ];
    const res: any = await enter(T09.toISOString());
    expect(res.superseded).toBe(true);
  });

  it("defers to an already-open session rather than opening another", async () => {
    state.sessions = [mkSession("open", T09)];
    const res: any = await enter(T10.toISOString());
    expect(res.alreadyActive).toBe(true);
  });

  it("still processes an ENTER when nothing supersedes it", async () => {
    // No prior sessions at all — the genuine offline-reconstruction case. It
    // proceeds into processCheckIn (which fails on assignment lookup here, and
    // that is fine: the point is that the replay guard did not block it).
    state.sessions = [];
    const res: any = await enter(T09.toISOString());
    expect(res.superseded).toBeUndefined();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_assignment");
  });
});
