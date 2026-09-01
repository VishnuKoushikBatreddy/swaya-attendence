/**
 * GET /api/attendance/today must ship the server's PING_INTERVAL_MS to the
 * client, because the tracker that consumes it runs in the browser and the env
 * var is server-only. Without this the value is unreachable and the setting is
 * dead config again — which is exactly the bug this endpoint field fixes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ session: null as any, pingIntervalMs: 180_000 }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/company", () => ({ getCompanyTimezone: async () => "Asia/Kolkata" }));
vi.mock("@/lib/attendance-service", () => ({
  liveTotalsForActiveSession: vi.fn(async () => null),
}));

vi.mock("@/lib/env", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(t, p) {
        if (p === "PING_INTERVAL_MS") return h.pingIntervalMs;
        return (t as any)[p];
      },
    }),
  };
});

vi.mock("@/lib/api-helpers", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    requireAuth: async () => {
      if (!h.session) throw new actual.ApiError("Unauthenticated", 401);
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
    AttendanceDay: { findOne: () => chain(() => null) },
    AttendanceSession: { find: () => chain(() => []) },
    WorkSite: { findById: () => chain(() => null) },
    EmployeeSchedule: { findById: () => chain(() => null), findOne: () => chain(() => null) },
    ShiftTemplate: { findById: () => chain(() => null) },
  };
});

import { GET as today } from "@/app/api/attendance/today/route";

const req = () => ({ url: "http://localhost/api/attendance/today" }) as any;

beforeEach(() => {
  h.session = {
    user: {
      id: "650000000000000000000001",
      companyId: "650000000000000000000099",
      role: "employee",
    },
  };
  h.pingIntervalMs = 180_000;
  vi.clearAllMocks();
});

describe("GET /api/attendance/today — ping interval", () => {
  it("returns the configured PING_INTERVAL_MS", async () => {
    const res = await today(req());
    const json: any = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.pingIntervalMs).toBe(180_000);
  });

  it("reflects a changed configuration without a code change", async () => {
    h.pingIntervalMs = 45_000;
    const json: any = await (await today(req())).json();
    expect(json.data.pingIntervalMs).toBe(45_000);
  });

  it("still returns the existing payload fields alongside it", async () => {
    const json: any = await (await today(req())).json();
    // Adding the field must not disturb what the page already consumes.
    for (const key of ["day", "sessions", "site", "schedule", "shift"]) {
      expect(json.data).toHaveProperty(key);
    }
  });

  it("requires authentication", async () => {
    h.session = null;
    const res = await today(req());
    expect(res.status).toBe(401);
  });
});
