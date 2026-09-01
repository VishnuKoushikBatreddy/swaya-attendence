/**
 * Security tests for the cron close-shifts endpoint: secret enforcement and the
 * fail-closed behaviour when no secret is configured in production.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cfg = vi.hoisted(() => ({ secret: "", nodeEnv: "test" }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/attendance-service", () => ({
  autoCloseEndedShifts: vi.fn(async () => 3),
  // The cron also sweeps for phones that stopped reporting — offline detection
  // has to be server-side, since a dead client cannot announce itself.
  notifyOfflineEmployees: vi.fn(async () => 1),
}));
vi.mock("@/lib/env", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(t, p) {
        if (p === "CRON_SECRET") return cfg.secret;
        if (p === "NODE_ENV") return cfg.nodeEnv;
        return (t as any)[p];
      },
    }),
  };
});

import { GET as cron } from "@/app/api/cron/close-shifts/route";
import { autoCloseEndedShifts, notifyOfflineEmployees } from "@/lib/attendance-service";

const req = (authHeader?: string) =>
  ({
    headers: new Headers(authHeader ? { authorization: authHeader } : {}),
    url: "http://localhost/api/cron/close-shifts",
  }) as any;

beforeEach(() => {
  cfg.secret = "";
  cfg.nodeEnv = "test";
  vi.clearAllMocks();
});

describe("GET /api/cron/close-shifts", () => {
  it("401 with a configured secret but NO authorization header", async () => {
    cfg.secret = "topsecret";
    const res = await cron(req());
    expect(res.status).toBe(401);
    expect(autoCloseEndedShifts).not.toHaveBeenCalled();
  });

  it("401 with the WRONG secret", async () => {
    cfg.secret = "topsecret";
    const res = await cron(req("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(autoCloseEndedShifts).not.toHaveBeenCalled();
  });

  it("200 with the correct secret", async () => {
    cfg.secret = "topsecret";
    const res = await cron(req("Bearer topsecret"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, data: { closed: 3, offlineNotified: 1 } });
    expect(autoCloseEndedShifts).toHaveBeenCalledTimes(1);
    expect(notifyOfflineEmployees).toHaveBeenCalledTimes(1);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("FAILS CLOSED: 503 in production when no secret is configured", async () => {
    cfg.secret = "";
    cfg.nodeEnv = "production";
    const res = await cron(req());
    expect(res.status).toBe(503);
    expect(autoCloseEndedShifts).not.toHaveBeenCalled();
  });

  it("allows an unauthenticated call only in non-production (local dev convenience)", async () => {
    cfg.secret = "";
    cfg.nodeEnv = "development";
    const res = await cron(req());
    expect(res.status).toBe(200);
    expect(autoCloseEndedShifts).toHaveBeenCalledTimes(1);
  });
});
