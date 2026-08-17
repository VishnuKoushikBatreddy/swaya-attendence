/**
 * Route-level staleness guard on /api/geofence-event.
 *
 * The Android receiver's retry queue drops 4xx and retries everything else, so
 * the status code here is load-bearing: a rejected event must come back as 400
 * (drop it — it will only get staler), never 5xx (retry forever).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({ user: null as any }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/attendance-service", () => ({
  processGeofenceEnter: vi.fn(async () => ({ ok: true })),
  processGeofenceExit: vi.fn(async () => ({ ok: true, session: {}, day: {} })),
}));
vi.mock("@/models", () => ({
  User: { findOne: () => ({ select: () => ({ lean: async () => state.user }) }) },
}));

import { POST as geofence } from "@/app/api/geofence-event/route";
import { mintNativeToken } from "@/lib/native-token";
import { processGeofenceExit } from "@/lib/attendance-service";

const EMP = "650000000000000000000001";
const CO = "650000000000000000000099";
const token = mintNativeToken(EMP, CO);

const req = (body: unknown) =>
  ({ json: async () => body, headers: new Headers(), url: "http://localhost/api/geofence-event" }) as any;

const evt = (capturedAt?: string) => ({
  token,
  transition: "EXIT" as const,
  lat: 12.9153,
  lng: 77.6428,
  accuracy: 30,
  ...(capturedAt ? { capturedAt } : {}),
});

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  state.user = { _id: EMP };
  vi.clearAllMocks();
});

describe("POST /api/geofence-event — staleness guard", () => {
  it("applies an event that arrives an hour late, at its ORIGINAL time", async () => {
    const capturedAt = agoIso(60 * 60_000);
    const res = await geofence(req(evt(capturedAt)));

    expect(res.status).toBe(200);
    // The whole point of the retry queue: back-dated, not stamped on arrival.
    expect(processGeofenceExit).toHaveBeenCalledWith(
      expect.objectContaining({ capturedAt })
    );
  });

  it("still applies an event from 8 hours ago (offline all shift)", async () => {
    const res = await geofence(req(evt(agoIso(8 * 60 * 60_000))));
    expect(res.status).toBe(200);
    expect(processGeofenceExit).toHaveBeenCalled();
  });

  it("rejects an event older than the 12h window with a DROPPABLE 400", async () => {
    const res = await geofence(req(evt(agoIso(13 * 60 * 60_000))));
    expect(res.status).toBe(400);
    expect(processGeofenceExit).not.toHaveBeenCalled();
  });

  it("rejects a far-future timestamp", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await geofence(req(evt(future)));
    expect(res.status).toBe(400);
    expect(processGeofenceExit).not.toHaveBeenCalled();
  });

  it("tolerates minor device clock skew", async () => {
    const slightlyAhead = new Date(Date.now() + 60_000).toISOString();
    const res = await geofence(req(evt(slightlyAhead)));
    expect(res.status).toBe(200);
    expect(processGeofenceExit).toHaveBeenCalled();
  });

  it("accepts an event with no capturedAt at all (server stamps it)", async () => {
    const res = await geofence(req(evt()));
    expect(res.status).toBe(200);
    expect(processGeofenceExit).toHaveBeenCalledWith(
      expect.objectContaining({ capturedAt: undefined })
    );
  });

  it("checks the token BEFORE the timestamp — no oracle for unauthenticated callers", async () => {
    const res = await geofence(
      req({ ...evt(agoIso(13 * 60 * 60_000)), token: "bogus.token" })
    );
    expect(res.status).toBe(401);
  });
});
