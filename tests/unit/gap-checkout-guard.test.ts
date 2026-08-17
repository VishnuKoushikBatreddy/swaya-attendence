/**
 * shouldGapCheckout — the guard that stops a ping gap from erasing a shift.
 *
 * processCheckIn writes a LocationPing at the check-in instant. If no further
 * ping ever arrives, that check-in ping is the "last ping", and closing the
 * session at it yields checkOutAt === checkInAt: a zero-length session with the
 * whole shift lost. The native watcher is distance-triggered, so a stationary
 * employee genuinely emits nothing — this was reachable in normal use.
 */
import { describe, it, expect } from "vitest";
import { shouldGapCheckout } from "@/lib/attendance-logic";

const MIN = 60_000;
const GAP = 15 * MIN;
const CHECK_IN = new Date("2026-08-17T09:00:00.000Z").getTime();

const decide = (lastPingOffsetMin: number, nextPingOffsetMin: number) =>
  shouldGapCheckout({
    checkInMs: CHECK_IN,
    lastPingMs: CHECK_IN + lastPingOffsetMin * MIN,
    nextPingMs: CHECK_IN + nextPingOffsetMin * MIN,
    gapThresholdMs: GAP,
  });

describe("shouldGapCheckout", () => {
  it("closes when tracking ran and then went silent past the threshold", () => {
    // Pinged until 09:20, silent until 10:00 — a real 40-minute gap.
    expect(decide(20, 60)).toBe(true);
  });

  it("does NOT close when the only ping is the one written at check-in", () => {
    // The regression: no ping after check-in, then one arrives 45 min later.
    // Closing here would set checkOutAt === checkInAt and erase the shift.
    expect(decide(0, 45)).toBe(false);
  });

  it("does NOT close when the last ping predates check-in", () => {
    // A leftover ping from an earlier session must not become the check-out.
    expect(decide(-30, 45)).toBe(false);
  });

  it("closes once even a single ping exists after check-in", () => {
    // One minute of tracking is still evidence of presence to close at.
    expect(decide(1, 45)).toBe(true);
  });

  it("does not close while pings are arriving normally", () => {
    expect(decide(20, 23)).toBe(false); // 3-minute cadence
  });

  it("does not close exactly at the threshold — only beyond it", () => {
    expect(decide(20, 35)).toBe(false); // exactly 15 min
    expect(decide(20, 35.1)).toBe(true);
  });

  it("still requires the gap even when pings exist after check-in", () => {
    // Plenty of tracking, but no gap — nothing to close.
    expect(decide(30, 31)).toBe(false);
  });
});
