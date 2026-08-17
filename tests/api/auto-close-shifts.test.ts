/**
 * autoCloseEndedShifts: which sessions get auto-closed, and how many queries it
 * takes to decide. The shift-end lookup is batched, so the decision cost must
 * stay constant (one AttendanceDay query + one EmployeeSchedule query) no matter
 * how many sessions are open — previously it was two queries per session.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const PAST = new Date(Date.now() - 60 * 60 * 1000); // shift ended an hour ago
const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // shift ends in an hour

const state = vi.hoisted(() => ({
  sessions: [] as any[],
  days: [] as any[],
  schedules: [] as any[],
  calls: { dayFind: 0, scheduleFind: 0, dayFindById: 0, scheduleFindOne: 0 },
  finalizedSessionIds: [] as string[],
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/company", () => ({ getCompanyTimezone: async () => "UTC" }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({})) }));

vi.mock("@/models", () => {
  const chain = (resolve: () => any): any => {
    const c: any = {
      sort: () => c,
      limit: () => c,
      select: () => c,
      lean: async () => resolve(),
      then: (r: any) => Promise.resolve(resolve()).then(r), // awaitable without .lean()
    };
    return c;
  };
  return {
    AttendanceSession: {
      find: vi.fn((f: any) => {
        // The open-session sweep vs. the per-day rollup inside finalizeSession.
        if (f?.attendanceDayId) return chain(() => []);
        return chain(() => state.sessions);
      }),
      countDocuments: vi.fn(async () => 1),
    },
    AttendanceDay: {
      find: vi.fn(() => {
        state.calls.dayFind++;
        return chain(() => state.days);
      }),
      findById: vi.fn((id: any) => {
        state.calls.dayFindById++;
        return chain(() => state.days.find((d) => String(d._id) === String(id)) ?? null);
      }),
    },
    EmployeeSchedule: {
      find: vi.fn(() => {
        state.calls.scheduleFind++;
        return chain(() => state.schedules);
      }),
      // Resolves real data (not a null stub) so this mock is a faithful stand-in
      // for either lookup strategy — batched find() or per-session findOne().
      findOne: vi.fn((f: any) => {
        state.calls.scheduleFindOne++;
        return chain(
          () =>
            state.schedules.find(
              (s) =>
                String(s.employeeId) === String(f?.employeeId) && s.workDate === f?.workDate
            ) ?? null
        );
      }),
    },
    LocationPing: {
      find: vi.fn(() => chain(() => [])),
      findOne: vi.fn(() => chain(() => null)),
    },
    OutsideSiteLog: { updateMany: vi.fn(async () => ({})) },
    AttendanceEvent: { create: vi.fn(async () => ({})) },
    WorkSite: { findById: vi.fn(() => chain(() => null)) },
    User: { find: vi.fn(() => chain(() => [])), findById: vi.fn(() => chain(() => null)) },
    EmployeeSiteAssignment: { find: vi.fn(() => chain(() => [])) },
    GeofenceEvent: { create: vi.fn(async () => ({})) },
    ShiftTemplate: { findById: vi.fn(() => chain(() => null)) },
  };
});

import { autoCloseEndedShifts } from "@/lib/attendance-service";

/** An open session wired so finalizeSession can run without a real DB. */
function mkSession(id: string, dayId: string, employeeId: string) {
  return {
    _id: id,
    attendanceDayId: dayId,
    employeeId,
    companyId: "c1",
    siteId: "s1",
    checkInAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
    // Frozen geofence center so finalizeSession skips the WorkSite lookup.
    geofence: { lat: 12.97, lng: 77.59, radiusMeters: 100 },
    checkInLocation: { coordinates: [77.59, 12.97] },
    status: "active",
    save: vi.fn(async function (this: any) {
      state.finalizedSessionIds.push(String(this._id));
      return this;
    }),
  };
}

const mkDay = (id: string, workDate: string) => ({
  _id: id,
  workDate,
  status: "pending",
  flagReasons: [],
  save: vi.fn(async () => ({})),
});

const mkSchedule = (employeeId: string, workDate: string, end: Date | null, working = true) => ({
  employeeId,
  workDate,
  isWorkingDay: working,
  expectedEndAt: end,
});

beforeEach(() => {
  state.sessions = [];
  state.days = [];
  state.schedules = [];
  state.calls = { dayFind: 0, scheduleFind: 0, dayFindById: 0, scheduleFindOne: 0 };
  state.finalizedSessionIds = [];
  vi.clearAllMocks();
});

describe("autoCloseEndedShifts", () => {
  it("closes only sessions whose scheduled shift end has passed", async () => {
    state.sessions = [mkSession("s-past", "d1", "e1"), mkSession("s-future", "d2", "e2")];
    state.days = [mkDay("d1", "2026-08-17"), mkDay("d2", "2026-08-17")];
    state.schedules = [
      mkSchedule("e1", "2026-08-17", PAST),
      mkSchedule("e2", "2026-08-17", FUTURE),
    ];

    const closed = await autoCloseEndedShifts();

    expect(closed).toBe(1);
    expect(state.finalizedSessionIds).toEqual(["s-past"]);
  });

  it("skips sessions with no schedule, a non-working day, or no shift end", async () => {
    state.sessions = [
      mkSession("s-no-schedule", "d1", "e1"),
      mkSession("s-day-off", "d2", "e2"),
      mkSession("s-open-ended", "d3", "e3"),
    ];
    state.days = [
      mkDay("d1", "2026-08-17"),
      mkDay("d2", "2026-08-17"),
      mkDay("d3", "2026-08-17"),
    ];
    state.schedules = [
      mkSchedule("e2", "2026-08-17", PAST, false), // scheduled day off
      mkSchedule("e3", "2026-08-17", null), // working but no end time
    ];

    expect(await autoCloseEndedShifts()).toBe(0);
    expect(state.finalizedSessionIds).toEqual([]);
  });

  it("skips a session whose AttendanceDay is missing", async () => {
    state.sessions = [mkSession("s-orphan", "missing-day", "e1")];
    state.days = [];
    state.schedules = [mkSchedule("e1", "2026-08-17", PAST)];

    expect(await autoCloseEndedShifts()).toBe(0);
  });

  it("uses a constant number of lookups regardless of how many sessions are open", async () => {
    const N = 40;
    state.sessions = Array.from({ length: N }, (_, i) => mkSession(`s${i}`, `d${i}`, `e${i}`));
    state.days = Array.from({ length: N }, (_, i) => mkDay(`d${i}`, "2026-08-17"));
    // All end in the future -> nothing closes, so this measures decision cost only.
    state.schedules = Array.from({ length: N }, (_, i) =>
      mkSchedule(`e${i}`, "2026-08-17", FUTURE)
    );

    expect(await autoCloseEndedShifts()).toBe(0);

    // Batched: one query for all days, one for all schedules.
    expect(state.calls.dayFind).toBe(1);
    expect(state.calls.scheduleFind).toBe(1);
    // And crucially NOT the old per-session lookups.
    expect(state.calls.dayFindById).toBe(0);
    expect(state.calls.scheduleFindOne).toBe(0);
  });
});
