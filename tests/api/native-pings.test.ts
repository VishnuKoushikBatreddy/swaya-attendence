/**
 * /api/native/pings — the upload path for LocationTrackingService.
 *
 * The service runs with the app killed and has no WebView, so it has no session
 * cookie and cannot use /api/pings (requireAuth). This route authenticates with
 * the same stateless native token the geofence endpoint uses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as any,
  result: { ok: true, received: 0, autoCheckedOut: false, autoCheckoutAt: null } as any,
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/attendance-service", () => ({
  processPings: vi.fn(async (opts: any) => ({ ...state.result, received: opts.pings.length })),
}));
vi.mock("@/models", () => ({
  User: { findOne: () => ({ select: () => ({ lean: async () => state.user }) }) },
}));

import { POST as nativePings } from "@/app/api/native/pings/route";
import { mintNativeToken } from "@/lib/native-token";
import { processPings } from "@/lib/attendance-service";

const EMP = "650000000000000000000001";
const CO = "650000000000000000000099";
const token = mintNativeToken(EMP, CO);

const req = (body: unknown) =>
  ({ json: async () => body, headers: new Headers(), url: "http://localhost/api/native/pings" }) as any;

const ping = (agoMs = 0) => ({
  lat: 12.9153,
  lng: 77.6428,
  accuracy: 8,
  deviceId: "android-1",
  appState: "killed" as const,
  capturedAt: new Date(Date.now() - agoMs).toISOString(),
});

const data = async (res: Response) => (await res.json()).data;

beforeEach(() => {
  state.user = { _id: EMP };
  state.result = { ok: true, received: 0, autoCheckedOut: false, autoCheckoutAt: null };
  vi.clearAllMocks();
});

describe("POST /api/native/pings", () => {
  it("accepts a batch with a valid native token", async () => {
    const res = await nativePings(req({ token, pings: [ping(), ping(60_000)] }));
    expect(res.status).toBe(200);
    expect((await data(res)).received).toBe(2);
    expect(processPings).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: EMP, companyId: CO })
    );
  });

  it("401s on an invalid token", async () => {
    const res = await nativePings(req({ token: "bogus.token", pings: [ping()] }));
    expect(res.status).toBe(401);
    expect(processPings).not.toHaveBeenCalled();
  });

  it("403s when the employee is inactive or missing", async () => {
    state.user = null;
    const res = await nativePings(req({ token, pings: [ping()] }));
    expect(res.status).toBe(403);
    expect(processPings).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await nativePings(req({ token, pings: [] })); // min(1)
    expect(res.status).toBe(400);
  });

  it("accepts a buffered batch from a dead zone, at its ORIGINAL times", async () => {
    // The whole point of the on-device queue: hours-late delivery must still be
    // applied at each ping's own capturedAt.
    const old = ping(3 * 60 * 60_000);
    const res = await nativePings(req({ token, pings: [old] }));
    expect(res.status).toBe(200);
    expect(processPings).toHaveBeenCalledWith(
      expect.objectContaining({
        pings: expect.arrayContaining([expect.objectContaining({ capturedAt: old.capturedAt })]),
      })
    );
  });

  it("drops individually stale pings without failing the whole batch", async () => {
    // One bad timestamp must not cost a day of buffered tracking.
    const res = await nativePings(
      req({ token, pings: [ping(13 * 60 * 60_000), ping(), ping(60_000)] })
    );
    const d = await data(res);
    expect(res.status).toBe(200);
    expect(d.dropped).toBe(1);
    expect(d.received).toBe(2);
  });

  it("reports no active session as 200, so the device stops retrying", async () => {
    // Between shifts this is the normal state — a 4xx would make the service
    // retry the same batch forever.
    state.result = { ok: false, reason: "no_active_session" };
    const res = await nativePings(req({ token, pings: [ping()] }));
    expect(res.status).toBe(200);
    expect((await data(res)).reason).toBe("no_active_session");
  });

  it("surfaces an auto-checkout so the service can stop tracking", async () => {
    state.result = {
      ok: true,
      received: 1,
      autoCheckedOut: true,
      autoCheckoutAt: new Date().toISOString(),
    };
    const res = await nativePings(req({ token, pings: [ping()] }));
    expect((await data(res)).autoCheckedOut).toBe(true);
  });

  it("checks the token BEFORE anything else", async () => {
    state.user = null;
    const res = await nativePings(req({ token: "bogus.token", pings: [ping()] }));
    expect(res.status).toBe(401); // not 403
  });
});
