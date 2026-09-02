"use client";

import { useEffect, useRef } from "react";
import { startTracker, stopTracker, isNativeServiceRunning } from "@/lib/tracker";
import { getDeviceId } from "@/lib/device";

/**
 * Headless component that drives location tracking while the employee is checked
 * in. On Android the capture and upload live in a native foreground service, so
 * pings keep arriving with the app backgrounded or swiped away. In a plain
 * browser it falls back to a setInterval while the page is open.
 */
export function LocationTracker({
  active,
  intervalMs,
  shiftEndMs,
  onAutoCheckout,
}: {
  active: boolean;
  /**
   * Web ping cadence, from the server's PING_INTERVAL_MS (delivered on the
   * /api/attendance/today payload). Undefined until that first response lands,
   * in which case the tracker falls back to its own default.
   */
  intervalMs?: number;
  /**
   * When the scheduled shift ends. Passed down to the native service so it can
   * stop itself — with the app closed nothing on the JS side is evaluating the
   * tracking window, so the service must know its own deadline.
   */
  shiftEndMs?: number | null;
  onAutoCheckout?: () => void;
}) {
  // Keep the latest callback in a ref so starting/stopping doesn't depend on it.
  const onAutoRef = useRef(onAutoCheckout);
  onAutoRef.current = onAutoCheckout;

  // Register the service worker (used to queue pings when offline).
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Test the VALUE, not just the key. In an insecure context some browsers
    // expose `navigator.serviceWorker` as undefined while `"serviceWorker" in
    // navigator` is still true, and reading `.register` off that throws — which
    // would take the whole tracker down with it. Same guard tracker.ts uses.
    if (!navigator?.serviceWorker) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // ignore — falls back to foreground-only
    });
  }, []);

  const wasActive = useRef(false);

  // START tracking, and STOP it only on a genuine active -> inactive transition.
  //
  // This used to be a single effect whose cleanup called stopTracker(). React
  // runs that cleanup on UNMOUNT as well as on a dependency change, so tearing
  // down the WebView shut down the native foreground service — the one component
  // specifically built to outlive the WebView. Any transient flip of `active`
  // (a poll that briefly showed no open session, a session auto-closing and
  // being reopened) did the same thing, which is why the notification kept
  // resetting to "Starting…" instead of tracking continuously.
  //
  // The service is now stopped ONLY when the employee is genuinely no longer
  // checked in. Nothing about React's lifecycle can end a shift's tracking.
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      startTracker({
        active: true,
        deviceId: getDeviceId(),
        intervalMs,
        shiftEndMs,
        onAutoCheckout: () => onAutoRef.current?.(),
      }).catch(() => {
        // startTracker surfaces its own errors via onError when provided.
      });
      return;
    }

    // Not active. Only tear the service down if we had actually started it —
    // otherwise a first render with active=false would stop a service that a
    // previous page load legitimately left running.
    if (wasActive.current) {
      wasActive.current = false;
      void stopTracker();
    }
  }, [active, intervalMs, shiftEndMs]);

  // SELF-HEAL. If the OS killed the process while the app was away, the employee
  // can come back to a checked-in screen with nothing actually tracking. Whenever
  // the app returns to the foreground, confirm the native service is really
  // running and restart it if not.
  useEffect(() => {
    if (!active) return;
    if (typeof document === "undefined") return;

    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        if (await isNativeServiceRunning()) return;
        await startTracker({
          active: true,
          deviceId: getDeviceId(),
          intervalMs,
          shiftEndMs,
          onAutoCheckout: () => onAutoRef.current?.(),
        });
      } catch {
        // Not native, or the plugin is unavailable — nothing to heal.
      }
    };

    void check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [active, intervalMs, shiftEndMs]);

  return null; // headless
}
