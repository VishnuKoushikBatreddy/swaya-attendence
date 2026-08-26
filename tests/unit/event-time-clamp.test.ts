/**
 * clampEventTimeToNow — the upper bound on a device-supplied event time.
 *
 * evaluateEventFreshness tolerates a few minutes of clock skew so a slightly
 * fast phone isn't rejected outright. That tolerance must not turn into free
 * work time: a future-dated EXIT would extend a session past the present, and a
 * future-dated ENTER would be compared against the shift start by
 * evaluateLateness. Past times are untouched — back-dating is exactly what the
 * native retry queue exists to deliver.
 */
import { describe, it, expect } from "vitest";
import { clampEventTimeToNow } from "@/lib/attendance-logic";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("clampEventTimeToNow", () => {
  it("leaves a past event exactly where it is", () => {
    expect(clampEventTimeToNow(NOW - 45 * MIN, NOW)).toBe(NOW - 45 * MIN);
  });

  it("leaves an event captured right now alone", () => {
    expect(clampEventTimeToNow(NOW, NOW)).toBe(NOW);
  });

  it("pulls a future event back to now", () => {
    expect(clampEventTimeToNow(NOW + 3 * MIN, NOW)).toBe(NOW);
  });

  it("pulls back an event inside the skew tolerance — the over-credit case", () => {
    // Within evaluateEventFreshness's 5-minute allowance, so it is accepted by
    // the route; without this clamp it would credit 4 unearned minutes.
    expect(clampEventTimeToNow(NOW + 4 * MIN, NOW)).toBe(NOW);
  });

  it("falls back to now for an unparseable timestamp", () => {
    expect(clampEventTimeToNow(new Date("nonsense").getTime(), NOW)).toBe(NOW);
  });

  it("preserves a long back-dated delivery from the retry queue", () => {
    // A dead-zone EXIT delivered 8 hours later must still apply at its own time.
    const eightHoursAgo = NOW - 8 * 60 * MIN;
    expect(clampEventTimeToNow(eightHoursAgo, NOW)).toBe(eightHoursAgo);
  });
});
