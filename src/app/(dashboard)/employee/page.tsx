"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";
import { formatDuration, formatTime, formatTimeWithSeconds } from "@/lib/utils";
import { evaluateAutoCheckIn, isWithinTrackingWindow } from "@/lib/attendance-logic";
import dynamic from "next/dynamic";
import { LocationTracker } from "@/components/geo/LocationTracker";
import { getDeviceId } from "@/lib/device";
import { readBatteryPercent, readNetworkType, subscribeNetwork } from "@/lib/device-status";
import { getCurrentLocation } from "@/lib/geolocation";
import { getQueue, enqueueAction, replayQueue, type QueuedAction } from "@/lib/offline-queue";
import { haversineDistanceMeters } from "@/lib/geo";
import {
  CheckCircle2,
  XCircle,
  MapPin,
  Clock,
  Battery,
  Wifi,
  Loader2,
} from "lucide-react";

// LiveTrackerMap uses react-leaflet which calls `window` at module-init.
// Render it on the client only to avoid SSR ReferenceErrors.
const LiveTrackerMap = dynamic(
  () => import("@/components/geo/LiveTrackerMap").then((m) => m.LiveTrackerMap),
  { ssr: false, loading: () => <div className="h-[250px] w-full rounded-md border bg-muted animate-pulse" /> }
);

/**
 * One figure in the session grid. Cells sit on a `gap-px` border-colored grid so
 * the hairlines between them come from the container, not per-cell borders.
 * `emphasis` is for the live work timer, which is the number the employee
 * actually watches while on shift.
 */
function Stat({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="bg-card p-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={
          emphasis
            ? "mt-1 text-xl font-semibold tabular-nums text-primary"
            : "mt-1 text-xl font-semibold tabular-nums"
        }
      >
        {value}
      </p>
    </div>
  );
}

