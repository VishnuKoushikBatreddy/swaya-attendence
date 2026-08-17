"use client";

import { useEffect, useRef } from "react";
import { startTracker, stopTracker } from "@/lib/tracker";
import { getDeviceId } from "@/lib/device";

/**
 * Headless component that drives location tracking while the employee is checked
 * in. On Android (Capacitor) this uses the native background-geolocation plugin's
 * foreground service, so pings keep arriving even when the app is backgrounded or
 * closed. In a plain browser it falls back to a setInterval while the page is open.
 */
export function LocationTracker({
  active,
  intervalMs,
  onAutoCheckout,
}: {
  active: boolean;
  /**
   * Web ping cadence, from the server's PING_INTERVAL_MS (delivered on the
   * /api/attendance/today payload). Undefined until that first response lands,
   * in which case the tracker falls back to its own default. Ignored on native,
   * where pings are triggered by movement rather than time.
   */
  intervalMs?: number;
  onAutoCheckout?: () => void;
}) {
  // Keep the latest callback in a ref so starting/stopping doesn't depend on it.
  const onAutoRef = useRef(onAutoCheckout);
  onAutoRef.current = onAutoCheckout;

  // Register the service worker (used to queue pings when offline).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // ignore — falls back to foreground-only
    });
  }, []);

  // Start/stop tracking with the check-in state. `intervalMs` is a dependency so
  // that changing PING_INTERVAL_MS on the server takes effect on the next poll:
  // the tracker is torn down and restarted at the new cadence, with no reload.
  useEffect(() => {
    if (!active) return;
    startTracker({
      active: true,
      deviceId: getDeviceId(),
      intervalMs,
      onAutoCheckout: () => onAutoRef.current?.(),
    }).catch(() => {
      // ignore — startTracker reports its own errors via onError if provided
    });
    return () => {
      void stopTracker();
    };
  }, [active, intervalMs]);

  return null; // headless
}
