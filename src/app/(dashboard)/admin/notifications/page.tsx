"use client";

/**
 * Admin notification feed.
 *
 * Replaces the SMTP alerts. Site exits, offline phones and check-outs are stored
 * in the database and read here, so nothing depends on mail delivery. Polls on
 * the same cadence as Live status, since these events arrive without any admin
 * action.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatTimeWithSeconds } from "@/lib/utils";
import {
  RefreshCw,
  MapPinOff,
  WifiOff,
  LogOut,
  CheckCheck,
  BellOff,
  Phone,
} from "lucide-react";

const POLL_MS = 20_000;

type NotificationType = "site_exit" | "offline" | "check_out" | "check_in";

type Item = {
  _id: string;
  type: NotificationType;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  employeeName: string;
  employeeCode: string;
  employeePhone: string;
  siteName: string;
  occurredAt: string;
  isRead: boolean;
  meta?: Record<string, unknown>;
};

const TYPE_META: Record<
  NotificationType,
  { label: string; icon: typeof MapPinOff; tone: string }
> = {
  site_exit: { label: "Left site", icon: MapPinOff, tone: "text-warning" },
  offline: { label: "Offline", icon: WifiOff, tone: "text-destructive" },
  check_out: { label: "Checked out", icon: LogOut, tone: "text-muted-foreground" },
  check_in: { label: "Checked in", icon: CheckCheck, tone: "text-success" },
};

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "site_exit", label: "Left site" },
  { key: "offline", label: "Offline" },
  { key: "check_out", label: "Checked out" },
];

export default function AdminNotificationsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Rendered only after mount: formatting a date on the server and again on the
  // client produced a hydration mismatch on this dashboard before.
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const f = filterRef.current;
      const qs = new URLSearchParams({ limit: "100" });
      if (f === "unread") qs.set("unread", "1");
      else if (f) qs.set("type", f);

      const res = await fetch(`/api/notifications?${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed to load");
      setItems(json.data.notifications);
      setUnread(json.data.unreadCount);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Refetch when the filter changes, without restarting the poll timer.
  useEffect(() => {
    load();
  }, [filter, load]);

  async function markRead(ids: string[] | "all") {
    // Optimistic: the feed should feel instant, and a failed PATCH is corrected
    // by the next poll.
    setItems((prev) =>
      prev.map((n) => (ids === "all" || ids.includes(n._id) ? { ...n, isRead: true } : n))
    );
    setUnread((u) => (ids === "all" ? 0 : Math.max(0, u - ids.length)));
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids === "all" ? { all: true } : { ids }),
      });
    } finally {
      load();
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Site exits, offline devices and check-outs
            {unread > 0 ? ` · ${unread} unread` : ""}
            {lastUpdated ? ` · updated ${formatTimeWithSeconds(new Date(lastUpdated))}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => markRead("all")}
            disabled={unread === 0}
            className="gap-2"
          >
            <CheckCheck className="h-4 w-4" />
            Mark all read
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key || "all"}
            variant={filter === f.key ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key === "unread" && unread > 0 ? ` (${unread})` : ""}
          </Button>
        ))}
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Refreshes automatically every 20 seconds</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
              <BellOff className="h-8 w-8" />
              <p className="text-sm">
                {loading ? "Loading…" : "No notifications yet"}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const meta = TYPE_META[n.type] ?? TYPE_META.check_out;
                const Icon = meta.icon;
                return (
                  <li
                    key={n._id}
                    className={cn(
                      "flex gap-3 p-4 transition-colors",
                      !n.isRead && "bg-muted/40"
                    )}
                  >
                    <Icon className={cn("mt-0.5 h-5 w-5 flex-shrink-0", meta.tone)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={cn("text-sm", !n.isRead && "font-semibold")}>
                          {n.title}
                        </p>
                        <Badge
                          variant={
                            n.severity === "critical"
                              ? "destructive"
                              : n.severity === "warning"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {meta.label}
                        </Badge>
                        {!n.isRead && (
                          <span className="h-2 w-2 rounded-full bg-primary" aria-label="Unread" />
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {n.employeeCode && <span>Code {n.employeeCode}</span>}
                        {n.employeePhone && (
                          <a
                            href={`tel:${n.employeePhone}`}
                            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                          >
                            <Phone className="h-3 w-3" />
                            {n.employeePhone}
                          </a>
                        )}
                        <span suppressHydrationWarning>
                          {new Date(n.occurredAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    {!n.isRead && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => markRead([n._id])}
                        className="self-start"
                      >
                        Mark read
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
