/**
 * Cron backstop. Two time-sensitive jobs ride on this one endpoint:
 *   1. auto check-out of sessions whose scheduled shift end has passed, and
 *   2. detection of phones that stopped reporting.
 *
 * SCHEDULE MATTERS — it is every 10 minutes (vercel.json), not daily.
 *
 * notifyOfflineEmployees deliberately skips sessions past their shift end
 * (silence after work is expected, not a fault). On the previous "0 2 * * *"
 * daily schedule the sweep therefore always ran after every shift had already
 * finished, so the offline alert could never fire for an ordinary day shift —
 * not late, never. The interval also bounds how long a session left open by a
 * dead phone inflates the live work total.
 *
 * Sub-daily crons require a Vercel Pro plan. On Hobby this silently degrades to
 * once a day: point an external scheduler (cron-job.org, GitHub Actions) at the
 * same URL with the `Authorization: Bearer <CRON_SECRET>` header instead.
 *
 * Secured with CRON_SECRET — Vercel sends it as `Authorization: Bearer <secret>`.
 */
import { NextRequest } from "next/server";
import { ok, fail, withApi } from "@/lib/api-helpers";
import { autoCloseEndedShifts, notifyOfflineEmployees } from "@/lib/attendance-service";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  if (env.CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) return fail("Unauthorized", 401);
  } else if (env.NODE_ENV === "production") {
    // Fail CLOSED: never expose an unauthenticated state-changing endpoint in
    // production. Without a configured secret the job is disabled, not open.
    return fail("Cron secret not configured", 503);
  }
  const closed = await autoCloseEndedShifts();
  // Offline detection rides on the same schedule: a phone that stopped reporting
  // cannot announce itself, so it can only be noticed by a sweep.
  const offlineNotified = await notifyOfflineEmployees();
  return ok({ closed, offlineNotified });
});
