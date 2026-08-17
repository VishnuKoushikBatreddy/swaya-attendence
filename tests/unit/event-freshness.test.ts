/**
 * Staleness guard for client-supplied event timestamps.
 *
 * The native geofence receiver now retries failed uploads, so `capturedAt` may
 * legitimately be hours old and MUST still be honoured — otherwise the retry
 * queue is pointless. The guard exists to bound that window, because these
 * requests are authenticated by a long-lived native token.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateEventFreshness,
  EVENT_STALE_REASON,
  EVENT_FUTURE_REASON,
  EVENT_INVALID_REASON,
} from "@/lib/attendance-logic";

const NOW = 1_800_000_000_000;
const MAX_AGE = 12 * 60 * 60_000; // 12 hours
const MAX_SKEW = 5 * 60_000; // 5 minutes

const check = (capturedAt: number) =>
  evaluateEventFreshness(capturedAt, NOW, MAX_AGE, MAX_SKEW);

describe("evaluateEventFreshness", () => {
  it("accepts an event captured right now", () => {
    expect(check(NOW)).toEqual({ ok: true });
  });

  it("accepts a late-arriving event within the window — the retry-queue case", () => {
    expect(check(NOW - 60 * 60_000)).toEqual({ ok: true }); // 1 hour late
    expect(check(NOW - 8 * 60 * 60_000)).toEqual({ ok: true }); // 8 hours late
  });

  it("accepts an event exactly at the age boundary", () => {
    expect(check(NOW - MAX_AGE)).toEqual({ ok: true });
  });

  it("rejects an event past the age boundary", () => {
    const res = check(NOW - MAX_AGE - 1);
    expect(res).toEqual({ ok: false, reason: EVENT_STALE_REASON });
  });

  it("rejects an event from days ago", () => {
    expect(check(NOW - 3 * 24 * 60 * 60_000)).toEqual({
      ok: false,
      reason: EVENT_STALE_REASON,
    });
  });

  it("tolerates a device clock running slightly fast", () => {
    expect(check(NOW + MAX_SKEW)).toEqual({ ok: true });
  });

  it("rejects a timestamp beyond the clock-skew tolerance", () => {
    expect(check(NOW + MAX_SKEW + 1)).toEqual({
      ok: false,
      reason: EVENT_FUTURE_REASON,
    });
  });

  it("rejects an unparseable timestamp", () => {
    // new Date("nonsense").getTime() is NaN — must not slip through as 0.
    expect(check(new Date("nonsense").getTime())).toEqual({
      ok: false,
      reason: EVENT_INVALID_REASON,
    });
  });

  it("treats the epoch as stale rather than valid", () => {
    expect(check(0)).toEqual({ ok: false, reason: EVENT_STALE_REASON });
  });
});
