/**
 * Cron cadence vs offline detection.
 *
 * notifyOfflineEmployees skips sessions whose scheduled shift end has passed
 * (silence after the shift is expected, not a fault). That is correct on its
 * own, but it makes the SCHEDULE part of the feature: on the original daily
 * "0 2 * * *" cron the sweep always ran after every shift had finished, so the
 * alert could never fire for an ordinary day shift.
 *
 * This pins the relationship. It reads the real schedule out of vercel.json, so
 * lengthening the interval past the point where alerts stop working fails here.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";

const MIN = 60_000;
const HOUR = 60 * MIN;

// A concrete day, in UTC. The company runs 10:00-17:00 IST = 04:30-11:30 UTC.
const SHIFT_START = Date.parse("2026-09-01T04:30:00Z");
const SHIFT_END = Date.parse("2026-09-01T11:30:00Z");
// The phone dies mid-shift, at 11:00 IST / 05:30 UTC.
const PHONE_DIED = Date.parse("2026-09-01T05:30:00Z");
// The next time the cron actually runs, per vercel.json "0 2 * * *".
const NEXT_CRON = Date.parse("2026-09-02T02:00:00Z");

const state = vi.hoisted(() => ({
  sessions: [] as any[],
  latestPings: [] as any[],
  emails: [] as any[],
  notifications: [] as any[],
  admins: [{ email: "admin@x.com" }] as any[],
  days: [] as any[],
  schedules: [] as any[],
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/company", () => ({ getCompanyTimezone: async () => "Asia/Kolkata" }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (args: any) => {
    state.emails.push(args);
    return {};
  }),
}));

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
  return {
    AttendanceSession: { find: vi.fn(() => chain(() => state.sessions)) },
    LocationPing: {
      aggregate: vi.fn(async () => state.latestPings),
      find: vi.fn(() => chain(() => [])),
      findOne: vi.fn(() => chain(() => null)),
    },
    User: {
      find: vi.fn(() => chain(() => state.admins)),
      findById: vi.fn(() => chain(() => ({ fullName: "Alice", employeeCode: "E1", phone: "1" }))),
    },
    WorkSite: { findById: vi.fn(() => chain(() => ({ name: "Main Office" }))) },
    AttendanceDay: {
      findById: vi.fn(() => chain(() => null)),
      find: vi.fn(() => chain(() => state.days)),
    },
    AttendanceEvent: { create: vi.fn(async () => ({})) },
    OutsideSiteLog: { findOne: vi.fn(() => chain(() => null)), updateMany: vi.fn(async () => ({})) },
    EmployeeSchedule: {
      findOne: vi.fn(() => chain(() => null)),
      find: vi.fn(() => chain(() => state.schedules)),
    },
    EmployeeSiteAssignment: { find: vi.fn(() => chain(() => [])) },
    GeofenceEvent: { create: vi.fn(async () => ({})) },
    ShiftTemplate: { findById: vi.fn(() => chain(() => null)) },
    // Alerts are stored rows now, not emails. Without this the create call
    // throws, the sweep swallows it as best-effort, and the test reads a
    // notification-layer failure as a cadence failure.
    Notification: {
      create: vi.fn(async (doc: any) => {
        state.notifications.push(doc);
        return doc;
      }),
    },
  };
});

import { notifyOfflineEmployees } from "@/lib/attendance-service";
import { env } from "@/lib/env";

beforeEach(() => {
  state.sessions = [
    {
      _id: "s1",
      attendanceDayId: "day-1",
      employeeId: "emp-1",
      companyId: "co1",
      siteId: "site1",
      checkInAt: new Date(SHIFT_START),
      offlineNotifiedAt: null,
      save: vi.fn(async function (this: any) {
        return this;
      }),
    },
  ];
  // Last ping received just before the phone died.
  state.latestPings = [{ _id: "s1", capturedAt: new Date(PHONE_DIED) }];
  state.days = [{ _id: "day-1", workDate: "2026-09-01" }];
  state.schedules = [
    {
      employeeId: "emp-1",
      workDate: "2026-09-01",
      isWorkingDay: true,
      expectedEndAt: new Date(SHIFT_END),
    },
  ];
  state.emails = [];
  state.notifications = [];
  vi.clearAllMocks();
});

describe("cron cadence vs offline detection", () => {
  it("WOULD alert if the sweep ran during the shift", () => {
    // Sanity check that the detection logic itself is sound: 30 minutes after
    // the phone died, still inside the shift window, the alert fires.
    return expect(notifyOfflineEmployees(PHONE_DIED + 30 * MIN)).resolves.toBe(1);
  });

  it("keeps vercel.json on a schedule the Hobby plan accepts", () => {
    // Vercel rejects the whole DEPLOYMENT for a sub-daily cron on Hobby:
    //   "Hobby accounts are limited to daily cron jobs."
    // Putting the real cadence here once took production down, so this pins it.
    // On Pro this may become "*/10 * * * *" — delete the GitHub Actions
    // workflow at the same time, or every sweep runs twice.
    const schedule = JSON.parse(readFileSync("vercel.json", "utf8")).crons[0].schedule;
    expect(
      schedule,
      `"${schedule}" is not a once-a-day expression; Hobby deployments will fail`
    ).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it("runs often enough to catch an outage before the shift ends", async () => {
    // The EFFECTIVE cadence comes from the GitHub Actions workflow, since the
    // Vercel cron above can only be daily. Read it rather than hardcode it, so
    // slowing the workflow down fails here instead of silently killing alerts.
    const workflow = readFileSync(".github/workflows/cron-close-shifts.yml", "utf8");
    const everyMinutes = /- cron: "\*\/(\d+) \* \* \* \*"/.exec(workflow);
    expect(
      everyMinutes,
      "no sub-hourly schedule in the cron workflow; offline alerts cannot fire"
    ).toBeTruthy();

    const intervalMs = Number(everyMinutes![1]) * MIN;
    // A phone is only "offline" after OFFLINE_AFTER_MS of silence, and the
    // sweep only looks every `intervalMs` — so worst case the alert lands one
    // full interval after the threshold is crossed. That must still be inside
    // the shift, otherwise the skip-after-shift-end rule swallows it.
    const detectedAt = PHONE_DIED + env.OFFLINE_AFTER_MS + intervalMs;
    expect(
      detectedAt,
      "an outage cannot be detected before the shift ends at this cadence"
    ).toBeLessThan(SHIFT_END);

    const notified = await notifyOfflineEmployees(detectedAt);
    expect(notified).toBe(1);
    expect(state.notifications.length).toBeGreaterThan(0);
    expect(state.notifications[0].type).toBe("offline");
  });

  it("still stays quiet once the shift is genuinely over", async () => {
    // The skip-after-shift-end rule must survive the schedule change, or every
    // employee generates an alert every ten minutes all evening.
    expect(await notifyOfflineEmployees(SHIFT_END + HOUR)).toBe(0);
  });
});
