/**
 * Targeted edge-case tests for the attendance engine logic. Each maps to an item
 * on the edge-case checklist. DB-coupled cases (concurrency, offline re-sync) are
 * covered by the opt-in integration tests; Android cases are manual.
 */
import { describe, it, expect } from "vitest";
import { haversineDistanceMeters, isInsideGeofence } from "@/lib/geo";
import { flagPings, type PingLike } from "@/lib/attendance";
import {
  summarizeSessionPings,
  computeDayTotals,
  evaluateScheduleGate,
  evaluateLateness,
  clampCheckOut,
  type SummaryPing,
} from "@/lib/attendance-logic";

const T = (h: number, m = 0) =>
  new Date(`2026-06-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
const ms = (h: number, m = 0) => T(h, m).getTime();
const ping = (d: Date, inside: boolean): SummaryPing => ({ capturedAt: d, isInsideGeofence: inside });

describe("geofence boundary (exactly at the edge)", () => {
  const center = { lat: 12.915356916409525, lng: 77.64286120026878 };
  const point = { lat: center.lat + 0.001, lng: center.lng }; // ~111m north

  it("is INSIDE when distance == radius (inclusive)", () => {
    const d = haversineDistanceMeters(point, center);
    expect(isInsideGeofence(point, center, d).inside).toBe(true);
  });
  it("is OUTSIDE one millimetre past the radius", () => {
    const d = haversineDistanceMeters(point, center);
    expect(isInsideGeofence(point, center, d - 0.001).inside).toBe(false);
  });
});

describe("grace period = 0", () => {
  it("is on-time exactly at start, late one minute after", () => {
    expect(evaluateLateness(ms(9), ms(9), 0).status).toBe("present");
    expect(evaluateLateness(ms(9), ms(9, 1), 0)).toEqual({ status: "late", lateByMinutes: 1 });
  });
  it("gate with 0 grace blocks even one ms before start", () => {
    const w = { isWorkingDay: true, expectedStartAtMs: ms(9), expectedEndAtMs: ms(18) };
    expect(evaluateScheduleGate(w, 0, ms(9)).ok).toBe(true);
    expect(evaluateScheduleGate(w, 0, ms(9) - 1).ok).toBe(false);
  });
});

describe("out-of-order / future / stale pings", () => {
  it("a FUTURE-timestamp ping contributes no time (clamped to the cap)", () => {
    const pings = [ping(T(9), true), ping(T(23), true)]; // 23:00 is past the 10:00 cap
    const r = summarizeSessionPings(pings, ms(10));
    expect(r.totalInside).toBe(3600); // only 9->10
  });

  it("a stale ping after checkout adds nothing", () => {
    const pings = [ping(T(9), true), ping(T(9, 30), true), ping(T(20), false)];
    const r = summarizeSessionPings(pings, ms(10));
    expect(r.totalOutside).toBe(0);
    expect(r.totalInside).toBe(3600);
  });
});

describe("work-seconds invariants", () => {
  it("a ping BEFORE check-in never changes authoritative WORK seconds", () => {
    const sessions = [{ _id: "A", checkInAt: T(9), checkOutAt: T(10) }];
    const pings = new Map<string, SummaryPing[]>([
      ["A", [ping(T(8), true), ping(T(9), true)]], // an 08:00 ping predates check-in
    ]);
    const r = computeDayTotals(sessions, pings, ms(99));
    // Work is derived from check-in/out, so it stays 1h regardless of ping times.
    expect(r.totalWorkSeconds).toBe(3600);
  });

  it("within a single session, inside + outside == work", () => {
    const r = summarizeSessionPings(
      [ping(T(9), true), ping(T(10), false), ping(T(11), true)],
      ms(12)
    );
    expect(r.totalInside + r.totalOutside).toBe(3 * 3600);
    expect(r.totalOutside).toBeLessThanOrEqual(r.totalInside + r.totalOutside);
  });

  it("back-dated checkout is clamped so work can never go negative", () => {
    expect(clampCheckOut(ms(9), ms(8))).toBe(ms(9));
    const sessions = [{ _id: "A", checkInAt: T(9), checkOutAt: new Date(clampCheckOut(ms(9), ms(8))) }];
    expect(computeDayTotals(sessions, new Map(), ms(99)).totalWorkSeconds).toBe(0);
  });
});

describe("re-entry after auto-checkout & multiple checkouts", () => {
  it("models a re-entry as a second session with an away-gap and counts both", () => {
    // Session 1 auto-closed at 12:00, employee re-enters at 13:00.
    const sessions = [
      { _id: "A", checkInAt: T(9), checkOutAt: T(12) },
      { _id: "B", checkInAt: T(13), checkOutAt: T(17) },
    ];
    const r = computeDayTotals(sessions, new Map(), ms(99));
    expect(r.totalWorkSeconds).toBe(3 * 3600 + 4 * 3600); // both sessions
    // The 12->13 gap is a BREAK (off the clock), not outside-the-fence time.
    expect(r.totalBreakSeconds).toBe(3600);
    expect(r.breakCount).toBe(1);
    expect(r.totalOutsideSeconds).toBe(0);
    expect(r.outsideVisitCount).toBe(0);
  });

  it("three cycles produce two breaks", () => {
    const sessions = [
      { _id: "A", checkInAt: T(9), checkOutAt: T(10) },
      { _id: "B", checkInAt: T(11), checkOutAt: T(12) },
      { _id: "C", checkInAt: T(13), checkOutAt: T(14) },
    ];
    expect(computeDayTotals(sessions, new Map(), ms(99)).breakCount).toBe(2);
  });
});

describe("GPS anomalies", () => {
  const base = (over: Partial<PingLike> & { t: number }): PingLike => ({
    lat: 12.9153,
    lng: 77.6428,
    accuracyMeters: 10,
    isMockLocation: false,
    capturedAt: new Date(over.t),
    ...over,
  });

  it("flags a ~2km jump within one ping interval", () => {
    // 2km east in 60s -> 120 km/h is plausible by car, but the >1km teleport flags.
    const pings = [base({ t: 0 }), base({ t: 60_000, lng: 77.6428 + 0.018 })];
    const reasons = flagPings(pings).flatMap((f) => f.reasons);
    expect(reasons).toContain("large_teleport");
  });

  it("flags a mock-location ping", () => {
    const pings = [base({ t: 0 }), base({ t: 60_000, isMockLocation: true })];
    expect(flagPings(pings).flatMap((f) => f.reasons)).toContain("client_flagged_mock");
  });
});
