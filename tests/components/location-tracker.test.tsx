// @vitest-environment jsdom
/**
 * LocationTracker must not be able to end a shift's tracking.
 *
 * The native foreground service exists specifically to outlive the WebView. The
 * component used to stop it from an effect cleanup, and React runs that cleanup
 * on UNMOUNT as well as on a dependency change — so tearing down the page shut
 * down the very thing built to survive that. Any transient flip of `active` did
 * the same, which is why the notification kept resetting to "Starting…".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  starts: [] as any[],
  stops: 0,
  serviceRunning: true,
}));

vi.mock("@/lib/tracker", () => ({
  startTracker: vi.fn(async (opts: any) => {
    h.starts.push(opts);
  }),
  stopTracker: vi.fn(async () => {
    h.stops++;
  }),
  isNativeServiceRunning: vi.fn(async () => h.serviceRunning),
}));
vi.mock("@/lib/device", () => ({ getDeviceId: () => "test-device" }));

import { LocationTracker } from "@/components/geo/LocationTracker";

beforeEach(() => {
  h.starts = [];
  h.stops = 0;
  h.serviceRunning = true;
  vi.stubGlobal("navigator", { ...navigator, serviceWorker: undefined });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("LocationTracker", () => {
  it("starts tracking when the employee is checked in", async () => {
    render(<LocationTracker active intervalMs={300_000} />);
    await waitFor(() => expect(h.starts).toHaveLength(1));
    expect(h.starts[0].intervalMs).toBe(300_000);
    expect(h.starts[0].deviceId).toBe("test-device");
  });

  it("does NOT stop the service when the component unmounts", async () => {
    // The whole point of the native service is that it outlives the WebView.
    const { unmount } = render(<LocationTracker active intervalMs={300_000} />);
    await waitFor(() => expect(h.starts).toHaveLength(1));

    unmount();

    expect(h.stops, "unmounting killed the background service").toBe(0);
  });

  it("does NOT stop the service when only the interval changes", async () => {
    const { rerender } = render(<LocationTracker active intervalMs={300_000} />);
    await waitFor(() => expect(h.starts).toHaveLength(1));

    rerender(<LocationTracker active intervalMs={180_000} />);
    await waitFor(() => expect(h.starts).toHaveLength(2));

    // Restarted at the new cadence, but never torn down in between.
    expect(h.stops).toBe(0);
    expect(h.starts[1].intervalMs).toBe(180_000);
  });

  it("stops only when the employee is genuinely checked out", async () => {
    const { rerender } = render(<LocationTracker active intervalMs={300_000} />);
    await waitFor(() => expect(h.starts).toHaveLength(1));

    rerender(<LocationTracker active={false} intervalMs={300_000} />);
    await waitFor(() => expect(h.stops).toBe(1));
  });

  it("does not stop a service it never started", async () => {
    // A first render with active=false must not tear down a service that a
    // previous page load legitimately left running.
    render(<LocationTracker active={false} intervalMs={300_000} />);
    await waitFor(() => expect(h.starts).toHaveLength(0));
    expect(h.stops).toBe(0);
  });

  it("restarts the service if the OS killed it while the app was away", async () => {
    // Checked in, but nothing is actually capturing — the two must be reconciled
    // or the employee sees a tracking screen with no tracking behind it.
    h.serviceRunning = false;
    render(<LocationTracker active intervalMs={300_000} />);
    await waitFor(() => expect(h.starts.length).toBeGreaterThanOrEqual(2));
    expect(h.stops).toBe(0);
  });

  it("leaves a healthy service alone", async () => {
    h.serviceRunning = true;
    render(<LocationTracker active intervalMs={300_000} />);
    await waitFor(() => expect(h.starts).toHaveLength(1));
    // Only the initial start — the self-heal found it running and did nothing.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.starts).toHaveLength(1);
  });

  it("hands the shift end to the native service", async () => {
    // The service enforces its own deadline: with the app closed nothing here
    // evaluates the tracking window, so a service told only "start" would keep
    // capturing all night.
    const shiftEnd = Date.now() + 6 * 3600_000;
    render(<LocationTracker active intervalMs={300_000} shiftEndMs={shiftEnd} />);
    await waitFor(() => expect(h.starts).toHaveLength(1));
    expect(h.starts[0].shiftEndMs).toBe(shiftEnd);
  });

  it("passes no deadline when the employee has no schedule", async () => {
    render(<LocationTracker active intervalMs={300_000} shiftEndMs={null} />);
    await waitFor(() => expect(h.starts).toHaveLength(1));
    expect(h.starts[0].shiftEndMs).toBeNull();
  });
});
