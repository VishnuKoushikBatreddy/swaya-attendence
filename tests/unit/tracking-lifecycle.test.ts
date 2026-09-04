/**
 * Tracking runs for the WINDOW, not for the session.
 *
 * Being checked in and being tracked are different things. After an automatic
 * check-out the pings are what notice the employee returning and drive the
 * automatic check-in, so capture continues — stopping there would remove the
 * signal needed to detect the return and leave only the OS geofence, which
 * fires on crossings it can miss.
 *
 * Pings are the primary detector; the geofence is the backup.
 */
import { describe, it, expect } from "vitest";
import { shouldTrackNow, shouldPingAutoCheckIn } from "@/lib/attendance-logic";

describe("shouldTrackNow", () => {
  const base = { hasSessionToday: true, lastSessionStatus: null as string | null, withinTrackingWindow: true };

  it("does not track before the day has been started by hand", () => {
    expect(shouldTrackNow({ ...base, hasSessionToday: false })).toBe(false);
  });

  it("tracks while checked in", () => {
    expect(shouldTrackNow({ ...base, lastSessionStatus: "active" })).toBe(true);
  });

  it("KEEPS TRACKING after an automatic check-out", () => {
    // The whole point: these pings are how the return is spotted.
    expect(shouldTrackNow({ ...base, lastSessionStatus: "auto_closed" })).toBe(true);
  });

  it("stops on a deliberate check-out", () => {
    expect(shouldTrackNow({ ...base, lastSessionStatus: "completed" })).toBe(false);
  });

  it("stops when the scheduled window closes", () => {
    expect(shouldTrackNow({ ...base, withinTrackingWindow: false })).toBe(false);
  });

  it("stays stopped after a manual check-out even inside the window", () => {
    expect(
      shouldTrackNow({ hasSessionToday: true, lastSessionStatus: "completed", withinTrackingWindow: true })
    ).toBe(false);
  });
});

describe("shouldPingAutoCheckIn", () => {
  const base = { isInsideGeofence: true, hasSessionToday: true, lastSessionStatus: "auto_closed" as string | null };

  it("re-opens a session when a ping shows them back on site", () => {
    expect(shouldPingAutoCheckIn(base)).toBe(true);
  });

  it("does nothing while they are still away", () => {
    expect(shouldPingAutoCheckIn({ ...base, isInsideGeofence: false })).toBe(false);
  });

  it("never STARTS the day", () => {
    // Arriving is not the same as starting work — that stays the employee's call.
    expect(shouldPingAutoCheckIn({ ...base, hasSessionToday: false })).toBe(false);
  });

  it("respects a deliberate check-out", () => {
    expect(shouldPingAutoCheckIn({ ...base, lastSessionStatus: "completed" })).toBe(false);
  });

  it("agrees with shouldTrackNow — capture continues exactly when a re-entry could be caught", () => {
    // If tracking stopped in a state where a ping could still legitimately
    // check someone back in, the return would be undetectable.
    for (const lastSessionStatus of ["auto_closed", "completed"]) {
      const tracking = shouldTrackNow({
        hasSessionToday: true,
        lastSessionStatus,
        withinTrackingWindow: true,
      });
      const canReopen = shouldPingAutoCheckIn({
        isInsideGeofence: true,
        hasSessionToday: true,
        lastSessionStatus,
      });
      expect(canReopen && !tracking, `unreachable re-entry for ${lastSessionStatus}`).toBe(false);
    }
  });
});
