"use client";

/**
 * Live employee status — who is checked in right now.
 *
 * Distinct from Reports, which is day-level history. This reads open
 * AttendanceSessions, so "Checked in" means a session is genuinely open, and it
 * polls so a geofence-driven check-in/out that happened with no admin action
 * still appears without a manual refresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatDuration, formatTimeWithSeconds } from "@/lib/utils";
import { RefreshCw, Users, CheckCircle2, MapPinOff, AlertCircle } from "lucide-react";

const POLL_MS = 20_000;

type LiveRow = {
  id: string;
  fullName: string;
  email: string;
  employeeCode: string | null;
  department: string | null;
  checkedIn: boolean;
  checkedInAt: string | null;
  siteName: string | null;
  lastSeenAt: string | null;
  lastSeenMinutesAgo: number | null;
  isInsideGeofence: boolean | null;
  distanceFromSiteMeters: number | null;
  batteryPercentage: number | null;
  dayStatus: string | null;
  totalWorkSeconds: number;
  isFlagged: boolean;
  firstCheckInAt: string | null;
  lastCheckOutAt: string | null;
};

type LiveData = {
  workDate: string;
  summary: { total: number; checkedIn: number; outsideGeofence: number; flagged: number };
  employees: LiveRow[];
};

/** Ticking "1h 23m" for an open session, so the row feels live between polls. */
function elapsed(sinceIso: string, nowMs: number): string {
  return formatDuration(Math.max(0, Math.floor((nowMs - new Date(sinceIso).getTime()) / 1000)));
}

export default function AdminLivePage() {
  const [data, setData] = useState<LiveData | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Discard a slow response that a newer request has already superseded.
  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/live");
      const json = await res.json();
      if (seq !== seqRef.current) return;
      if (json.ok) {
        setData(json.data);
        setLastUpdated(Date.now());
      }
    } catch {
      /* keep the last good view; the next poll retries */
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Re-fetch on returning to the tab rather than showing a stale board.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  // Ticks the on-shift durations between polls.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = (data?.employees ?? []).filter((r) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [r.fullName, r.email, r.employeeCode, r.department]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });
  // Checked-in first, then alphabetically — the people on shift are the point.
  const sorted = [...rows].sort((a, b) =>
    a.checkedIn === b.checkedIn ? a.fullName.localeCompare(b.fullName) : a.checkedIn ? -1 : 1
  );

  const cards = [
    { title: "Employees", value: data?.summary.total, icon: Users, color: "text-primary" },
    { title: "Checked in now", value: data?.summary.checkedIn, icon: CheckCircle2, color: "text-success" },
    { title: "Away from site", value: data?.summary.outsideGeofence, icon: MapPinOff, color: "text-warning" },
    { title: "Flagged today", value: data?.summary.flagged, icon: AlertCircle, color: "text-destructive" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live status</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Who is checked in right now
            {data?.workDate ? ` · ${data.workDate}` : ""}
            {lastUpdated ? ` · updated ${formatTimeWithSeconds(new Date(lastUpdated))}` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.title}>
              <CardContent className="flex items-center justify-between p-5">
                <div>
                  <p className="text-sm text-muted-foreground">{c.title}</p>
                  <p className="text-2xl font-bold tabular-nums">{c.value ?? "…"}</p>
                </div>
                <Icon className={cn("h-7 w-7 flex-shrink-0", c.color)} />
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Employees</CardTitle>
              <CardDescription>Refreshes automatically every 20 seconds</CardDescription>
            </div>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, code or department"
              className="w-full sm:max-w-xs"
              aria-label="Search employees"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {data == null ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : sorted.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {query ? "No one matches that search." : "No employees yet."}
            </p>
          ) : (
            <ul className="divide-y">
              {sorted.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap">
                  {/* Presence dot — the fastest thing to scan down the list. */}
                  <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden>
                    {r.checkedIn && (
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    )}
                    <span
                      className={cn(
                        "relative inline-flex h-2.5 w-2.5 rounded-full",
                        r.checkedIn ? "bg-success" : "bg-muted-foreground/40"
                      )}
                    />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {r.fullName}
                      {r.employeeCode ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {r.employeeCode}
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.checkedIn ? (
                        <>
                          {r.siteName ?? "Unknown site"}
                          {r.checkedInAt ? ` · since ${formatTimeWithSeconds(r.checkedInAt)}` : ""}
                          {r.lastSeenMinutesAgo != null
                            ? ` · last seen ${r.lastSeenMinutesAgo === 0 ? "just now" : `${r.lastSeenMinutesAgo}m ago`}`
                            : " · no location yet"}
                        </>
                      ) : r.lastCheckOutAt ? (
                        `Checked out at ${formatTimeWithSeconds(r.lastCheckOutAt)}`
                      ) : (
                        r.email
                      )}
                    </p>
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-2">
                    {r.checkedIn && r.isInsideGeofence === false && (
                      <Badge variant="warning" className="gap-1">
                        <MapPinOff className="h-3 w-3" />
                        {r.distanceFromSiteMeters != null
                          ? `${r.distanceFromSiteMeters}m away`
                          : "Away"}
                      </Badge>
                    )}
                    {r.isFlagged && <Badge variant="destructive">Flagged</Badge>}
                    {r.dayStatus && (
                      <Badge
                        className="capitalize"
                        variant={
                          r.dayStatus === "present"
                            ? "success"
                            : r.dayStatus === "late"
                              ? "warning"
                              : r.dayStatus === "absent"
                                ? "destructive"
                                : "secondary"
                        }
                      >
                        {r.dayStatus.replace("_", " ")}
                      </Badge>
                    )}
                    <span className="w-20 text-right text-sm font-medium tabular-nums">
                      {r.checkedIn && r.checkedInAt
                        ? elapsed(r.checkedInAt, nowMs)
                        : formatDuration(r.totalWorkSeconds)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
