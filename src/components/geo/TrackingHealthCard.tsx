"use client";

/**
 * Warns the employee when this device will stop tracking them.
 *
 * Every other failure in the app is visible: a rejected check-in says why, a lost
 * network shows an offline badge. A phone that quietly kills the tracking service
 * shows nothing at all — the shift simply records no location, and nobody finds
 * out until an admin reads a report days later. That is the one failure worth
 * interrupting someone for.
 *
 * Renders nothing when the device is configured correctly, and nothing at all on
 * the web or on an APK without the plugin.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { ShieldAlert, ShieldCheck, ExternalLink, RefreshCw } from "lucide-react";
import {
  getDeviceSetupStatus,
  requestBatteryExemption,
  openAutostartSettings,
  autostartHint,
  type DeviceSetupStatus,
} from "@/lib/device-setup";

const AUTOSTART_ACK_KEY = "swaya-autostart-confirmed";

export function TrackingHealthCard() {
  const [status, setStatus] = useState<DeviceSetupStatus | null>(null);
  // Autostart cannot be read back, so the employee confirms it once and we
  // remember that rather than nagging on every visit.
  const [autostartDone, setAutostartDone] = useState(true);

  const refresh = useCallback(async () => {
    setStatus(await getDeviceSetupStatus());
    try {
      setAutostartDone(window.localStorage.getItem(AUTOSTART_ACK_KEY) === "1");
    } catch {
      setAutostartDone(true); // storage unavailable — do not nag
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Re-check when the employee comes back from the settings screen, so the
    // card clears itself instead of asking them to reload.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  if (!status?.supported) return null;

  const batteryOk = status.batteryUnrestricted;
  const autostartOk = autostartDone || !status.autostartScreenAvailable;
  if (batteryOk && autostartOk) return null;

  async function fixBattery() {
    if (!(await requestBatteryExemption())) {
      toast({
        title: "Couldn't open the setting",
        description: "Open Settings › Apps › Swaya Attendance › Battery and choose Unrestricted.",
        variant: "destructive",
      });
    }
  }

  async function fixAutostart() {
    const opened = await openAutostartSettings();
    if (!opened) {
      toast({ title: "Couldn't open the setting", variant: "destructive" });
      return;
    }
    // The vendor screen gives nothing back, so the employee tells us.
    try {
      window.localStorage.setItem(AUTOSTART_ACK_KEY, "1");
    } catch {
      /* storage unavailable — the card simply shows again next time */
    }
    setAutostartDone(true);
  }

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">This phone may stop tracking you</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {status.manufacturer || "Your phone"} can shut the app down after you close it,
              which would leave gaps in your attendance. Two quick settings prevent that.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {!batteryOk && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Allow background battery use</p>
                <p className="text-xs text-muted-foreground">One tap — choose “Allow”.</p>
              </div>
              <Button size="sm" onClick={fixBattery} className="gap-1.5">
                Fix <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {!autostartOk && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Allow the app to start automatically</p>
                <p className="text-xs text-muted-foreground">
                  {autostartHint(status.manufacturer)}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={fixAutostart} className="gap-1.5">
                Open <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          Re-check
        </button>
      </CardContent>
    </Card>
  );
}

/** Compact all-clear badge, for a settings or diagnostics screen. */
export function TrackingHealthOk() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
      <ShieldCheck className="h-3.5 w-3.5" />
      Background tracking allowed
    </span>
  );
}
