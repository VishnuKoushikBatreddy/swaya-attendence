/**
 * evaluateAutoCheckIn — whether the app should try to check someone in without
 * a tap.
 *
 * Exists because being inside the site during shift hours is a STATE while the
 * OS geofence only reports TRANSITIONS: someone who arrives at 08:45 gets an
 * ENTER the schedule gate rejects for being early, then never crosses the
 * boundary again, so they are never checked in at 09:00.
 */
import { describe, it, expect } from "vitest";
import { evaluateAutoCheckIn, AUTO_CHECKIN_REASONS as R } from "@/lib/attendance-logic";

const START = new Date("2026-08-17T09:00:00.000Z").getTime();
const END = new Date("2026-08-17T18:00:00.000Z").getTime();
const MIN = 60_000;

type Args = Parameters<typeof evaluateAutoCheckIn>[0];

const base: Args = {
  enabled: true,
  isCheckedIn: false,
  noCheckInNeeded: false,
  hasSite: true,
  scheduleStartMs: START,
  scheduleEndMs: END,
  graceMinutes: 10,
  lastSessionStatus: null,
  nowMs: START + 60 * MIN, // 10:00, comfortably inside the shift
};

const at = (overrides: Partial<Args> = {}) =>
  evaluateAutoCheckIn({ ...base, ...overrides });

describe("evaluateAutoCheckIn — when it fires", () => {
  it("fires inside the shift window", () => {
    expect(at()).toEqual({ ok: true });
  });

  it("fires within the grace period before the shift starts", () => {
    // 08:55, with 10 minutes of grace.
    expect(at({ nowMs: START - 5 * MIN })).toEqual({ ok: true });
  });

  it("fires right at the shift end", () => {
    expect(at({ nowMs: END })).toEqual({ ok: true });
  });

  it("fires after an AUTOMATIC check-out — returning to site re-checks in", () => {
    // Geofence exit / sustained absence / shift end / ping gap all close a
    // session as auto_closed. Coming back should check them in again.
    expect(at({ lastSessionStatus: "auto_closed" })).toEqual({ ok: true });
  });
});

describe("evaluateAutoCheckIn — when it must NOT fire", () => {
  it("does not fire after a MANUAL check-out", () => {
    // The employee chose to leave. Re-checking them in while still on site
    // would make leaving early impossible.
    expect(at({ lastSessionStatus: "completed" })).toEqual({
      ok: false,
      reason: R.MANUAL_CHECKOUT,
    });
  });

  it("does not fire before the grace window opens", () => {
    // 08:45, grace only reaches back to 08:50.
    expect(at({ nowMs: START - 15 * MIN })).toEqual({
      ok: false,
      reason: R.OUTSIDE_HOURS,
    });
  });

  it("does not fire after the shift ends", () => {
    expect(at({ nowMs: END + MIN })).toEqual({ ok: false, reason: R.OUTSIDE_HOURS });
  });

  it("does not fire without a schedule", () => {
    // The server treats "no schedule" as "no restriction", so auto-checking-in
    // would mark someone present for walking past the site at any hour.
    expect(at({ scheduleStartMs: null, scheduleEndMs: null })).toEqual({
      ok: false,
      reason: R.NO_SCHEDULE,
    });
    expect(at({ scheduleEndMs: null })).toEqual({ ok: false, reason: R.NO_SCHEDULE });
  });

  it("does not fire on a day off or approved leave", () => {
    expect(at({ noCheckInNeeded: true })).toEqual({ ok: false, reason: R.NOT_REQUIRED });
  });

  it("does not fire when already checked in", () => {
    expect(at({ isCheckedIn: true })).toEqual({
      ok: false,
      reason: R.ALREADY_CHECKED_IN,
    });
  });

  it("does not fire without an assigned site", () => {
    expect(at({ hasSite: false })).toEqual({ ok: false, reason: R.NO_SITE });
  });

  it("does not fire when disabled server-side", () => {
    expect(at({ enabled: false })).toEqual({ ok: false, reason: R.DISABLED });
  });

  it("checks the kill switch before anything else", () => {
    // Disabling it must win regardless of other state.
    expect(at({ enabled: false, isCheckedIn: true, hasSite: false })).toEqual({
      ok: false,
      reason: R.DISABLED,
    });
  });
});

describe("agreement with the server's schedule gate", () => {
  it("uses the same [start - grace, end] window", () => {
    // Exactly on the grace boundary is inside; one ms earlier is not.
    expect(at({ nowMs: START - 10 * MIN })).toEqual({ ok: true });
    expect(at({ nowMs: START - 10 * MIN - 1 })).toEqual({
      ok: false,
      reason: R.OUTSIDE_HOURS,
    });
  });

  it("honours a zero grace period", () => {
    expect(at({ graceMinutes: 0, nowMs: START - 1 })).toEqual({
      ok: false,
      reason: R.OUTSIDE_HOURS,
    });
    expect(at({ graceMinutes: 0, nowMs: START })).toEqual({ ok: true });
  });
});