/** H:MM:SS — used for the live, ticking work timer. */
function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(sec)}`;
}

type TodayState = {
  day: any;
  sessions: any[];
  site: any;
  schedule?: any;
  shift?: any;
  /** Server's PING_INTERVAL_MS — drives the web tracker's cadence. */
  pingIntervalMs?: number;
  autoCheckIn?: { enabled: boolean; pollMs: number; graceMinutes: number };
};

export default function EmployeePage() {
  const { data: session, update } = useSession();
  const [loading, setLoading] = useState(false);
  const [today, setToday] = useState<TodayState | null>(null);
  const [lastLat, setLastLat] = useState<number | null>(null);
  const [lastLng, setLastLng] = useState<number | null>(null);
  const [battery, setBattery] = useState<number | null>(null);
  const [network, setNetwork] = useState<string>("unknown");
  const [tracking, setTracking] = useState(false);
  const [nowTs, setNowTs] = useState(0);
  const [pending, setPending] = useState<QueuedAction[]>([]);
  // Empty on the server, filled once mounted — see the note where it is rendered.
  const [todayLabel, setTodayLabel] = useState("");

  useEffect(() => {
    setTodayLabel(
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    );
  }, []);

  const loadSeq = useRef(0);
  const loadToday = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch("/api/attendance/today");
      const json = await res.json();
      // Ignore a response that a newer request has already superseded.
      if (seq !== loadSeq.current) return;
      if (json.ok) setToday(json.data);
    } catch {
      /* network error — keep last good state, next poll retries */
    }
  }, []);

  useEffect(() => {
    loadToday();
  }, [loadToday]);

  // Live device status: battery + network read on mount, network updates via a
  // listener, battery refreshed periodically. Uses the Capacitor plugins on the
  // native app and their web fallback in the browser.
  useEffect(() => {
    let mounted = true;
    let unsub = () => {};
    (async () => {
      const [b, n] = await Promise.all([readBatteryPercent(), readNetworkType()]);
      if (!mounted) return;
      setBattery(b);
      setNetwork(n);
      unsub = await subscribeNetwork((t) => {
        if (mounted) setNetwork(t);
      });
    })();
    const battTimer = setInterval(async () => {
      const b = await readBatteryPercent();
      if (mounted) setBattery(b);
    }, 60_000);
    return () => {
      mounted = false;
      unsub();
      clearInterval(battTimer);
    };
  }, []);

  // Sync queued offline check-ins/outs when online (and on mount / "online" event).
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      if (getQueue().length === 0) return;
      const n = await replayQueue();
      if (cancelled) return;
      setPending(getQueue());
      if (n > 0) {
        toast({ title: `Synced ${n} offline action${n > 1 ? "s" : ""}` });
        loadToday();
      }
    };
    setPending(getQueue());
    sync();
    const onOnline = () => sync();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, [loadToday]);

  // Save a check-in/out locally when the network is down (after a client-side
  // geofence check for check-in) — it syncs automatically once back online.
  function queueOffline(type: "check-in" | "check-out", coords: { latitude: number; longitude: number; accuracy?: number }) {
    if (type === "check-in") {
      const s = today?.site;
      if (!s || !Array.isArray(s.location?.coordinates)) {
        toast({
          title: "You're offline",
          description: "Can't verify your work site offline. Connect to the internet to check in.",
          variant: "destructive",
        });
        return;
      }
      const dist = haversineDistanceMeters(
        { lat: coords.latitude, lng: coords.longitude },
        { lat: s.location.coordinates[1], lng: s.location.coordinates[0] }
      );
      if (dist > s.radiusMeters + (coords.accuracy ?? 0)) {
        toast({
          title: "Outside the work site",
          description: "You're not within the site to check in.",
          variant: "destructive",
        });
        return;
      }
    }
    enqueueAction({
      type,
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy,
      capturedAt: new Date().toISOString(),
      deviceId: getDeviceId(),
    });
    setPending(getQueue());
    toast({
      title: type === "check-in" ? "Checked in (offline)" : "Checked out (offline)",
      description: "Saved on your device — it will sync automatically when you're back online.",
    });
  }

  const handleCheckIn = async () => {
    setLoading(true);
    let coords;
    try {
      coords = await getCurrentLocation();
    } catch (e: any) {
      toast({ title: "Location error", description: e.message, variant: "destructive" });
      setLoading(false);
      return;
    }
    setLastLat(coords.latitude);
    setLastLng(coords.longitude);
    try {
      const res = await fetch("/api/attendance/check-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
          isMockLocation: false,
          deviceId: getDeviceId(),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast({ title: "Check-in failed", description: json.error, variant: "destructive" });
        return;
      }
      toast({ title: "Checked in at " + json.data.site.name });
      setTracking(true);
      loadToday();
    } catch {
      // Network failure — fall back to the offline queue.
      queueOffline("check-in", coords);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOut = async () => {
    setLoading(true);
    let coords;
    try {
      coords = await getCurrentLocation();
    } catch (e: any) {
      toast({ title: "Location error", description: e.message, variant: "destructive" });
      setLoading(false);
      return;
    }
    setLastLat(coords.latitude);
    setLastLng(coords.longitude);
    try {
      const res = await fetch("/api/attendance/check-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast({ title: "Check-out failed", description: json.error, variant: "destructive" });
        return;
      }
      toast({ title: "Checked out successfully" });
      setTracking(false);
      loadToday();
    } catch {
      // Network failure — fall back to the offline queue.
      queueOffline("check-out", coords);
    } finally {
      setLoading(false);
    }
  };

  const handleAutoCheckout = useCallback(() => {
    toast({
      title: "Checked out automatically",
      description: "You left the work site, so your session was closed.",
    });
    setTracking(false);
    loadToday();
  }, [loadToday]);

  const status = today?.day?.status || "pending";
  const site = today?.site;
  const currentSession = today?.sessions?.[0];
  // "Checked in" means a session is still open — not the day's overall status,
  // which stays "present"/"late" even after the employee checks out.
  const serverCheckedIn = !!today?.sessions?.some(
    (s: any) => s.status === "active" || s.status === "flagged"
  );
  // A queued offline check-in/out overrides the server view optimistically until
  // it syncs, so the button + tracker reflect what the employee just did offline.
  const lastPendingType = pending.length ? pending[pending.length - 1].type : null;
  const isCheckedIn = lastPendingType ? lastPendingType === "check-in" : serverCheckedIn;
  // A scheduled non-working day (weekly off / company holiday) — no check-in needed.
  const isDayOff = today?.schedule != null && today.schedule.isWorkingDay === false;
  // A scheduled non-working day is now the only reason check-in is not required.
  const noCheckInNeeded = isDayOff;

  // Tick the live work timer every second while checked in.
  useEffect(() => {
    if (!isCheckedIn) return;
    setNowTs(Date.now());
    const tick = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [isCheckedIn]);

  // ALWAYS poll the server so changes made WITHOUT a tap show up — e.g. a native
  // geofence ENTER auto check-in (or EXIT auto check-out) that happened while the
  // app was idle/backgrounded. Faster while checked in (for live outside time),
  // slower while checked out (just watching for a geofence-driven check-in).
  useEffect(() => {
    const poll = setInterval(() => loadToday(), isCheckedIn ? 15000 : 30000);
    return () => clearInterval(poll);
  }, [isCheckedIn, loadToday]);

  // Re-fetch the moment the app returns to the foreground, so reopening it
  // reflects any geofence-driven check-in/out immediately (no 30s wait).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") loadToday();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadToday]);

  // Persist the checked-in state natively (Capacitor Preferences) so the Android
  // BootReceiver knows whether to prompt the employee to resume tracking after a
  // reboot. No-op in a plain browser.
  useEffect(() => {
    (async () => {
      try {
        const { Preferences } = await import("@capacitor/preferences");
        await Preferences.set({ key: "checkedIn", value: isCheckedIn ? "true" : "false" });
      } catch {
        /* not native */
      }
    })();
  }, [isCheckedIn]);

  // Site geofence centre + radius as primitives. Both the auto check-in effect
  // and the native-geofence effect depend on these; keeping them primitive (not
  // the site object) stops the `today` poll from restarting either one on every
  // refresh.
  const siteLat = Array.isArray(site?.location?.coordinates)
    ? (site.location.coordinates[1] as number)
    : null;
  const siteLng = Array.isArray(site?.location?.coordinates)
    ? (site.location.coordinates[0] as number)
    : null;
  const siteRadius = (site?.radiusMeters as number | undefined) ?? undefined;

  // ── Auto check-in ────────────────────────────────────────────────────────
  // Being inside the site during shift hours is a STATE, but the OS geofence
  // only reports TRANSITIONS. Someone who arrives at 08:45 gets an ENTER that
  // the schedule gate rejects for being early, then never crosses the boundary
  // again — so without this they are never checked in at 09:00. This closes that
  // gap, and works in the browser too, where no OS geofence exists at all.
  //
  // evaluateAutoCheckIn decides whether to spend a GPS fix at all; the distance
  // test and the server's own schedule gate still apply after it.
  const lastSession = today?.sessions?.length
    ? today.sessions[today.sessions.length - 1]
    : null;
  const scheduleStartMs = today?.schedule?.expectedStartAt
    ? new Date(today.schedule.expectedStartAt).getTime()
    : null;
  const scheduleEndMs = today?.schedule?.expectedEndAt
    ? new Date(today.schedule.expectedEndAt).getTime()
    : null;
  const graceMinutes = today?.autoCheckIn?.graceMinutes ?? 0;

  const autoCheckInDecision = evaluateAutoCheckIn({
    enabled: today?.autoCheckIn?.enabled ?? false,
    isCheckedIn,
    noCheckInNeeded,
    hasSite: siteLat != null && siteLng != null,
    scheduleStartMs,
    scheduleEndMs,
    graceMinutes,
    lastSessionStatus: lastSession?.status ?? null,
    nowMs: nowTs || Date.now(),
  });

  // Location is collected during the SCHEDULED SHIFT only, not for as long as a
  // session happens to stay open. `nowTs` ticks every second while checked in,
  // so this flips to false the moment the shift ends and the tracker stops —
  // including the native foreground service, which stopTracker also shuts down.
  const withinTrackingWindow = isWithinTrackingWindow({
    scheduleStartMs,
    scheduleEndMs,
    graceMinutes,
    nowMs: nowTs || Date.now(),
  });
  const trackingActive = isCheckedIn && withinTrackingWindow;
  const autoCheckInEligible = autoCheckInDecision.ok;
  const autoPollMs = today?.autoCheckIn?.pollMs ?? 60_000;

  // Throttles attempts across effect restarts (the `today` poll re-renders often).
  const lastAutoAttemptRef = useRef(0);
  useEffect(() => {
    if (!autoCheckInEligible || siteLat == null || siteLng == null) return;
    let cancelled = false;

    const attempt = async () => {
      if (cancelled) return;
      // Guard against a burst of attempts when dependencies churn.
      if (Date.now() - lastAutoAttemptRef.current < autoPollMs) return;
      lastAutoAttemptRef.current = Date.now();

      let coords;
      try {
        coords = await getCurrentLocation();
      } catch {
        return; // permission denied or no fix — try again next tick
      }
      if (cancelled) return;
      setLastLat(coords.latitude);
      setLastLng(coords.longitude);

      // Only spend a request when actually inside. Accuracy is added to the
      // radius, matching the server's own tolerance.
      const distance = haversineDistanceMeters(
        { lat: coords.latitude, lng: coords.longitude },
        { lat: siteLat, lng: siteLng }
      );
      if (distance > (siteRadius ?? 0) + (coords.accuracy ?? 0)) return;

      try {
        const res = await fetch("/api/attendance/check-in", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: coords.accuracy,
            isMockLocation: false,
            deviceId: getDeviceId(),
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (json.ok) {
          toast({
            title: "Checked in automatically",
            description: `You're at ${json.data.site.name}.`,
          });
          setTracking(true);
          loadToday();
        }
        // A rejection (already checked in, outside hours, day off) needs no
        // toast — this runs unattended, and the throttle prevents a retry storm.
      } catch {
        // Offline: do NOT queue. A queued auto check-in would replay at a time
        // the employee never chose. Manual check-in still queues.
      }
    };

    attempt();
    const timer = setInterval(attempt, autoPollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [autoCheckInEligible, siteLat, siteLng, siteRadius, autoPollMs, loadToday]);

  // Native OS-geofence fallback (Android): register a geofence around the work
  // site whenever the employee HAS a site for today — kept active whether checked
  // in OR out, so the OS can fire BOTH the departure (EXIT -> auto check-out) and
  // the return (ENTER -> auto check-in) even after the app is killed. Removed only
  // on a day off / no site. The server schedule-gate still guards check-ins.
  // Depends on the primitive lat/lng/radius declared above (not the object) so
  // the 30s `today` poll doesn't needlessly re-register the geofence each time.
  useEffect(() => {
    (async () => {
      try {
        const { enableGeofenceFallback, disableGeofenceFallback } = await import("@/lib/geofence");
        if (siteLat != null && siteLng != null && !noCheckInNeeded) {
          await enableGeofenceFallback({ lat: siteLat, lng: siteLng, radiusMeters: siteRadius });
        } else {
          await disableGeofenceFallback();
        }
      } catch {
        /* not native / plugin unavailable */
      }
    })();
  }, [siteLat, siteLng, siteRadius, noCheckInNeeded]);

  const activeSession = today?.sessions?.find(
    (s: any) => s.status === "active" || s.status === "flagged"
  );
  // Sum of already-completed sessions today (so work time is cumulative, not just
  // the current session).
  const completedWorkSeconds = (today?.sessions || []).reduce((acc: number, s: any) => {
    if (!s.checkOutAt) return acc;
    return acc + Math.max(0, Math.floor((new Date(s.checkOutAt).getTime() - new Date(s.checkInAt).getTime()) / 1000));
  }, 0);
  // Work time = completed sessions + the open session ticking live; falls back to
  // the stored cumulative total when not checked in.
  const liveWorkSeconds =
    isCheckedIn && activeSession?.checkInAt && nowTs
      ? completedWorkSeconds + Math.max(0, Math.floor((nowTs - new Date(activeSession.checkInAt).getTime()) / 1000))
      : today?.day?.totalWorkSeconds || 0;

  return (
    <div className="space-y-6">
      <LocationTracker
        active={trackingActive}
        intervalMs={today?.pingIntervalMs}
        onAutoCheckout={handleAutoCheckout}
      />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
          {/* Rendered after mount, never during SSR: toLocaleDateString resolves
              against the SERVER's locale and timezone first and the browser's
              second, so emitting it inline produced two different strings and
              React aborted hydration with "Text content does not match
              server-rendered HTML". */}
          <p className="mt-0.5 text-sm text-muted-foreground">{todayLabel}</p>
        </div>
        <Badge
          className="capitalize"
          variant={status === "present" ? "success" : status === "late" ? "warning" : "secondary"}
        >
          {status}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Attendance</CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
            {site?.name || "No site assigned"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {site && Array.isArray(site.location?.coordinates) && (
            <LiveTrackerMap
              siteLat={site.location.coordinates[1]}
              siteLng={site.location.coordinates[0]}
              radiusMeters={site.radiusMeters}
              currentLat={lastLat}
              currentLng={lastLng}
              height={250}
            />
          )}

          {pending.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-center text-xs font-medium text-warning">
              {pending.length} offline action{pending.length > 1 ? "s" : ""} saved — will sync automatically when you&apos;re back online.
            </div>
          )}

          {noCheckInNeeded && !isCheckedIn ? (
            <div className="rounded-lg border bg-muted/50 p-5 text-center">
              <p className="font-semibold">Day off</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Today is a scheduled non-working day — no check-in required.
              </p>
            </div>
          ) : !isCheckedIn ? (
            <Button
              className="h-14 w-full gap-2 text-base font-semibold shadow-sm"
              size="lg"
              onClick={handleCheckIn}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
              Check in
            </Button>
          ) : (
            <Button
              className="h-14 w-full gap-2 text-base font-semibold shadow-sm"
              variant="destructive"
              size="lg"
              onClick={handleCheckOut}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <XCircle className="h-5 w-5" />}
              Check out
            </Button>
          )}

          {/* Session info — the figures are the point of this screen, so they
              lead and the captions sit above them in small caps. */}
          {currentSession && (
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border">
              {/* FIRST check-in and LATEST check-out of the day. Both read from
                  the day rollup, which the server maintains as a true min/max —
                  sourcing check-in from sessions[0] relied on array ordering and
                  would drift once a day had several sessions. Seconds are shown
                  because at minute precision a short session rendered the two
                  times identically. */}
              <Stat
                label="Check-in"
                value={formatTimeWithSeconds(
                  today?.day?.firstCheckInAt ?? currentSession.checkInAt
                )}
              />
              {today?.day?.lastCheckOutAt && (
                <Stat
                  label="Check-out"
                  value={formatTimeWithSeconds(today.day.lastCheckOutAt)}
                />
              )}
              <Stat
                label="Work time"
                value={isCheckedIn ? formatHMS(liveWorkSeconds) : formatDuration(liveWorkSeconds)}
                emphasis={isCheckedIn}
              />
              <Stat
                label="Outside"
                value={formatDuration(today?.day?.totalOutsideSeconds || 0)}
              />
              <Stat
                label="Offline"
                value={formatDuration(today?.day?.totalOfflineSeconds || 0)}
              />
            </div>
          )}

          {/* Device status */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {isCheckedIn && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                </span>
                Tracking active
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
              <Battery className="h-3.5 w-3.5" /> {battery ?? "—"}%
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
              <Wifi className="h-3.5 w-3.5" /> {network}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* History summary */}
      <Card>
        <CardContent className="p-0">
          <a
            href="/employee/history"
            className="flex items-center justify-between gap-3 rounded-lg p-5 transition-colors hover:bg-accent/60"
          >
            <span>
              <span className="block font-semibold">Recent days</span>
              <span className="block text-sm text-muted-foreground">
                Review your full attendance history
              </span>
            </span>
            <Clock className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}