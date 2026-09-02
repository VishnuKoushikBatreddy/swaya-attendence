import { describe, it, expect } from "vitest";
import {
  summarizeSessionPings,
  computeDayTotals,
  isReliablePing,
  effectiveInsideState,
  isSustainedAway,
  evaluateScheduleGate,
  evaluateLateness,
  clampCheckOut,
  resolveShiftEnd,
  resolveAutoCheckout,
  isPingGapCheckout,
  deriveCheckoutSource,
  classifyOutsideForDay,
  GATE_DAY_OFF_REASON,
  GATE_OUT_OF_HOURS_REASON,
  GATE_NO_SCHEDULE_REASON,
  type SummaryPing,
} from "@/lib/attendance-logic";

// --- time helpers (all UTC; timezone handling is tested in workdate.test.ts) ---
const T = (h: number, m = 0) =>
  new Date(`2026-06-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
const ms = (h: number, m = 0) => T(h, m).getTime();
const ping = (d: Date, inside: boolean): SummaryPing => ({
  capturedAt: d,
  isInsideGeofence: inside,
});

// ===========================================================================
// summarizeSessionPings — per-session inside/outside accounting
// ===========================================================================
describe("summarizeSessionPings", () => {
  it("is all-zero for no pings", () => {
    expect(summarizeSessionPings([], ms(12))).toEqual({
      totalInside: 0,
      totalOutside: 0,
      outsideVisitCount: 0,
      offline: 0,
    });
  });

  it("accumulates continuous inside time to the session-end cap", () => {
    const pings = [ping(T(9), true), ping(T(10), true), ping(T(11), true)];
    const r = summarizeSessionPings(pings, ms(12));
    expect(r.totalInside).toBe(3 * 3600);
    expect(r.totalOutside).toBe(0);
    expect(r.outsideVisitCount).toBe(0);
  });

  it("counts one excursion as one outside visit", () => {
    const pings = [ping(T(9), true), ping(T(10), false), ping(T(11), true)];
    const r = summarizeSessionPings(pings, ms(12));
    expect(r.totalInside).toBe(2 * 3600);
    expect(r.totalOutside).toBe(3600);
    expect(r.outsideVisitCount).toBe(1);
  });

  it("STALE/OUT-OF-CAP: a ping after the cap contributes no time", () => {
    const pings = [ping(T(9), true), ping(T(10), true), ping(T(20), true)];
    const r = summarizeSessionPings(pings, ms(11));
    // 9->10 = 3600, 10->cap(11) = 3600, the 20:00 ping adds 0 (clamped).
    expect(r.totalInside).toBe(2 * 3600);
  });

  it("never yields a negative duration when pings are out of order", () => {
    const pings = [ping(T(12), true), ping(T(9), false)];
    const r = summarizeSessionPings(pings, ms(10));
    expect(r.totalInside).toBeGreaterThanOrEqual(0);
    expect(r.totalOutside).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// computeDayTotals — cumulative across multiple check-in/out cycles per day
// ===========================================================================
describe("computeDayTotals", () => {
  it("computes work seconds for a single closed session", () => {
    const sessions = [{ _id: "A", checkInAt: T(9), checkOutAt: T(12) }];
    const r = computeDayTotals(sessions, new Map(), ms(99));
    expect(r.totalWorkSeconds).toBe(3 * 3600);
  });

  it("counts an OPEN session's work up to nowMs", () => {
    const sessions = [{ _id: "A", checkInAt: T(9), checkOutAt: null }];
    const r = computeDayTotals(sessions, new Map(), ms(9) + 3600_000);
    expect(r.totalWorkSeconds).toBe(3600);
  });

  it("MULTIPLE CYCLES: sums work, inside, outside and the away-gap between sessions", () => {
    const sessions = [
      { _id: "A", checkInAt: T(9), checkOutAt: T(12) },
      { _id: "B", checkInAt: T(13), checkOutAt: T(14) },
    ];
    const pings = new Map<string, SummaryPing[]>([
      ["A", [ping(T(9), true), ping(T(10), false), ping(T(11), true)]],
      ["B", [ping(T(13), true)]],
    ]);
    const r = computeDayTotals(sessions, pings, ms(99));

    // work = 3h (A) + 1h (B)
    expect(r.totalWorkSeconds).toBe(4 * 3600);
    // inside = (9->10 + 11->12) [A] + (13->14) [B]
    expect(r.totalInsideSeconds).toBe(3 * 3600);
    // outside = ONLY the in-session excursion (10->11) in A. The 12->13 gap
    // between sessions is a BREAK: off the clock, so not "outside".
    expect(r.totalOutsideSeconds).toBe(3600);
    expect(r.outsideVisitCount).toBe(1);
    expect(r.totalBreakSeconds).toBe(3600);
    expect(r.breakCount).toBe(1);
  });

  it("does not double-count work when sessions are back-to-back (no away gap seconds)", () => {
    const sessions = [
      { _id: "A", checkInAt: T(9), checkOutAt: T(12) },
      { _id: "B", checkInAt: T(12), checkOutAt: T(13) },
    ];
    const r = computeDayTotals(sessions, new Map(), ms(99));
    expect(r.totalWorkSeconds).toBe(4 * 3600);
    // The break is 0 seconds long but is still a break transition; it must not
    // appear as outside-the-fence time.
    expect(r.totalBreakSeconds).toBe(0);
    expect(r.breakCount).toBe(1);
    expect(r.outsideVisitCount).toBe(0);
  });
});

// ===========================================================================
// GPS accuracy / drift protection
// ===========================================================================
describe("isReliablePing", () => {
  it("treats a missing accuracy as reliable", () => {
    expect(isReliablePing(null, 100)).toBe(true);
    expect(isReliablePing(undefined, 100)).toBe(true);
  });
  it("is reliable at exactly the limit, unreliable beyond it", () => {
    expect(isReliablePing(100, 100)).toBe(true);
    expect(isReliablePing(101, 100)).toBe(false);
  });
});

describe("effectiveInsideState (drift protection)", () => {
  it("uses the reported state for a reliable ping", () => {
    expect(effectiveInsideState(false, 20, true, 100)).toBe(false);
    expect(effectiveInsideState(true, 20, false, 100)).toBe(true);
  });
  it("CARRIES the previous state forward for an unreliable ping", () => {
    // Junk reading says 'outside' but accuracy is terrible -> keep 'inside'.
    expect(effectiveInsideState(false, 500, true, 100)).toBe(true);
    expect(effectiveInsideState(true, 500, false, 100)).toBe(false);
  });
});

// ===========================================================================
// Auto-checkout trigger (sustained absence)
// ===========================================================================
describe("isSustainedAway (auto-checkout trigger)", () => {
  const threshold = 70; // radius 20 + buffer 50
  const away = { accuracyMeters: 10, distanceFromSiteMeters: 200 };
  const inside = { accuracyMeters: 10, distanceFromSiteMeters: 5 };

  it("triggers when the last N pings are all reliably beyond the threshold", () => {
    expect(isSustainedAway([away, away, away], 3, threshold, 100)).toBe(true);
  });

  it("does NOT trigger with fewer than N pings", () => {
    expect(isSustainedAway([away, away], 3, threshold, 100)).toBe(false);
  });

  it("GPS DRIFT: a single inside ping in the streak prevents trigger", () => {
    expect(isSustainedAway([away, inside, away], 3, threshold, 100)).toBe(false);
  });

  it("an INACCURATE away ping breaks the streak (junk can't check you out)", () => {
    const inaccurate = { accuracyMeters: 500, distanceFromSiteMeters: 300 };
    expect(isSustainedAway([away, away, inaccurate], 3, threshold, 100)).toBe(false);
  });

  it("does not trigger when within the threshold (just past the radius, inside buffer)", () => {
    const nearBoundary = { accuracyMeters: 10, distanceFromSiteMeters: 60 };
    expect(isSustainedAway([nearBoundary, nearBoundary, nearBoundary], 3, threshold, 100)).toBe(
      false
    );
  });
});

// ===========================================================================
// Scheduled-hours gate + holiday / week-off
// ===========================================================================
describe("evaluateScheduleGate", () => {
  const window = { isWorkingDay: true, expectedStartAtMs: ms(9), expectedEndAtMs: ms(18) };

  it("REFUSES when nothing is scheduled for the day", () => {
    // An unscheduled day means "you are not working today". Waving it through
    // read the absence of a record as the absence of a rule, so anyone could
    // clock in on any day and rostering did nothing.
    const r = evaluateScheduleGate(null, 0, ms(10));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe(GATE_NO_SCHEDULE_REASON);
  });

  it("allows an unscheduled day when the deployment does not roster", () => {
    // A company that never uses the schedule feature would otherwise be locked
    // out entirely — their empty schedule collection really does mean "no rule".
    expect(
      evaluateScheduleGate(null, 0, ms(10), { requireSchedule: false })
    ).toEqual({ ok: true });
  });

  it("HOLIDAY / WEEK-OFF: blocks a scheduled non-working day", () => {
    const r = evaluateScheduleGate({ isWorkingDay: false }, 0, ms(10));
    expect(r).toEqual({ ok: false, reason: GATE_DAY_OFF_REASON });
  });

  it("allows check-in inside the shift window", () => {
    expect(evaluateScheduleGate(window, 0, ms(10)).ok).toBe(true);
  });

  it("blocks before the start minus grace", () => {
    // start 09:00, grace 10m -> allowed from 08:50. 08:40 is too early.
    const r = evaluateScheduleGate(window, 10, ms(8, 40));
    expect(r).toEqual({ ok: false, reason: GATE_OUT_OF_HOURS_REASON });
  });

  it("allows exactly at start minus grace (inclusive)", () => {
    expect(evaluateScheduleGate(window, 10, ms(8, 50)).ok).toBe(true);
  });

  it("blocks after the shift end", () => {
    const r = evaluateScheduleGate(window, 0, ms(18) + 1);
    expect(r).toEqual({ ok: false, reason: GATE_OUT_OF_HOURS_REASON });
  });

  it("allows exactly at the shift end (inclusive)", () => {
    expect(evaluateScheduleGate(window, 0, ms(18)).ok).toBe(true);
  });

  it("has no time gate when the working day has no start/end window", () => {
    expect(evaluateScheduleGate({ isWorkingDay: true }, 0, ms(3)).ok).toBe(true);
  });
});

// ===========================================================================
// Grace-period late detection
// ===========================================================================
describe("evaluateLateness", () => {
  it("is present within grace", () => {
    // start 09:00, grace 10m, arrive 09:08 -> present
    expect(evaluateLateness(ms(9), ms(9, 8), 10)).toEqual({
      status: "present",
      lateByMinutes: 0,
    });
  });

  it("is present EXACTLY at the grace boundary (strictly greater is late)", () => {
    expect(evaluateLateness(ms(9), ms(9, 10), 10).status).toBe("present");
  });

  it("is late just past the grace boundary", () => {
    const r = evaluateLateness(ms(9), ms(9, 25), 10);
    expect(r.status).toBe("late");
    expect(r.lateByMinutes).toBe(25);
  });

  it("is present (no late tracking) when there is no scheduled start", () => {
    expect(evaluateLateness(null, ms(11), 10)).toEqual({
      status: "present",
      lateByMinutes: 0,
    });
  });

  it("floors partial late minutes", () => {
    // 9:00 start, 0 grace, arrive 9:25:59 -> 25 minutes late (floored)
    const arrive = ms(9, 25) + 59_000;
    expect(evaluateLateness(ms(9), arrive, 0).lateByMinutes).toBe(25);
  });
});

// ===========================================================================
// Back-dated check-out clamp + overnight shift resolution
// ===========================================================================
describe("clampCheckOut", () => {
  it("clamps a check-out that lands before check-in", () => {
    expect(clampCheckOut(ms(9), ms(8))).toBe(ms(9));
  });
  it("passes a normal check-out through unchanged", () => {
    expect(clampCheckOut(ms(9), ms(17))).toBe(ms(17));
  });
});

describe("resolveShiftEnd (overnight shift)", () => {
  it("keeps a normal same-day end", () => {
    expect(resolveShiftEnd(ms(9), ms(18))).toBe(ms(18));
  });
  it("OVERNIGHT: pushes an end at/before start to the next day", () => {
    // 22:00 -> 06:00 ends next day
    expect(resolveShiftEnd(ms(22), ms(6))).toBe(ms(6) + 86_400_000);
  });
  it("treats an equal end as overnight (+1 day)", () => {
    expect(resolveShiftEnd(ms(9), ms(9))).toBe(ms(9) + 86_400_000);
  });
});

// ===========================================================================
// Audit-ledger source derivation.
// ===========================================================================
describe("deriveCheckoutSource", () => {
  it("maps each auto-checkout reason to its ledger source", () => {
    expect(deriveCheckoutSource("auto_checkout_geofence_exit")).toBe("geofence_exit");
    expect(deriveCheckoutSource("auto_checkout_left_site")).toBe("auto_sustained_absence");
    expect(deriveCheckoutSource("auto_checkout_shift_ended")).toBe("auto_shift_end");
    expect(deriveCheckoutSource("auto_checkout_ping_gap")).toBe("auto_ping_gap");
  });
  it("defaults to manual when there is no reason", () => {
    expect(deriveCheckoutSource(undefined)).toBe("manual");
    expect(deriveCheckoutSource(null)).toBe("manual");
    expect(deriveCheckoutSource("something_else")).toBe("manual");
  });
});

// ===========================================================================
// Ping-gap auto-checkout: a silence longer than the threshold ends the session.
// ===========================================================================
describe("isPingGapCheckout", () => {
  const FIVE_MIN = 5 * 60_000;

  it("triggers when the gap exceeds the threshold (app was closed)", () => {
    expect(isPingGapCheckout(ms(9), ms(9) + 6 * 60_000, FIVE_MIN)).toBe(true);
  });

  it("does NOT trigger at exactly the threshold (strictly greater)", () => {
    expect(isPingGapCheckout(ms(9), ms(9) + 5 * 60_000, FIVE_MIN)).toBe(false);
  });

  it("does NOT trigger for a normal 3-minute ping interval", () => {
    expect(isPingGapCheckout(ms(9), ms(9) + 3 * 60_000, FIVE_MIN)).toBe(false);
  });

  it("triggers for a long closure (e.g. 40 minutes)", () => {
    expect(isPingGapCheckout(ms(9), ms(9, 40), FIVE_MIN)).toBe(true);
  });
});

// ===========================================================================
// Lunch-aware auto-checkout (suppress only while CURRENTLY in lunch; clamp a
// lunch departure's checkout to lunch-end). Lunch window 13:00–14:00.
// ===========================================================================
describe("resolveAutoCheckout (lunch edge case)", () => {
  const lunchEndMs = ms(14); // 14:00
  const cfg = { lunchEnabled: true, lunchEndMs };

  it("SUPPRESSES while the current ping is inside lunch (left during lunch)", () => {
    const r = resolveAutoCheckout({
      ...cfg,
      leftAtMs: ms(13, 5), // left 13:05
      currentInLunch: true, // it's now ~13:30
      leftInLunch: true,
    });
    expect(r.suppress).toBe(true);
  });

  it("LEFT DURING LUNCH, still out after 14:00 -> checks out at lunch-end (14:00)", () => {
    const r = resolveAutoCheckout({
      ...cfg,
      leftAtMs: ms(13, 5), // left 13:05 (during lunch)
      currentInLunch: false, // now it's e.g. 14:20
      leftInLunch: true,
    });
    expect(r.suppress).toBe(false);
    expect(r.checkOutAtMs).toBe(ms(14)); // paid through lunch only
  });

  it("LEFT OUTSIDE LUNCH -> checks out at the actual exit time", () => {
    const r = resolveAutoCheckout({
      ...cfg,
      leftAtMs: ms(15, 30), // left 15:30, well after lunch
      currentInLunch: false,
      leftInLunch: false,
    });
    expect(r.suppress).toBe(false);
    expect(r.checkOutAtMs).toBe(ms(15, 30));
  });

  it("left BEFORE lunch and stayed out -> checks out at the real exit, not lunch-end", () => {
    const r = resolveAutoCheckout({
      ...cfg,
      leftAtMs: ms(12, 30), // left 12:30 (before lunch)
      currentInLunch: false,
      leftInLunch: false,
    });
    expect(r.checkOutAtMs).toBe(ms(12, 30));
  });

  it("lunch disabled -> never suppresses, checks out at exit time", () => {
    const r = resolveAutoCheckout({
      leftAtMs: ms(13, 30),
      lunchEnabled: false,
      currentInLunch: false,
      leftInLunch: false,
      lunchEndMs,
    });
    expect(r.suppress).toBe(false);
    expect(r.checkOutAtMs).toBe(ms(13, 30));
  });
});

// ===========================================================================
// Outside time only counts when the employee actually checked out mid-day.
// (Outside time counts regardless of mid-day check-outs — see the rationale in
// classifyOutsideForDay. The old "single session means jitter" exemption made
// NOT checking out more favourable than doing so honestly.)
// ===========================================================================
describe("classifyOutsideForDay", () => {
  it("flags excessive outside time even with a single continuous session", () => {
    // Previously exempted as jitter: this is the loophole that rewarded staying
    // checked in while away for hours.
    const r = classifyOutsideForDay({ totalOutsideSeconds: 37 * 60 });
    expect(r.flagExcessiveOutside).toBe(true);
    expect(r.outsideCounts).toBe(true);
  });

  it("zero outside is a clean day", () => {
    const r = classifyOutsideForDay({ totalOutsideSeconds: 0 });
    expect(r.flagExcessiveOutside).toBe(false);
    expect(r.outsideCounts).toBe(true);
  });

  it("flags large outside time", () => {
    const r = classifyOutsideForDay({ totalOutsideSeconds: 45 * 60 });
    expect(r.flagExcessiveOutside).toBe(true);
  });

  it("tolerates outside time under the threshold (boundary jitter)", () => {
    expect(classifyOutsideForDay({ totalOutsideSeconds: 10 * 60 }).flagExcessiveOutside).toBe(false);
    expect(classifyOutsideForDay({ totalOutsideSeconds: 30 * 60 }).flagExcessiveOutside).toBe(false);
    expect(classifyOutsideForDay({ totalOutsideSeconds: 30 * 60 + 1 }).flagExcessiveOutside).toBe(true);
  });

  it("honours a custom flag threshold", () => {
    expect(
      classifyOutsideForDay({ totalOutsideSeconds: 20 * 60, flagThresholdSeconds: 15 * 60 })
        .flagExcessiveOutside
    ).toBe(true);
  });
});
