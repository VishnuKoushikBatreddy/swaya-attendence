/**
 * Regression tests for the work/outside time accounting defects.
 *
 * Each block names the wrong behaviour it replaces, so a future change that
 * reintroduces one fails here rather than silently mis-paying someone.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeSessionPings,
  computeDayTotals,
  classifyOutsideForDay,
  resolveDayStatus,
} from "@/lib/attendance-logic";

const T = (h: number, m = 0) => new Date(2026, 7, 17, h, m, 0).getTime();
const ping = (t: number, inside: boolean) => ({
  capturedAt: new Date(t),
  isInsideGeofence: inside,
});
const every = (from: number, to: number, stepMin: number, inside: boolean) => {
  const out = [];
  for (let t = from; t < to; t += stepMin * 60_000) out.push(ping(t, inside));
  return out;
};
const TRUST = 5 * 60_000; // 5-minute trust window

describe("#1 a stale ping must not be extrapolated across a long gap", () => {
  it("credits only the trust window from a single check-in ping", () => {
    // Was: one 09:00 ping credited the whole 9-hour shift as inside.
    const r = summarizeSessionPings([ping(T(9), true)], T(18), {
      startTimeMs: T(9),
      maxIntervalMs: TRUST,
    });
    expect(r.totalInside).toBe(5 * 60);
    expect(r.offline).toBe(9 * 3600 - 5 * 60);
  });

  it("accounts a normally-tracked shift in full", () => {
    // 3-minute pings are inside the 5-minute window, so nothing is lost.
    const r = summarizeSessionPings(every(T(9), T(18), 3, true), T(18), {
      startTimeMs: T(9),
      maxIntervalMs: TRUST,
    });
    expect(r.totalInside).toBe(9 * 3600);
    expect(r.offline).toBe(0);
  });

  it("does not invent presence for an open session whose pings stopped", () => {
    // Open since 09:00, last ping 14:00, now 16:00.
    const r = computeDayTotals(
      [{ _id: "a", checkInAt: new Date(T(9)), checkOutAt: null }],
      new Map([["a", every(T(9), T(14), 3, true)]]),
      T(16),
      { maxIntervalMs: TRUST }
    );
    expect(r.totalWorkSeconds).toBe(7 * 3600);
    // Pings run 09:00–13:57; the last one vouches for 5 more minutes, so
    // presence is established to 14:02 — 5h02m, not the full 7h.
    expect(r.totalInsideSeconds).toBe(4 * 3600 + 57 * 60 + 5 * 60);
    expect(r.totalInsideSeconds).toBeLessThan(6 * 3600);
    // The rest is reported as unknown rather than assumed.
    expect(
      r.totalInsideSeconds + r.totalOutsideSeconds + r.totalOfflineSeconds
    ).toBe(r.totalWorkSeconds);
  });
});

describe("#5 pings captured before check-in must not count", () => {
  it("clamps an early ping to the session start", () => {
    // Was: an 08:00 ping gave 2h inside for a 1h session.
    const r = summarizeSessionPings(
      [ping(T(8), true), ...every(T(9), T(10), 3, true)],
      T(10),
      { startTimeMs: T(9), maxIntervalMs: TRUST }
    );
    expect(r.totalInside).toBe(3600);
  });
});

describe("#2/#4 breaks are separate from outside, and totals reconcile", () => {
  const lunchDay = () =>
    computeDayTotals(
      [
        { _id: "a", checkInAt: new Date(T(9)), checkOutAt: new Date(T(13)) },
        { _id: "b", checkInAt: new Date(T(14)), checkOutAt: new Date(T(18)) },
      ],
      new Map([
        ["a", every(T(9), T(13), 3, true)],
        ["b", every(T(14), T(18), 3, true)],
      ]),
      T(18),
      { maxIntervalMs: TRUST }
    );

  it("reports a lunch break as break time, not outside time", () => {
    const r = lunchDay();
    expect(r.totalBreakSeconds).toBe(3600);
    expect(r.breakCount).toBe(1);
    expect(r.totalOutsideSeconds).toBe(0);
  });

  it("does NOT flag a normal lunch break", () => {
    // Was: the 1h gap counted as outside and tripped the 30-minute threshold.
    const r = lunchDay();
    expect(classifyOutsideForDay({ totalOutsideSeconds: r.totalOutsideSeconds })
      .flagExcessiveOutside).toBe(false);
  });

  it("reconciles: work = inside + outside + offline", () => {
    const r = lunchDay();
    expect(r.totalInsideSeconds + r.totalOutsideSeconds + r.totalOfflineSeconds).toBe(
      r.totalWorkSeconds
    );
  });
});

describe("#3 staying checked in while away is no longer rewarded", () => {
  // 4 hours outside the fence, never checked out.
  const away = computeDayTotals(
    [{ _id: "a", checkInAt: new Date(T(9)), checkOutAt: new Date(T(18)) }],
    new Map([
      [
        "a",
        [
          ...every(T(9), T(10), 3, true),
          ...every(T(10), T(14), 3, false),
          ...every(T(14), T(18), 3, true),
        ],
      ],
    ]),
    T(18),
    { maxIntervalMs: TRUST }
  );

  it("counts the outside time", () => {
    expect(away.totalOutsideSeconds).toBe(4 * 3600);
    expect(away.totalInsideSeconds).toBe(5 * 3600);
  });

  it("flags it even though there was no mid-day check-out", () => {
    // Was: exempted as "GPS jitter", so a 4-hour absence went unflagged.
    expect(
      classifyOutsideForDay({ totalOutsideSeconds: away.totalOutsideSeconds })
        .flagExcessiveOutside
    ).toBe(true);
  });
});

describe("#6/#7 day status is derived, not mutated", () => {
  it("half_day is no longer a one-way door", () => {
    // 3h -> half_day, then a second session brings the day to 6h.
    expect(
      resolveDayStatus({ currentStatus: "half_day", totalWorkSeconds: 6 * 3600, lateByMinutes: 0 })
    ).toBe("present");
  });

  it("a short day is half_day even when the employee was late", () => {
    // Was: "late" matched neither branch, so 2h after a late arrival stayed late.
    expect(
      resolveDayStatus({ currentStatus: "late", totalWorkSeconds: 2 * 3600, lateByMinutes: 25 })
    ).toBe("half_day");
  });

  it("keeps late for a full day that started late", () => {
    expect(
      resolveDayStatus({ currentStatus: "late", totalWorkSeconds: 8 * 3600, lateByMinutes: 25 })
    ).toBe("late");
  });

  it("marks a full on-time day present", () => {
    expect(
      resolveDayStatus({ currentStatus: "pending", totalWorkSeconds: 8 * 3600, lateByMinutes: 0 })
    ).toBe("present");
  });

  it("is idempotent — recomputing does not drift", () => {
    const once = resolveDayStatus({
      currentStatus: "pending",
      totalWorkSeconds: 3 * 3600,
      lateByMinutes: 0,
    });
    const twice = resolveDayStatus({
      currentStatus: once,
      totalWorkSeconds: 3 * 3600,
      lateByMinutes: 0,
    });
    expect(once).toBe("half_day");
    expect(twice).toBe("half_day");
  });

  it("never overwrites absence", () => {
    expect(
      resolveDayStatus({ currentStatus: "absent", totalWorkSeconds: 0, lateByMinutes: 0 })
    ).toBe("absent");
  });
});
