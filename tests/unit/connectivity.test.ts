/**
 * deriveConnectivity — how current an employee's position is.
 *
 * A checked-in session means a session is OPEN, not that the phone is still
 * reporting. Showing "checked in" identically whether the last ping arrived 30
 * seconds or 4 hours ago made a dead phone look like someone actively working.
 */
import { describe, it, expect } from "vitest";
import { deriveConnectivity } from "@/lib/attendance-logic";

const NOW = 1_800_000_000_000;
const PING = 3 * 60_000; // 3 min
const OFFLINE = 10 * 60_000; // 10 min

const at = (agoMs: number | null) =>
  deriveConnectivity(agoMs == null ? null : NOW - agoMs, NOW, PING, OFFLINE);

describe("deriveConnectivity", () => {
  it("is live for a ping that just arrived", () => {
    expect(at(0)).toBe("live");
    expect(at(30_000)).toBe("live");
  });

  it("tolerates one dropped ping before calling it stale", () => {
    // Two intervals is still live — a single miss on a flaky network is normal.
    expect(at(2 * PING)).toBe("live");
    expect(at(2 * PING + 1)).toBe("stale");
  });

  it("is stale between the ping tolerance and the offline threshold", () => {
    expect(at(7 * 60_000)).toBe("stale");
    expect(at(OFFLINE - 1)).toBe("stale");
  });

  it("is offline at and beyond the threshold", () => {
    expect(at(OFFLINE)).toBe("offline");
    expect(at(4 * 60 * 60_000)).toBe("offline");
  });

  it("is offline when nothing has ever been reported", () => {
    expect(at(null)).toBe("offline");
  });

  it("treats a slightly fast device clock as live, not as negative age", () => {
    expect(deriveConnectivity(NOW + 5_000, NOW, PING, OFFLINE)).toBe("live");
  });

  it("follows the configured interval rather than hard-coded minutes", () => {
    // At a 30s cadence, 5 minutes of silence is a long time.
    expect(deriveConnectivity(NOW - 5 * 60_000, NOW, 30_000, OFFLINE)).toBe("stale");
    // At a 15-minute cadence it is still within two intervals.
    expect(deriveConnectivity(NOW - 5 * 60_000, NOW, 15 * 60_000, 60 * 60_000)).toBe("live");
  });

  it("rejects a non-finite timestamp rather than reporting live", () => {
    expect(deriveConnectivity(Number.NaN, NOW, PING, OFFLINE)).toBe("offline");
  });
});
