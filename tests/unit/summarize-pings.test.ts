import { describe, it, expect } from "vitest";
import { summarizePings } from "@/lib/attendance-service";

// summarizePings(pings, siteId, endTimeMs) buckets the time BETWEEN consecutive
// pings as inside/outside the geofence, clamping every interval to endTimeMs.
const ping = (ms: number, inside: boolean) => ({
  capturedAt: new Date(ms),
  isInsideGeofence: inside,
  sessionId: "s1",
});

describe("summarizePings — cumulative inside/outside accounting", () => {
  it("returns all zeros for no pings", () => {
    expect(summarizePings([], "s1", 1000)).toEqual({
      totalInside: 0,
      totalOutside: 0,
      outsideVisitCount: 0,
      offline: 0,
    });
  });

  it("counts continuous inside time up to the session end cap", () => {
    const pings = [ping(0, true), ping(60_000, true), ping(120_000, true)];
    const r = summarizePings(pings, "s1", 180_000);
    expect(r.totalInside).toBe(180);
    expect(r.totalOutside).toBe(0);
    expect(r.outsideVisitCount).toBe(0);
  });

  it("counts a single outside excursion as one visit", () => {
    const pings = [
      ping(0, true),
      ping(60_000, false),
      ping(120_000, false),
      ping(180_000, true),
    ];
    const r = summarizePings(pings, "s1", 240_000);
    expect(r.totalInside).toBe(120);
    expect(r.totalOutside).toBe(120);
    expect(r.outsideVisitCount).toBe(1);
  });

  it("counts two separate excursions as two visits", () => {
    const pings = [
      ping(0, true),
      ping(60_000, false), // visit 1
      ping(120_000, true),
      ping(180_000, false), // visit 2
      ping(240_000, true),
    ];
    const r = summarizePings(pings, "s1", 300_000);
    expect(r.outsideVisitCount).toBe(2);
  });

  it("clamps intervals so pings after the cap add no time (out-of-order/late ping)", () => {
    const pings = [
      ping(0, true),
      ping(60_000, true),
      ping(600_000, true), // long after the session end cap
    ];
    const r = summarizePings(pings, "s1", 120_000);
    // 0->60s inside, 60->120s (clamped) inside, the 600s ping contributes 0.
    expect(r.totalInside).toBe(120);
    expect(r.totalOutside).toBe(0);
  });

  it("never produces negative durations", () => {
    const pings = [ping(120_000, true), ping(0, false)];
    const r = summarizePings(pings, "s1", 60_000);
    expect(r.totalInside).toBeGreaterThanOrEqual(0);
    expect(r.totalOutside).toBeGreaterThanOrEqual(0);
  });
});
