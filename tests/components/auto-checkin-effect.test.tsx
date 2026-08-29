// @vitest-environment jsdom
/**
 * Rendering tests for the auto check-in EFFECT on the employee page.
 *
 * evaluateAutoCheckIn is unit-tested, but the wiring around it was not: that the
 * effect actually reads the GPS, that it only POSTs when genuinely inside the
 * geofence, that the manual-check-out suppression reaches the real component,
 * and — importantly — that an offline attempt is NOT queued.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const SITE = { lat: 12.9153, lng: 77.6428, radiusMeters: 100 };
/** ~1.1 km north of the site — comfortably outside the 100 m radius. */
const FAR = { latitude: SITE.lat + 0.01, longitude: SITE.lng, accuracy: 5 };
const NEAR = { latitude: SITE.lat, longitude: SITE.lng, accuracy: 5 };

const h = vi.hoisted(() => ({
  coords: { latitude: 0, longitude: 0, accuracy: 5 },
  locationFails: false,
  enqueued: [] as any[],
}));

vi.mock("@/lib/geolocation", () => ({
  getCurrentLocation: vi.fn(async () => {
    if (h.locationFails) throw new Error("permission denied");
    return h.coords;
  }),
}));
vi.mock("@/lib/device", () => ({ getDeviceId: () => "test-device" }));
vi.mock("@/lib/device-status", () => ({
  readBatteryPercent: async () => 90,
  readNetworkType: async () => "wifi",
  subscribeNetwork: async () => () => {},
}));
vi.mock("@/lib/offline-queue", () => ({
  getQueue: () => [],
  enqueueAction: vi.fn((a: any) => {
    h.enqueued.push(a);
    return a;
  }),
  replayQueue: vi.fn(async () => 0),
}));
vi.mock("@/components/ui/toaster", () => ({ toast: vi.fn() }));
vi.mock("@/components/geo/LocationTracker", () => ({ LocationTracker: () => null }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Alice" } }, update: vi.fn() }),
}));

import EmployeePage from "@/app/(dashboard)/employee/page";

const NOW = Date.now();
const todayPayload = (over: Partial<any> = {}) => ({
  ok: true,
  data: {
    day: { status: "pending", totalWorkSeconds: 0 },
    sessions: [],
    site: {
      name: "Main Office",
      location: { type: "Point", coordinates: [SITE.lng, SITE.lat] },
      radiusMeters: SITE.radiusMeters,
    },
    // Shift window wide open around "now" so the hours gate passes.
    schedule: {
      isWorkingDay: true,
      expectedStartAt: new Date(NOW - 60 * 60_000).toISOString(),
      expectedEndAt: new Date(NOW + 60 * 60_000).toISOString(),
    },
    leave: null,
    pingIntervalMs: 180_000,
    autoCheckIn: { enabled: true, pollMs: 60_000, graceMinutes: 10 },
    ...over,
  },
});

/** Routes fetch by URL so we can assert exactly what the effect POSTed. */
function installFetch(today: any) {
  const calls: { url: string; body?: any }[] = [];
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
    if (u.includes("/api/attendance/today")) {
      return { ok: true, json: async () => today } as any;
    }
    if (u.includes("/api/attendance/check-in")) {
      return {
        ok: true,
        json: async () => ({ ok: true, data: { site: { name: "Main Office" } } }),
      } as any;
    }
    return { ok: true, json: async () => ({ ok: true, data: {} }) } as any;
  }) as any;
  return calls;
}

const checkInCalls = (calls: { url: string }[]) =>
  calls.filter((c) => c.url.includes("/api/attendance/check-in"));

beforeEach(() => {
  h.coords = { ...NEAR };
  h.locationFails = false;
  h.enqueued = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: undefined,
    geolocation: { getCurrentPosition: vi.fn(), watchPosition: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auto check-in effect", () => {
  it("checks in automatically when inside the site during shift hours", async () => {
    const calls = installFetch(todayPayload());
    render(<EmployeePage />);
    await waitFor(() => expect(checkInCalls(calls).length).toBe(1), { timeout: 4000 });

    const body = checkInCalls(calls)[0] as any;
    expect(body.body.lat).toBeCloseTo(SITE.lat, 4);
    expect(body.body.deviceId).toBe("test-device");
  });

  it("does NOT check in when outside the geofence", async () => {
    h.coords = { ...FAR };
    const calls = installFetch(todayPayload());
    render(<EmployeePage />);
    // Give the effect time to read the GPS and decide.
    await new Promise((r) => setTimeout(r, 800));
    expect(checkInCalls(calls)).toHaveLength(0);
  });

  it("does NOT check in after a MANUAL check-out", async () => {
    // status "completed" == the employee chose to leave.
    const calls = installFetch(
      todayPayload({ sessions: [{ status: "completed", checkInAt: new Date(NOW - 3600_000) }] })
    );
    render(<EmployeePage />);
    await new Promise((r) => setTimeout(r, 800));
    expect(checkInCalls(calls)).toHaveLength(0);
  });

  it("DOES check in again after an AUTOMATIC check-out", async () => {
    const calls = installFetch(
      todayPayload({ sessions: [{ status: "auto_closed", checkInAt: new Date(NOW - 3600_000) }] })
    );
    render(<EmployeePage />);
    await waitFor(() => expect(checkInCalls(calls).length).toBe(1), { timeout: 4000 });
  });

  it("does NOT check in without a schedule", async () => {
    const calls = installFetch(todayPayload({ schedule: null }));
    render(<EmployeePage />);
    await new Promise((r) => setTimeout(r, 800));
    expect(checkInCalls(calls)).toHaveLength(0);
  });

  it("does NOT check in outside shift hours", async () => {
    const calls = installFetch(
      todayPayload({
        schedule: {
          isWorkingDay: true,
          expectedStartAt: new Date(NOW + 3 * 3600_000).toISOString(),
          expectedEndAt: new Date(NOW + 6 * 3600_000).toISOString(),
        },
      })
    );
    render(<EmployeePage />);
    await new Promise((r) => setTimeout(r, 800));
    expect(checkInCalls(calls)).toHaveLength(0);
  });

  it("does NOT check in on approved leave", async () => {
    const calls = installFetch(todayPayload({ leave: { leaveType: "casual" } }));
    render(<EmployeePage />);
    await new Promise((r) => setTimeout(r, 800));
    expect(checkInCalls(calls)).toHaveLength(0);
  });

  it("does NOT check in when disabled server-side", async () => {
    const calls = installFetch(
      todayPayload({ autoCheckIn: { enabled: false, pollMs: 60_000, graceMinutes: 10 } })
    );
    render(<EmployeePage />);
    await new Promise((r) => setTimeout(r, 800));
    expect(checkInCalls(calls)).toHaveLength(0);
  });

  it("does not crash when location permission is denied", async () => {
    h.locationFails = true;
    const calls = installFetch(todayPayload());
    render(<EmployeePage />);
    await new Promise((r) => setTimeout(r, 800));
    expect(checkInCalls(calls)).toHaveLength(0);
  });

  it("never queues an auto check-in while offline", async () => {
    // A queued automatic check-in would replay at a time the employee never
    // chose, so the offline path must drop it rather than enqueue.
    const today = todayPayload();
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/api/attendance/today")) {
        return { ok: true, json: async () => today } as any;
      }
      throw new Error("offline");
    }) as any;

    render(<EmployeePage />);
    await new Promise((r) => setTimeout(r, 900));
    expect(h.enqueued).toHaveLength(0);
  });
});
