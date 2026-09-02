/**
 * When the ping system and the geofence disagree, the geofence wins.
 *
 * A ping gap means "tracking stopped". That is NOT the same statement as "the
 * employee left", and only the OS geofence can make the second one. Production
 * closed a session for silence while the geofence still had the employee 24m
 * from the centre with no EXIT ever fired — their GPS had starved indoors. They
 * lost 22 minutes and had to check in again for a failure that was the phone's.
 */
import { describe, it, expect } from "vitest";
import { shouldGapCheckout } from "@/lib/attendance-logic";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const THRESHOLD = 15 * MIN;

const base = {
  checkInMs: T0,
  lastPingMs: T0 + 10 * MIN,
  nextPingMs: T0 + 40 * MIN, // 30-minute silence, well past the threshold
  gapThresholdMs: THRESHOLD,
};

describe("shouldGapCheckout vs the geofence", () => {
  it("does NOT close when they were last seen inside and never exited", () => {
    // The real-world case: GPS starved indoors. Silence is a tracking failure,
    // not a departure. The gap is still reported honestly as offline time.
    expect(
      shouldGapCheckout({ ...base, lastPingWasInside: true, sawExitAfterLastPing: false })
    ).toBe(false);
  });

  it("DOES close when the geofence saw them leave", () => {
    expect(
      shouldGapCheckout({ ...base, lastPingWasInside: true, sawExitAfterLastPing: true })
    ).toBe(true);
  });

  it("DOES close when the last ping already had them outside", () => {
    // No EXIT needed: the pings themselves say they were away when tracking died.
    expect(
      shouldGapCheckout({ ...base, lastPingWasInside: false, sawExitAfterLastPing: false })
    ).toBe(true);
  });

  it("still closes when the geofence state is unknown", () => {
    // Callers that cannot supply the evidence keep the original behaviour.
    expect(shouldGapCheckout(base)).toBe(true);
  });

  it("never closes on a gap shorter than the threshold", () => {
    expect(
      shouldGapCheckout({
        ...base,
        nextPingMs: T0 + 20 * MIN, // only 10 minutes of silence
        lastPingWasInside: false,
        sawExitAfterLastPing: true,
      })
    ).toBe(false);
  });

  it("never closes when no ping followed the check-in", () => {
    // There would be nothing to back-date the check-out to.
    expect(
      shouldGapCheckout({
        ...base,
        lastPingMs: T0 - MIN,
        lastPingWasInside: false,
        sawExitAfterLastPing: true,
      })
    ).toBe(false);
  });

  it("reproduces the production case exactly", () => {
    // Session a8b907: checked in 10:10:16, last ping 10:11:17 inside at 24m,
    // next ping 10:33:02 — 21m45s of silence, zero EXIT events.
    const checkIn = Date.parse("2026-09-02T04:40:16Z");
    expect(
      shouldGapCheckout({
        checkInMs: checkIn,
        lastPingMs: Date.parse("2026-09-02T04:41:17Z"),
        nextPingMs: Date.parse("2026-09-02T05:03:02Z"),
        gapThresholdMs: THRESHOLD,
        lastPingWasInside: true,
        sawExitAfterLastPing: false,
      }),
      "the session that was wrongly closed in production"
    ).toBe(false);
  });
});
