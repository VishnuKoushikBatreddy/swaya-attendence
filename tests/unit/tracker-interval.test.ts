/**
 * PING_INTERVAL_MS -> web tracker cadence.
 *
 * The value used to be ignored entirely: startTracker defaulted to a hardcoded
 * 15s and nothing ever passed an override, so the env var was dead config. These
 * tests pin that the configured value now reaches setInterval, that a missing
 * value falls back to the declared 3-minute default, and that a nonsense value
 * is clamped rather than allowed to hammer the battery or disable tracking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ native: false }));

vi.mock("@/lib/platform", () => ({
  isNative: () => state.native,
  getPlatform: () => (state.native ? "android" : "web"),
}));
vi.mock("@/lib/device-status", () => ({
  readBatteryPercent: async () => 100,
  readNetworkType: async () => "wifi",
}));
vi.mock("@/lib/notifications", () => ({ notifyCheckedOut: vi.fn() }));

import { startTracker, stopTracker } from "@/lib/tracker";

const DEFAULT_MS = 300_000; // mirrors env.PING_INTERVAL_MS

/** Captures the delay passed to the tracker's repeating setInterval. */
function intervalSpy() {
  return vi.spyOn(globalThis, "setInterval");
}

beforeEach(() => {
  state.native = false;
  // The web path needs these globals; geolocation never resolves, which is fine
  // — we only care about the scheduling, not the ping payload.
  vi.stubGlobal("navigator", {
    geolocation: { getCurrentPosition: vi.fn() },
    serviceWorker: undefined,
  });
  vi.stubGlobal("document", { visibilityState: "visible" });
});

afterEach(async () => {
  await stopTracker();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("web tracker cadence", () => {
  it("uses the interval it is given", async () => {
    const spy = intervalSpy();
    await startTracker({ active: true, intervalMs: 60_000 });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it("falls back to the declared 5-minute default when none is supplied", async () => {
    const spy = intervalSpy();
    await startTracker({ active: true });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_MS);
  });

  it.each([
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -1000],
    ["NaN", Number.NaN],
  ])("falls back to the default for a %s interval", async (_label, value) => {
    const spy = intervalSpy();
    await startTracker({ active: true, intervalMs: value as number | undefined });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_MS);
  });

  it("clamps an interval that is too small up to the 5s floor", async () => {
    const spy = intervalSpy();
    await startTracker({ active: true, intervalMs: 50 });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 5_000);
  });

  it("clamps an interval that is too large down to the 30min ceiling", async () => {
    const spy = intervalSpy();
    await startTracker({ active: true, intervalMs: 5 * 60 * 60_000 });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 30 * 60_000);
  });

  it("does nothing at all when inactive", async () => {
    const spy = intervalSpy();
    await startTracker({ active: false, intervalMs: 60_000 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not schedule a web interval on native (movement-triggered instead)", async () => {
    state.native = true;
    const spy = intervalSpy();
    await startTracker({ active: true, intervalMs: 60_000 });
    // The native watcher registration fails without Capacitor, which is fine —
    // the point is that no timer-based polling was set up.
    expect(spy).not.toHaveBeenCalledWith(expect.any(Function), 60_000);
  });
});
