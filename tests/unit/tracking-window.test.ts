/**
 * isWithinTrackingWindow — when the device may collect location at all.
 *
 * Tracking used to run for as long as a session was open, which is not the same
 * as "during the shift": a session that outlived its shift kept the GPS awake
 * for hours afterwards, costing battery and recording positions nobody asked
 * for.
 */
import { describe, it, expect } from "vitest";
import { isWithinTrackingWindow } from "@/lib/attendance-logic";

const START = new Date("2026-08-17T09:00:00.000Z").getTime();
const END = new Date("2026-08-17T18:00:00.000Z").getTime();
const MIN = 60_000;

const at = (nowMs: number, over: Partial<Parameters<typeof isWithinTrackingWindow>[0]> = {}) =>
  isWithinTrackingWindow({
    scheduleStartMs: START,
    scheduleEndMs: END,
    graceMinutes: 10,
    nowMs,
    ...over,
  });

describe("isWithinTrackingWindow", () => {
  it("tracks during the shift", () => {
    expect(at(START)).toBe(true);
    expect(at(START + 4 * 60 * MIN)).toBe(true);
    expect(at(END)).toBe(true);
  });

  it("tracks within the grace period before the shift starts", () => {
    // Someone checking in a few minutes early is tracked from that moment.
    expect(at(START - 5 * MIN)).toBe(true);
    expect(at(START - 10 * MIN)).toBe(true);
  });

  it("does NOT track before the grace period opens", () => {
    expect(at(START - 10 * MIN - 1)).toBe(false);
    expect(at(START - 3 * 60 * MIN)).toBe(false);
  });

  it("does NOT track after the shift ends", () => {
    // The case this exists for: the session may still be open, but the shift is
    // over and there is no reason to keep the GPS awake.
    expect(at(END + 1)).toBe(false);
    expect(at(END + 4 * 60 * MIN)).toBe(false);
  });

  it("tracks all day when there is no schedule", () => {
    // Check-in is ungated without a schedule, so restricting tracking would mean
    // unscheduled work produced no location data at all.
    expect(at(START + 60 * MIN, { scheduleStartMs: null, scheduleEndMs: null })).toBe(true);
    expect(at(END + 5 * 60 * MIN, { scheduleStartMs: null, scheduleEndMs: null })).toBe(true);
  });

  it("treats a half-specified schedule as no schedule", () => {
    expect(at(END + 60 * MIN, { scheduleEndMs: null })).toBe(true);
    expect(at(START - 60 * MIN, { scheduleStartMs: null })).toBe(true);
  });

  it("honours a zero grace period", () => {
    expect(at(START - 1, { graceMinutes: 0 })).toBe(false);
    expect(at(START, { graceMinutes: 0 })).toBe(true);
  });

  it("agrees with the check-in window, so tracking cannot outlive the shift", () => {
    // Both use [start - grace, end]; a mismatch would leave the GPS running
    // after the server had already stopped accepting the shift.
    expect(at(END)).toBe(true);
    expect(at(END + 1)).toBe(false);
  });
});
