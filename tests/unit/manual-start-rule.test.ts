/**
 * The day's FIRST check-in is the employee's own decision.
 *
 * Auto check-in exists to RESUME a day already under way after an automatic
 * check-out — not to begin one. Without that distinction the OS geofence put
 * people on the clock simply for arriving: it fires on entry, and because the
 * fence is registered with INITIAL_TRIGGER_ENTER it fires again on every
 * registration while inside. Production has a day whose first check-in came from
 * geofence_enter and then ran for 11h41m.
 */
import { describe, it, expect } from "vitest";
import { evaluateAutoCheckIn, AUTO_CHECKIN_REASONS } from "@/lib/attendance-logic";

const NOW = Date.parse("2026-09-04T06:00:00Z"); // 11:30 IST, mid-shift
const base = {
  enabled: true,
  isCheckedIn: false,
  noCheckInNeeded: false,
  hasSite: true,
  scheduleStartMs: Date.parse("2026-09-04T04:30:00Z"), // 10:00 IST
  scheduleEndMs: Date.parse("2026-09-04T11:30:00Z"), // 17:00 IST
  graceMinutes: 10,
  lastSessionStatus: null as string | null,
  hasSessionToday: true,
  nowMs: NOW,
};

describe("auto check-in may not start the day", () => {
  it("refuses when nothing has happened today", () => {
    const r = evaluateAutoCheckIn({ ...base, hasSessionToday: false });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe(AUTO_CHECKIN_REASONS.NEEDS_MANUAL_START);
  });

  it("refuses even while standing inside the site during shift hours", () => {
    // Every other condition is satisfied — arrival alone is still not consent.
    expect(
      evaluateAutoCheckIn({ ...base, hasSessionToday: false, lastSessionStatus: null }).ok
    ).toBe(false);
  });

  it("RESUMES after an automatic check-out", () => {
    // Left the site, came back: the day is already under way, so this is the
    // case auto check-in exists for.
    expect(
      evaluateAutoCheckIn({ ...base, hasSessionToday: true, lastSessionStatus: "auto_closed" }).ok
    ).toBe(true);
  });

  it("still refuses after a MANUAL check-out", () => {
    // Deliberately going off the clock outranks having started the day.
    const r = evaluateAutoCheckIn({
      ...base,
      hasSessionToday: true,
      lastSessionStatus: "completed",
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe(AUTO_CHECKIN_REASONS.MANUAL_CHECKOUT);
  });

  it("refuses outside the rostered window even mid-day", () => {
    const r = evaluateAutoCheckIn({
      ...base,
      lastSessionStatus: "auto_closed",
      nowMs: Date.parse("2026-09-04T12:00:00Z"), // 17:30 IST, past shift end
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe(AUTO_CHECKIN_REASONS.OUTSIDE_HOURS);
  });

  it("refuses on a day with no schedule at all", () => {
    const r = evaluateAutoCheckIn({
      ...base,
      lastSessionStatus: "auto_closed",
      scheduleStartMs: null,
      scheduleEndMs: null,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe(AUTO_CHECKIN_REASONS.NO_SCHEDULE);
  });

  it("does nothing while already checked in", () => {
    expect(evaluateAutoCheckIn({ ...base, isCheckedIn: true }).ok).toBe(false);
  });
});
