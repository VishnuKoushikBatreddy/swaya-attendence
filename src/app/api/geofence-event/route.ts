/**
 * NATIVE GEOFENCE FALLBACK endpoint (app killed).
 *
 * The Android OS geofence receiver POSTs ENTER/EXIT here while the app is dead.
 * Authenticated by a stateless native token (no session cookie). ENTER -> auto
 * check-in (coarse, geofence-sourced); EXIT -> auto check-out. The precise
 * app-open ping system remains the primary path and is untouched.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { parseJson, ok, fail, withApi } from "@/lib/api-helpers";
import { GeofenceEventSchema } from "@/lib/validators";
import { verifyNativeToken } from "@/lib/native-token";
import { processGeofenceEnter, processGeofenceExit } from "@/lib/attendance-service";
import { evaluateEventFreshness } from "@/lib/attendance-logic";
import { env } from "@/lib/env";
import { User } from "@/models";

export const dynamic = "force-dynamic";

export const POST = withApi(async (req: NextRequest) => {
  const body = await parseJson(req, GeofenceEventSchema);

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

  // Staleness guard. The native receiver retries failed uploads, so a genuine
  // event may arrive hours late and is still applied at its ORIGINAL time — but
  // an unbounded window would let a stale or forged timestamp rewrite a finished
  // day, and these requests carry a long-lived native token rather than a
  // session. 400 (not 5xx) is deliberate: the Android worker drops 4xx and
  // retries everything else, and a stale event only gets staler.
  if (body.capturedAt) {
    const freshness = evaluateEventFreshness(
      new Date(body.capturedAt).getTime(),
      Date.now(),
      env.GEOFENCE_MAX_EVENT_AGE_MINUTES * 60_000,
      env.GEOFENCE_MAX_CLOCK_SKEW_MINUTES * 60_000
    );
    if (!freshness.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[geofence] rejected ${body.transition} employee=${payload.employeeId} capturedAt=${body.capturedAt}: ${freshness.reason}`
      );
      return fail(freshness.reason, 400);
    }
  }

  const common = {
    employeeId: payload.employeeId,
    companyId: payload.companyId,
    lat: body.lat,
    lng: body.lng,
    accuracyMeters: body.accuracy,
    capturedAt: body.capturedAt,
  };

  const result =
    body.transition === "EXIT"
      ? await processGeofenceExit(common)
      : await processGeofenceEnter({ ...common, deviceId: "geofence" });

  // Surfaces the direction + outcome in the Vercel logs so you can see whether a
  // killed-app EXIT actually auto-checked-out (ok:true) or found no session.
  // eslint-disable-next-line no-console
  console.log(
    `[geofence] ${body.transition} employee=${payload.employeeId} ok=${(result as { ok?: boolean }).ok}`
  );

  return ok({ transition: body.transition, result });
});
