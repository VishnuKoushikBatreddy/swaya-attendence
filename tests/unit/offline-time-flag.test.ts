/**
 * Offline time: the share of a session no ping vouches for.
 *
 * Before this existed, a phone that died at noon produced a full 9-hour day that
 * looked identical in reports to one tracked end to end — the least evidence
 * gave the cleanest record. These pin the threshold behaviour.
 */
import { describe, it, expect } from "vitest";
import {
  classifyOfflineForDay,
  computeDayTotals,
  summarizeSessionPings,
} from "@/lib/attendance-logic";
import { env } from "@/lib/env";

const T = (h: number, m = 0) => new Date(2026, 7, 17, h, m, 0).getTime();
const ping = (t: number, inside: boolean) => ({
  capturedAt: new Date(t),
  isInsideGeofence: inside,
});
const every = (from: number, to: number, inside: boolean, stepMin = 5) => {
  const out = [];
  for (let t = from; t < to; t += stepMin * 60_000) out.push(ping(t, inside));
  return out;
};
const TRUST = env.PING_TRUST_WINDOW_MS;
const H = 3600;

describe("classifyOfflineForDay", () => {
  it("flags a day that is mostly unevidenced", () => {
    // Phone dies at noon on a 9-hour shift: ~6h of 9h offline.
    const r = classifyOfflineForDay({
      totalOfflineSeconds: 6 * H,
      totalWorkSeconds: 9 * H,
    });
    expect(r.flagExcessiveOffline).toBe(true);
    expect(r.offlineRatio).toBeCloseTo(6 / 9, 5);
  });

  it("does NOT flag ordinary ping loss on a tracked day", () => {
    // A 30-minute dead spot in a 9-hour shift is 5% — normal.
    expect(
      classifyOfflineForDay({ totalOfflineSeconds: 27 * 60, totalWorkSeconds: 9 * H })
        .flagExcessiveOffline
    ).toBe(false);
  });

  it("does NOT flag a fully tracked day", () => {
    expect(
      classifyOfflineForDay({ totalOfflineSeconds: 0, totalWorkSeconds: 9 * H })
        .flagExcessiveOffline
    ).toBe(false);
  });

  it("needs BOTH the ratio and the floor — a short shift is not flagged on one dead spot", () => {
    // 10 min offline out of a 30-minute shift is 33% (over ratio) but under the
    // 15-minute floor. One lift ride must not condemn a brief shift.
    const r = classifyOfflineForDay({ totalOfflineSeconds: 10 * 60, totalWorkSeconds: 30 * 60 });
    expect(r.offlineRatio).toBeGreaterThan(0.25);
    expect(r.flagExcessiveOffline).toBe(false);
  });

  it("needs the ratio too — 20 min offline in a 9-hour day clears the floor but not the share", () => {
    const r = classifyOfflineForDay({ totalOfflineSeconds: 20 * 60, totalWorkSeconds: 9 * H });
    expect(20 * 60).toBeGreaterThan(15 * 60); // clears the floor
    expect(r.offlineRatio).toBeLessThan(0.25); // but not the share
    expect(r.flagExcessiveOffline).toBe(false);
  });

  it("is safe when there is no work time (no division by zero)", () => {
    const r = classifyOfflineForDay({ totalOfflineSeconds: 0, totalWorkSeconds: 0 });
    expect(r.offlineRatio).toBe(0);
    expect(r.flagExcessiveOffline).toBe(false);
  });
});

describe("offline time end-to-end at the 5-minute cadence", () => {
  const day = (pings: ReturnType<typeof ping>[]) =>
    computeDayTotals(
      [{ _id: "a", checkInAt: new Date(T(9)), checkOutAt: new Date(T(18)) }],
      new Map([["a", pings]]),
      T(18),
      { maxIntervalMs: TRUST }
    );

  it("a normally tracked shift has zero offline time", () => {
    // 5-minute pings sit inside the 8-minute trust window, so nothing is lost.
    const r = day(every(T(9), T(18), true));
    expect(r.totalOfflineSeconds).toBe(0);
    expect(r.totalInsideSeconds).toBe(9 * H);
  });

  it("a dead phone yields offline time, and that day is flagged", () => {
    const r = day(every(T(9), T(12), true));
    // Last ping 11:55 vouches 8 more minutes; the rest is offline.
    expect(r.totalInsideSeconds).toBe(3 * H + 3 * 60);
    expect(r.totalOfflineSeconds).toBe(9 * H - (3 * H + 3 * 60));
    expect(
      classifyOfflineForDay({
        totalOfflineSeconds: r.totalOfflineSeconds,
        totalWorkSeconds: r.totalWorkSeconds,
      }).flagExcessiveOffline
    ).toBe(true);
  });

  it("silence while OUTSIDE is offline, not outside — location is not assumed", () => {
    // Seen outside at 12:00 and 12:05, silent until 13:00, then back inside.
    const r = day([
      ...every(T(9), T(12), true),
      ping(T(12), false),
      ping(T(12, 5), false),
      ...every(T(13), T(18), true),
    ]);
    // Only the two vouched-for outside spans count: 5 min + the 8-min window.
    expect(r.totalOutsideSeconds).toBe(13 * 60);
    expect(r.totalOfflineSeconds).toBe(47 * 60);
  });

  it("work always reconciles as inside + outside + offline", () => {
    for (const pings of [
      every(T(9), T(18), true),
      every(T(9), T(12), true),
      [...every(T(9), T(12), true), ...every(T(12), T(13), false), ...every(T(13), T(18), true)],
      [],
    ]) {
      const r = day(pings);
      expect(r.totalInsideSeconds + r.totalOutsideSeconds + r.totalOfflineSeconds).toBe(
        r.totalWorkSeconds
      );
    }
  });

  it("reconciles EXACTLY with sub-second ping timestamps", () => {
    // Every earlier test used whole-minute times, so per-interval Math.floor
    // rounded to nothing and the invariant looked exact when it was not. Real
    // pings land on arbitrary milliseconds: 60 of them used to drift the day
    // ~60 seconds out of balance, which is how two live rows ended up 59s and
    // 56s short after being recomputed.
    const pings = [];
    for (let i = 0; i < 60; i++) {
      // 5-minute cadence plus a jittery fraction of a second, as a real device
      // reports: never a whole second, never the same offset twice.
      pings.push(ping(T(9) + i * 5 * 60_000 + (i * 377) % 1000, true));
    }
    const r = computeDayTotals(
      [{ _id: "a", checkInAt: new Date(T(9) + 431), checkOutAt: new Date(T(14) + 907) }],
      new Map([["a", pings]]),
      T(18),
      { maxIntervalMs: TRUST }
    );
    expect(r.totalInsideSeconds + r.totalOutsideSeconds + r.totalOfflineSeconds).toBe(
      r.totalWorkSeconds
    );
  });

  it("a session with no pings at all is entirely offline", () => {
    const r = day([]);
    expect(r.totalOfflineSeconds).toBe(9 * H);
    expect(r.totalInsideSeconds).toBe(0);
    expect(r.totalOutsideSeconds).toBe(0);
  });

  it("summarizeSessionPings reports offline per session", () => {
    const r = summarizeSessionPings([ping(T(9), true)], T(18), {
      startTimeMs: T(9),
      maxIntervalMs: TRUST,
    });
    expect(r.totalInside).toBe(8 * 60);
    expect(r.offline).toBe(9 * H - 8 * 60);
  });
});
