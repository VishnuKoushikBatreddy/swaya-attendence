/**
 * Cron backstop. Two time-sensitive jobs ride on this one endpoint:
 *   1. auto check-out of sessions whose scheduled shift end has passed, and
 *   2. detection of phones that stopped reporting.
 *
 * SCHEDULE MATTERS — and it does NOT live in vercel.json.
 *
 * notifyOfflineEmployees deliberately skips sessions past their shift end
 * (silence after work is expected, not a fault). On a once-a-day schedule the
 * sweep therefore always ran after every shift had already finished, so the
 * offline alert could never fire for an ordinary day shift — not late, never.
 *
 * Vercel's Hobby plan rejects any sub-daily cron and fails the DEPLOYMENT, so
 * vercel.json keeps a daily run as a backstop and the real 10-minute cadence
 * lives in .github/workflows/cron-close-shifts.yml, which calls this endpoint
 * with the same bearer token. On Pro, move the interval back into vercel.json
 * and delete that workflow — running both just does the work twice.
 *
 * This endpoint is idempotent, so an extra invocation is harmless.
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
