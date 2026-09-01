// @vitest-environment jsdom
/**
 * LATENT ISSUE (documented, not a confirmed user-facing bug).
 *
 * Does the employee page's clock keep running after a session ends?
 *
 * `nowTs` is ticked by an interval guarded with `if (!isCheckedIn) return`, and
 * both the auto-check-in gate and the tracking window read `nowTs || Date.now()`.
 * If that value is retained after check-out, those gates evaluate against the
 * moment the session ended rather than the present.
 *
 * The first test captures the `nowMs` the component actually passes in and shows
 * it lags real time — that FAILS, so the lag is real.
 *
 * The second test looks for the harm that lag would be expected to cause (GPS
 * polling continuing after the shift ends) and finds none: the freeze happens at
 * check-out, which in practice lands after the shift end, so the hours gate still
 * rejects correctly. Kept as a regression test — if the freeze ever starts
 * happening earlier in the shift, this is what catches it.
 *
 * Opt in with RUN_BUG_PROOFS=1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const PROVE = process.env.RUN_BUG_PROOFS === "1";

const SITE = { lat: 12.9153, lng: 77.6428, radiusMeters: 100 };
const NEAR = { latitude: SITE.lat, longitude: SITE.lng, accuracy: 5 };

const h = vi.hoisted(() => ({
  coords: { latitude: 0, longitude: 0, accuracy: 5 },
  /** Every nowMs the component passed to isWithinTrackingWindow. */
  windowClock: [] as number[],
  autoDecisions: [] as any[],
}));

// Wrap the real logic so behaviour is unchanged and only the input is observed.
vi.mock("@/lib/attendance-logic", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    isWithinTrackingWindow: (opts: any) => {
      h.windowClock.push(opts.nowMs);
      return actual.isWithinTrackingWindow(opts);
    },
    evaluateAutoCheckIn: (opts: any) => {
      const r = actual.evaluateAutoCheckIn(opts);
      h.autoDecisions.push({ nowMs: opts.nowMs, r });
      return r;
    },
  };
});

vi.mock("@/lib/geolocation", () => ({
  getCurrentLocation: vi.fn(async () => h.coords),
}));
vi.mock("@/lib/device", () => ({ getDeviceId: () => "test-device" }));
vi.mock("@/lib/device-status", () => ({
  readBatteryPercent: async () => 90,
  readNetworkType: async () => "wifi",
  subscribeNetwork: async () => () => {},
}));
vi.mock("@/lib/offline-queue", () => ({
  getQueue: () => [],
  enqueueAction: vi.fn(),
  replayQueue: vi.fn(async () => 0),
}));
vi.mock("@/components/ui/toaster", () => ({ toast: vi.fn() }));
vi.mock("@/components/geo/LocationTracker", () => ({ LocationTracker: () => null }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Alice" } }, update: vi.fn() }),
}));

import EmployeePage from "@/app/(dashboard)/employee/page";

const T0 = 1_800_000_000_000;
const SHIFT_END = T0 + 20_000;

function payload(sessions: any[]) {
  return {
    ok: true,
    data: {
      day: { status: "pending", totalWorkSeconds: 0 },
      sessions,
      site: {
        name: "Main Office",
        location: { type: "Point", coordinates: [SITE.lng, SITE.lat] },
        radiusMeters: SITE.radiusMeters,
      },
      schedule: {
        isWorkingDay: true,
        expectedStartAt: new Date(T0 - 3_600_000).toISOString(),
        expectedEndAt: new Date(SHIFT_END).toISOString(),
      },
      pingIntervalMs: 300_000,
      autoCheckIn: { enabled: true, pollMs: 1_000, graceMinutes: 10 },
    },
  };
}

const OPEN = [{ _id: "s1", checkInAt: new Date(T0 - 60_000).toISOString(), status: "active" }];
const AUTO_CLOSED = [
  {
    _id: "s1",
    checkInAt: new Date(T0 - 60_000).toISOString(),
    checkOutAt: new Date(T0 + 2_000).toISOString(),
    status: "auto_closed",
  },
];

let sessions: any[] = OPEN;

beforeEach(() => {
  vi.useFakeTimers({ now: T0, shouldAdvanceTime: false });
  h.coords = { ...NEAR };
  h.windowClock = [];
  h.autoDecisions = [];
  sessions = OPEN;
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes("/api/attendance/today")) {
      return { ok: true, json: async () => payload(sessions) } as any;
    }
    return { ok: true, json: async () => ({ ok: true, data: {} }) } as any;
  }) as any;
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: undefined,
    geolocation: { getCurrentPosition: vi.fn(), watchPosition: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.skipIf(!PROVE)("employee page clock after an automatic check-out", () => {
  it("keeps evaluating the shift window against the present, not the check-out instant", async () => {
    render(<EmployeePage />);

    // Session open: the 1s ticker runs and nowTs tracks real time.
    await vi.advanceTimersByTimeAsync(2_000);
    sessions = AUTO_CLOSED;

    // Past the 15s checked-in poll, so the page observes the auto-close and the
    // ticker's `if (!isCheckedIn) return` guard stops it.
    await vi.advanceTimersByTimeAsync(16_000);

    // Well past the real shift end; the checked-out poll re-renders at 30s.
    await vi.advanceTimersByTimeAsync(60_000);

    const now = Date.now();
    const latest = h.windowClock[h.windowClock.length - 1];
    expect(now).toBeGreaterThan(SHIFT_END); // the shift really is over
    expect(h.windowClock.length).toBeGreaterThan(0);

    // The clock the component reasons with must not lag real time.
    expect(
      now - latest,
      `shift-window clock is ${Math.round((now - latest) / 1000)}s behind real time`
    ).toBeLessThan(5_000);
  });

  it("stops polling GPS for auto check-in once the shift has ended", async () => {
    render(<EmployeePage />);
    await vi.advanceTimersByTimeAsync(2_000);
    sessions = AUTO_CLOSED;
    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(Date.now()).toBeGreaterThan(SHIFT_END);
    const before = (global.fetch as any).mock.calls.length;

    // A further two minutes, all of it after the shift ended.
    await vi.advanceTimersByTimeAsync(120_000);

    const after = (global.fetch as any).mock.calls
      .slice(before)
      .map((c: any[]) => String(c[0]));
    const checkIns = after.filter((u: string) => u.includes("/api/attendance/check-in"));
    expect(
      checkIns.length,
      `${checkIns.length} check-in attempts fired after the shift ended`
    ).toBe(0);
  });
});
