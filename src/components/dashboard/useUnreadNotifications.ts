"use client";

import { useEffect, useState } from "react";

const POLL_MS = 60_000;

/**
 * Unread notification count for the sidebar badge.
 *
 * Admin-only: the endpoint is role-guarded, so calling it as an employee would
 * just produce a stream of 403s in the console. Fetches `limit=1` because only
 * the count is needed — the feed itself is loaded by the notifications page.
 *
 * Failures are swallowed: a badge that cannot load must never surface an error
 * over the whole dashboard.
 */
export function useUnreadNotifications(role: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/notifications?limit=1", { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json?.ok) setCount(json.data.unreadCount ?? 0);
      } catch {
        /* badge is cosmetic — never surface a network blip */
      }
    }

    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [role]);

  return count;
}
