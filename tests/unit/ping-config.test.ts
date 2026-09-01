/**
 * Invariants between the ping cadence and everything derived from it.
 *
 * Three settings are not independent — change PING_INTERVAL_MS alone and two
 * other behaviours break silently, with no type error and no failing feature
 * test. This pins the relationships so that mistake fails here instead.
 */
import { describe, it, expect } from "vitest";
import { env } from "@/lib/env";
import { deriveConnectivity } from "@/lib/attendance-logic";

describe("ping cadence configuration", () => {
  it("pings every 5 minutes by default", () => {
    expect(env.PING_INTERVAL_MS).toBe(5 * 60_000);
  });

  it("gives roughly 12 pings per hour", () => {
    expect(Math.round(3_600_000 / env.PING_INTERVAL_MS)).toBe(12);
  });

  it("trusts a ping for LONGER than the interval", () => {
    // At exactly the interval, a few seconds of ordinary jitter would leave a
    // sliver of every single gap offline, across the whole shift.
    expect(env.PING_TRUST_WINDOW_MS).toBeGreaterThan(env.PING_INTERVAL_MS);
  });

  it("goes offline only after MORE than two intervals", () => {
    // deriveConnectivity calls anything within 2 intervals "live". If the
    // offline threshold were at or below that, the "stale" band would vanish
    // and employees would flip straight from live to offline.
    expect(env.OFFLINE_AFTER_MS).toBeGreaterThan(env.PING_INTERVAL_MS * 2);
  });

  it("leaves a usable stale band at the configured values", () => {
    const now = 1_800_000_000_000;
    const ago = (ms: number) =>
      deriveConnectivity(now - ms, now, env.PING_INTERVAL_MS, env.OFFLINE_AFTER_MS);

    expect(ago(60_000)).toBe("live"); // 1 min
    expect(ago(env.PING_INTERVAL_MS * 2)).toBe("live"); // 10 min
    expect(ago(env.PING_INTERVAL_MS * 2 + 60_000)).toBe("stale"); // 11 min
    expect(ago(env.OFFLINE_AFTER_MS)).toBe("offline"); // 15 min
  });

  it("tolerates at least two missed pings before auto-checking-out", () => {
    // The gap rule ends the shift, so it must be forgiving of a flaky network.
    const gapMs = env.PING_GAP_CHECKOUT_MINUTES * 60_000;
    expect(gapMs / env.PING_INTERVAL_MS).toBeGreaterThanOrEqual(2);
  });

  it("polls for auto check-in at least as often as it pings", () => {
    // Auto check-in runs while checked OUT, so a slower poll would delay the
    // start of a shift.
    expect(env.AUTO_CHECKIN_POLL_MS).toBeLessThanOrEqual(env.PING_INTERVAL_MS);
  });
});
