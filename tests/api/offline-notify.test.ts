/**
 * notifyOfflineEmployees — the sweep that spots phones that stopped reporting.
 *
 * This can only be server-side: when tracking stops there is, by definition, no
 * client left to announce it. The behaviour that matters most is that it alerts
 * ONCE per outage — a sweep running every hour must not email an admin every
 * hour about the same silent phone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

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
vi.mock("@/lib/company", () => ({ getCompanyTimezone: async () => "UTC" }));
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
      findById: vi.fn(() => chain(() => ({ fullName: "Alice", employeeCode: "E1", phone: "123" }))),
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
    Notification: {
      create: vi.fn(async (doc: any) => {
        state.notifications.push(doc);
        return doc;
      }),
    },
  };
});

import { notifyOfflineEmployees } from "@/lib/attendance-service";

function mkSession(id: string, opts: { checkInAgoMs: number; notified?: Date | null }) {
  return {
    _id: id,
    attendanceDayId: "day-" + id,
    employeeId: "emp-" + id,
    companyId: "co1",
    siteId: "site1",
    checkInAt: new Date(NOW - opts.checkInAgoMs),
    offlineNotifiedAt: opts.notified ?? null,
    save: vi.fn(async function (this: any) {
      return this;
    }),
  };
}

const pingFor = (sessionId: string, agoMs: number) => ({
  _id: sessionId,
  capturedAt: new Date(NOW - agoMs),
});

beforeEach(() => {
  state.sessions = [];
  state.latestPings = [];
  state.emails = [];
  state.notifications = [];
  state.admins = [{ email: "admin@x.com" }];
  state.days = [];
  state.schedules = [];
  vi.clearAllMocks();
});

describe("notifyOfflineEmployees", () => {
  it("alerts when a checked-in phone has been silent past the threshold", async () => {
    const s = mkSession("s1", { checkInAgoMs: 4 * 60 * MIN });
    state.sessions = [s];
    state.latestPings = [pingFor("s1", 45 * MIN)];

    expect(await notifyOfflineEmployees(NOW)).toBe(1);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].type).toBe("offline");
    expect(state.notifications[0].severity).toBe("critical");
    expect(state.notifications[0].body).toContain("45 minutes");
    expect(s.offlineNotifiedAt).toBeInstanceOf(Date);
  });

  it("does NOT alert while pings are arriving normally", async () => {
    state.sessions = [mkSession("s1", { checkInAgoMs: 60 * MIN })];
    state.latestPings = [pingFor("s1", 2 * MIN)];

    expect(await notifyOfflineEmployees(NOW)).toBe(0);
    expect(state.notifications).toHaveLength(0);
  });

  it("alerts only ONCE for the same outage", async () => {
    const s = mkSession("s1", { checkInAgoMs: 4 * 60 * MIN });
    state.sessions = [s];
    state.latestPings = [pingFor("s1", 45 * MIN)];

    expect(await notifyOfflineEmployees(NOW)).toBe(1);
    // Second sweep, still silent — the marker must suppress a repeat email.
    expect(await notifyOfflineEmployees(NOW + 60 * MIN)).toBe(0);
    expect(state.notifications).toHaveLength(1);
  });

  it("re-arms once the phone reports again, so a later outage alerts afresh", async () => {
    const s = mkSession("s1", { checkInAgoMs: 4 * 60 * MIN, notified: new Date(NOW - 30 * MIN) });
    state.sessions = [s];
    state.latestPings = [pingFor("s1", 1 * MIN)]; // reporting again

    expect(await notifyOfflineEmployees(NOW)).toBe(0);
    expect(s.offlineNotifiedAt).toBeNull(); // marker cleared
  });

  it("measures silence from check-in when no ping ever arrived", async () => {
    state.sessions = [mkSession("s1", { checkInAgoMs: 40 * MIN })];
    state.latestPings = []; // never reported

    expect(await notifyOfflineEmployees(NOW)).toBe(1);
    expect(state.notifications[0].body).toContain("never reported");
  });

  it("does NOT alert once the scheduled shift has ended", async () => {
    // The device deliberately stops tracking at shift end, so silence afterwards
    // is expected. Alerting on it would fire for everyone, every evening.
    state.sessions = [mkSession("s1", { checkInAgoMs: 9 * 60 * MIN })];
    state.latestPings = [pingFor("s1", 45 * MIN)];
    state.days = [{ _id: "day-s1", workDate: "2026-08-17" }];
    state.schedules = [
      {
        employeeId: "emp-s1",
        workDate: "2026-08-17",
        isWorkingDay: true,
        // Shift ended an hour ago.
        expectedEndAt: new Date(NOW - 60 * MIN),
      },
    ];

    expect(await notifyOfflineEmployees(NOW)).toBe(0);
    expect(state.notifications).toHaveLength(0);
  });

  it("DOES alert for silence during the shift", async () => {
    state.sessions = [mkSession("s1", { checkInAgoMs: 4 * 60 * MIN })];
    state.latestPings = [pingFor("s1", 45 * MIN)];
    state.days = [{ _id: "day-s1", workDate: "2026-08-17" }];
    state.schedules = [
      {
        employeeId: "emp-s1",
        workDate: "2026-08-17",
        isWorkingDay: true,
        // Still hours of shift left.
        expectedEndAt: new Date(NOW + 3 * 60 * MIN),
      },
    ];

    expect(await notifyOfflineEmployees(NOW)).toBe(1);
  });

  it("does nothing when no sessions are open", async () => {
    state.sessions = [];
    expect(await notifyOfflineEmployees(NOW)).toBe(0);
  });

  it("still records the alert when the company has no admin yet", async () => {
    // Notifications are addressed to the COMPANY, not to individual mailboxes.
    // The old email path looked up admin addresses first and dropped the alert
    // when there were none; a stored notification is waiting whenever an admin
    // next signs in.
    state.admins = [];
    state.sessions = [mkSession("s1", { checkInAgoMs: 4 * 60 * MIN })];
    state.latestPings = [pingFor("s1", 45 * MIN)];

    expect(await notifyOfflineEmployees(NOW)).toBe(1);
    expect(state.notifications).toHaveLength(1);
  });

  it("carries a dedupe key so a retried sweep cannot double-post", async () => {
    state.sessions = [mkSession("s1", { checkInAgoMs: 4 * 60 * MIN })];
    state.latestPings = [pingFor("s1", 45 * MIN)];

    await notifyOfflineEmployees(NOW);
    expect(state.notifications[0].dedupeKey).toMatch(/^offline:s1:/);
  });
});
