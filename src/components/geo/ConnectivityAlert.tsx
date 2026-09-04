"use client";

/**
 * In-app half of the "location and internet are required" warning.
 *
 * The Android service posts a system notification (TrackingAlerts.java) so the
 * employee hears about it with the app closed, which is when it usually
 * happens. This is the other half: while the app IS open, a notification is easy
 * to miss and the shade is the wrong place for something the screen in front of
 * them could just say. It also covers the browser, where there is no service and
 * no notification at all.
 *
 * Both surfaces call describeConnectivityProblem, so they cannot drift into
 * describing the same state differently.
 *
 * Renders nothing when there is nothing wrong.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { WifiOff, MapPinOff, ExternalLink } from "lucide-react";
import {
  describeConnectivityProblem,
  readLocationPermission,
  type ConnectivityProblem,
  type LocationPermission,
} from "@/lib/device-connectivity";
import { readNetworkType, subscribeNetwork, type NetworkType } from "@/lib/device-status";
import {
  getDeviceSetupStatus,
  openLocationSettings,
  openNetworkSettings,
  openAppSettings,
} from "@/lib/device-setup";

/**
 * How often the device's location toggle is re-read. There is no event for it —
 * the only way to notice is to look — and it is a cheap synchronous call into
 * LocationManager. Network needs no polling; it has a listener.
 */
const LOCATION_POLL_MS = 20_000;

export function ConnectivityAlert({ enabled }: { enabled: boolean }) {
  const [network, setNetwork] = useState<NetworkType>("unknown");
  const [locationEnabled, setLocationEnabled] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<LocationPermission>("unknown");

  // Network: read once, then follow the listener.
  useEffect(() => {
    let mounted = true;
    let unsub = () => {};
    (async () => {
      const n = await readNetworkType();
      if (!mounted) return;
      setNetwork(n);
      unsub = await subscribeNetwork((t) => {
        if (mounted) setNetwork(t);
      });
    })();
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const readLocationState = useCallback(async () => {
    const [status, perm] = await Promise.all([getDeviceSetupStatus(), readLocationPermission()]);
    return {
      // Only the native plugin can answer this. On the web it stays null, and
      // describeConnectivityProblem treats null as "no complaint".
      enabled: status.supported ? status.locationServicesEnabled : null,
      permission: perm,
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      const s = await readLocationState();
      if (!mounted) return;
      setLocationEnabled(s.enabled);
      setPermission(s.permission);
    };
    void check();
    const timer = setInterval(check, LOCATION_POLL_MS);
    // Coming back from the settings screen is exactly when this changes, so
    // re-read immediately instead of leaving a fixed problem on screen.
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [readLocationState]);

  const problem = enabled
    ? describeConnectivityProblem({
        online: network !== "offline",
        locationEnabled,
        locationPermission: permission,
      })
    : null;

  // One toast per distinct problem, so it is noticed even when the banner is
  // below the fold — but never on every re-render, and never again for a problem
  // already announced.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!problem) {
      announced.current = null;
      return;
    }
    if (announced.current === problem.id) return;
    announced.current = problem.id;
    toast({
      title: problem.title,
      description: problem.message,
      variant: problem.losingData ? "destructive" : "default",
      duration: problem.losingData ? 12_000 : 6_000,
    });
  }, [problem]);

  if (!problem) return null;

  const critical = problem.losingData;
  const Icon = problem.fix === "network" ? WifiOff : MapPinOff;

  async function fix(p: ConnectivityProblem) {
    const opened =
      p.fix === "network"
        ? await openNetworkSettings()
        : p.fix === "permission"
        ? await openAppSettings()
        : await openLocationSettings();
    if (!opened) {
      // The browser has no settings to open. Say where to go instead of leaving
      // a button that appears to do nothing.
      toast({
        title: "Open it from your device settings",
        description:
          p.fix === "network"
            ? "Turn on Wi-Fi or mobile data, then come back."
            : "Turn on Location (GPS) for this device, then come back.",
      });
    }
  }

  return (
    <div
      role="alert"
      className={
        critical
          ? "flex flex-wrap items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          : "flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4"
      }
    >
      <Icon
        className={
          critical
            ? "mt-0.5 h-5 w-5 flex-shrink-0 text-destructive"
            : "mt-0.5 h-5 w-5 flex-shrink-0 text-warning"
        }
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{problem.title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{problem.message}</p>
      </div>
      <Button
        size="sm"
        variant={critical ? "destructive" : "outline"}
        onClick={() => void fix(problem)}
        className="gap-1.5"
      >
        Fix <ExternalLink className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
