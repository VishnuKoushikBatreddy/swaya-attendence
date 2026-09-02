/**
 * NATIVE ping ingest — the counterpart to /api/pings for the foreground
 * tracking service.
 *
 * /api/pings authenticates with requireAuth(), i.e. a NextAuth session cookie.
 * LocationTrackingService runs with the app killed and has no WebView, so it has
 * no cookie and cannot use that route at all. This mirrors the geofence-event
 * endpoint instead: a stateless native token, minted while the employee was
 * signed in and stored by the web app, identifies them.
 *
 * The batch is otherwise handled by exactly the same processPings() as the
 * cookie route, so auto-checkout, flagging and day rollups behave identically
 * however the pings arrived.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { parseJson, ok, fail, withApi } from "@/lib/api-helpers";
import { NativePingBatchSchema } from "@/lib/validators";
import {
  verifyNativeToken,
  mintNativeToken,
  shouldRefreshNativeToken,
} from "@/lib/native-token";
import { processPings } from "@/lib/attendance-service";
import { evaluateEventFreshness } from "@/lib/attendance-logic";
import { env } from "@/lib/env";
import { User } from "@/models";

export const dynamic = "force-dynamic";

export const POST = withApi(async (req: NextRequest) => {
  const body = await parseJson(req, NativePingBatchSchema);

  const payload = verifyNativeToken(body.token);
  if (!payload) return fail("Invalid or expired token", 401);

  // The token is stateless, so still confirm the employee exists and is active.
  const user = await User.findOne({
    _id: new Types.ObjectId(payload.employeeId),
    companyId: new Types.ObjectId(payload.companyId),
    isActive: true,
  })
    .select("_id")
    .lean();
  if (!user) return fail("Employee not found or inactive", 403);

  // The service buffers through dead zones, so a batch legitimately arrives late
  // and each ping is applied at its own capturedAt. Bound how far back that may
  // reach, for the same reason as the geofence endpoint: these requests carry a
  // long-lived token rather than a session. Stale pings are dropped rather than
  // failing the whole batch — one bad timestamp must not cost a day of tracking.
  const now = Date.now();
  const maxAgeMs = env.GEOFENCE_MAX_EVENT_AGE_MINUTES * 60_000;
  const maxSkewMs = env.GEOFENCE_MAX_CLOCK_SKEW_MINUTES * 60_000;

  const fresh = body.pings.filter((p) => {
    if (!p.capturedAt) return true; // server stamps it
    return evaluateEventFreshness(new Date(p.capturedAt).getTime(), now, maxAgeMs, maxSkewMs).ok;
  });
  const dropped = body.pings.length - fresh.length;

  if (fresh.length === 0) {
    return ok({ received: 0, dropped, autoCheckedOut: false, autoCheckoutAt: null });
  }

  const result = await processPings({
    employeeId: payload.employeeId,
    companyId: payload.companyId,
    pings: fresh,
  });

  // "No active session" is the normal state between shifts — the service keeps
  // buffering until the employee checks in. Report it without a 4xx, so the
  // device treats the batch as delivered instead of retrying it forever.
  if (!result.ok) {
    return ok({ received: 0, dropped, reason: result.reason, autoCheckedOut: false });
  }

  // Surfaces the batch in the platform logs, matching what /api/geofence-event
  // already does. Without this the route was completely silent, so a working
  // native service looked indistinguishable from a dead one: the geofence
  // endpoint logged loudly on every crossing while pings arriving every five
  // minutes produced nothing at all.
  //
  // appState is the useful field — only LocationTrackingService can report
  // "killed", because by definition no JavaScript is running to say so. Seeing
  // it here is the proof that tracking survived the app being swiped away.
  const states = [...new Set(fresh.map((p) => (p as { appState?: string }).appState ?? "unknown"))];
  // eslint-disable-next-line no-console
  console.log(
    `[native-pings] employee=${payload.employeeId} received=${result.received} dropped=${dropped} appState=${states.join(",")} autoCheckedOut=${result.autoCheckedOut ?? false}`
  );

  // Hand back a fresh token as expiry approaches. The device stores it and uses
  // it from the next upload, so a long-lived install never silently falls off a
  // cliff into 401s that the uploader would treat as permanent.
  const refreshedToken = shouldRefreshNativeToken(payload)
    ? mintNativeToken(payload.employeeId, payload.companyId)
    : undefined;
  if (refreshedToken) {
    // eslint-disable-next-line no-console
    console.log(`[native-pings] issued a refreshed token for ${payload.employeeId}`);
  }

  return ok({
    received: result.received,
    dropped,
    autoCheckedOut: result.autoCheckedOut ?? false,
    autoCheckoutAt: result.autoCheckoutAt ?? null,
    ...(refreshedToken ? { refreshedToken } : {}),
  });
});
