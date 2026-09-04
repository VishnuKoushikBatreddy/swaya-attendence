// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  enqueueAction,
  getQueue,
  replayQueue,
  type QueuedAction,
} from "@/lib/offline-queue";

const sample = (over: Partial<QueuedAction> = {}): Omit<QueuedAction, "id"> => ({
  type: "check-in",
  lat: 12.9153,
  lng: 77.6428,
  accuracy: 10,
  capturedAt: "2026-06-13T09:00:00.000Z",
  deviceId: "dev-1",
  ...over,
});

const resp = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline queue storage", () => {
  it("enqueues and reads back an action with a generated id", () => {
    const item = enqueueAction(sample());
    expect(item.id).toBeTruthy();
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].type).toBe("check-in");
  });

  it("returns items sorted oldest-first by capturedAt", () => {
    enqueueAction(sample({ capturedAt: "2026-06-13T12:00:00.000Z" }));
    enqueueAction(sample({ capturedAt: "2026-06-13T08:00:00.000Z" }));
    enqueueAction(sample({ capturedAt: "2026-06-13T10:00:00.000Z" }));
    const order = getQueue().map((q) => q.capturedAt);
    expect(order).toEqual([
      "2026-06-13T08:00:00.000Z",
      "2026-06-13T10:00:00.000Z",
      "2026-06-13T12:00:00.000Z",
    ]);
  });
});

describe("replayQueue", () => {
  it("removes actions the server accepts and posts the captured time", async () => {
    enqueueAction(sample());
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { synced } = await replayQueue();

    expect(synced).toBe(1);
    expect(getQueue()).toHaveLength(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/attendance/check-in");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.capturedAt).toBe("2026-06-13T09:00:00.000Z");
  });

  it("DROPS an action the server rejects with 4xx (idempotency: already_checked_in)", async () => {
    enqueueAction(sample());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(resp(400, { ok: false, error: "already_checked_in" }))
    );

    const { synced } = await replayQueue();

    expect(synced).toBe(0);
    expect(getQueue()).toHaveLength(0); // dropped, won't retry forever
  });

  it("KEEPS an action on a 5xx server error to retry later", async () => {
    enqueueAction(sample());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resp(500, { ok: false })));

    const { synced } = await replayQueue();

    expect(synced).toBe(0);
    expect(getQueue()).toHaveLength(1); // still queued
  });

  it("stops and keeps everything when the network is still down", async () => {
    enqueueAction(sample({ capturedAt: "2026-06-13T08:00:00.000Z" }));
    enqueueAction(sample({ capturedAt: "2026-06-13T09:00:00.000Z" }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));

    const { synced } = await replayQueue();

    expect(synced).toBe(0);
    expect(getQueue()).toHaveLength(2);
  });

  it("routes a check-out action to the check-out endpoint", async () => {
    enqueueAction(sample({ type: "check-out" }));
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await replayQueue();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/attendance/check-out");
  });

  it("reports WHY a queued action was refused, instead of dropping it silently", async () => {
    // The phone only checks the geofence before queueing — not the roster or the
    // shift window — so an offline check-in on an unscheduled day queues happily
    // and is then refused on sync. Dropping that quietly left the employee
    // believing they were on the clock until an admin noticed days later.
    enqueueAction({
      type: "check-in",
      lat: 1,
      lng: 2,
      capturedAt: "2026-09-05T04:00:00.000Z",
      deviceId: "d1",
    });
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "You have no shift scheduled for today." }),
    })) as any;

    const { synced, rejected } = await replayQueue();

    expect(synced).toBe(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].type).toBe("check-in");
    expect(rejected[0].reason).toBe("You have no shift scheduled for today.");
    // Still dropped — retrying cannot change the answer.
    expect(getQueue()).toHaveLength(0);
  });

  it("reports nothing when everything synced", async () => {
    enqueueAction({ type: "check-in", lat: 1, lng: 2, capturedAt: "2026-09-05T04:00:00.000Z", deviceId: "d1" });
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as any;

    const { synced, rejected } = await replayQueue();
    expect(synced).toBe(1);
    expect(rejected).toHaveLength(0);
  });

  it("does not report a 5xx as a refusal — it is retried, not lost", async () => {
    enqueueAction({ type: "check-out", lat: 1, lng: 2, capturedAt: "2026-09-05T04:00:00.000Z", deviceId: "d1" });
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: "down" }) })) as any;

    const { synced, rejected } = await replayQueue();
    expect(synced).toBe(0);
    expect(rejected).toHaveLength(0);
    expect(getQueue()).toHaveLength(1); // still queued
  });

  it("falls back to a readable reason when the server gives none", async () => {
    enqueueAction({ type: "check-in", lat: 1, lng: 2, capturedAt: "2026-09-05T04:00:00.000Z", deviceId: "d1" });
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => null })) as any;

    const { rejected } = await replayQueue();
    expect(rejected[0].reason).toBeTruthy();
  });
});
