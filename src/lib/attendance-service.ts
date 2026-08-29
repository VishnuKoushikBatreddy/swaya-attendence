/**
 * Server-side attendance business logic.
 * Pure functions over the data — no Express, no Next specifics.
 */
import { Types } from "mongoose";
import { connectDB } from "./db";
import {
  AttendanceDay,
  AttendanceEvent,
  AttendanceSession,
  EmployeeSchedule,
  EmployeeSiteAssignment,
  GeofenceEvent,
  LocationPing,
  OutsideSiteLog,
  ShiftTemplate,
  User,
  WorkSite,
} from "@/models";
import { haversineDistanceMeters, isInsideGeofence } from "./geo";
import {
  summarizeSessionPings,
  computeDayTotals,
  effectiveInsideState,
  isSustainedAway,
  evaluateScheduleGate,
  evaluateLateness,
  clampCheckOut,
  clampEventTimeToNow,
  classifyOutsideForDay,
  resolveDayStatus,
  resolveAutoCheckout,
  shouldGapCheckout,
  deriveCheckoutSource,
} from "./attendance-logic";
import {
  todayWorkDate,
  getWorkDateInTimezone,
  isWithinLocalTimeWindow,
  zonedDateTimeToUtc,
} from "./workdate";
import { getCompanyTimezone } from "./company";
import { flagPings, type PingLike } from "./attendance";
import { sendEmail } from "./email";
import { env } from "./env";
import { formatInTimeZone } from "date-fns-tz";

export type CheckInInput = {
  employeeId: string;
  companyId: string;
  timezone: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  isMockLocation?: boolean;
  deviceId: string;
  appVersion?: string;
  appState?: "foreground" | "background" | "killed" | "unknown";
  networkType?: "wifi" | "mobile_data" | "offline" | "unknown";
  batteryPercentage?: number;
  // When a check-in was made OFFLINE and is being synced later, this is the time
  // it actually happened. Defaults to "now" for normal online check-ins.
  capturedAt?: string;
  // Set when this check-in was triggered by the native OS geofence (app killed).
  // The OS geofence is a wider ~100m ring, so the precise radius rejection is
  // skipped — the OS already confirmed the employee crossed into the site area.
  geofenceTriggered?: boolean;
};

export type CheckInResult =
  | { ok: true; attendanceDay: any; session: any; site: any }
  | { ok: false; reason: string; nearestSite?: any; distance?: number };

/**
 * Find the work site the employee is currently inside.
 * Considers all active assignments, then any site the user is within radius of.
 */
export async function findSiteForCheckIn(opts: {
  companyId: string;
  employeeId: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
}) {
  await connectDB();
  const assignments = await EmployeeSiteAssignment.find({
    companyId: new Types.ObjectId(opts.companyId),
    employeeId: new Types.ObjectId(opts.employeeId),
    isActive: true,
  }).lean();

  if (assignments.length === 0) return null;

  const sites = await WorkSite.find({
    _id: { $in: assignments.map((a: { siteId: unknown }) => a.siteId) },
    companyId: new Types.ObjectId(opts.companyId),
    isActive: true,
  }).lean();

  // pick the site where the user is inside
  let bestInside: { site: any; distance: number } | null = null;
  let bestOverall: { site: any; distance: number } | null = null;
  for (const s of sites) {
    const [lng, lat] = s.location.coordinates;
    const { distance } = isInsideGeofence(
      { lat: opts.lat, lng: opts.lng },
      { lat, lng },
      s.radiusMeters,
      opts.accuracyMeters ?? 0
    );
    if (!bestOverall || distance < bestOverall.distance) {
      bestOverall = { site: s, distance };
    }
    if (
      distance <= s.radiusMeters + (opts.accuracyMeters ?? 0) &&
      (!bestInside || distance < bestInside.distance)
    ) {
      bestInside = { site: s, distance };
    }
  }
  return bestInside || bestOverall;
}

/**
 * Decide which work site a check-in is validated against.
 *  - If the employee has a schedule for `workDate` that is a working day with a
 *    site, that SCHEDULED site is used (per-day rotation). The schedule grants
 *    access to that site for the day even if it isn't a permanent assignment.
 *  - Otherwise fall back to the employee's permanent site assignment(s).
 * Returns the chosen site + the employee's distance from it, or null.
 */
async function resolveCheckInSite(
  input: { employeeId: string; companyId: string; lat: number; lng: number; accuracyMeters?: number },
  workDate: string
): Promise<{ site: any; distance: number } | null> {
  const schedule = await EmployeeSchedule.findOne({
    employeeId: new Types.ObjectId(input.employeeId),
    workDate,
  }).lean();

  if (schedule && schedule.isWorkingDay && schedule.siteId) {
    const site = await WorkSite.findOne({
      _id: schedule.siteId,
      companyId: new Types.ObjectId(input.companyId),
      isActive: true,
    }).lean();
    if (site) {
      const [lng, lat] = site.location.coordinates;
      const { distance } = isInsideGeofence(
        { lat: input.lat, lng: input.lng },
        { lat, lng },
        site.radiusMeters,
        input.accuracyMeters ?? 0
      );
      return { site, distance };
    }
    // Scheduled site missing/inactive — fall through to permanent assignments.
  }

  return findSiteForCheckIn(input);
}

export async function processCheckIn(input: CheckInInput): Promise<CheckInResult> {
  await connectDB();
  // Effective check-in time: the captured time for an offline check-in being
  // synced later, otherwise now.
  const at = input.capturedAt ? new Date(input.capturedAt) : new Date();
  const workDate = getWorkDateInTimezone(at, input.timezone);

  // Enforce scheduled shift hours (when the employee has a schedule for today).
  const gate = await scheduleGate(input.employeeId, workDate, at.getTime());
  if (!gate.ok) return { ok: false, reason: gate.reason };

  // Idempotency / duplicate-check-in guard: never open a second concurrent
  // session. A double-tap, a network retry, or an offline-queue replay of a
  // check-in that already succeeded online would otherwise create overlapping
  // active sessions and double-count cumulative work time. Rejecting here makes
  // the offline replay drop the action (it treats 4xx as "already handled").
  const openSession = await AttendanceSession.findOne({
    employeeId: new Types.ObjectId(input.employeeId),
    status: { $in: ["active", "flagged"] },
  })
    .select("_id")
    .lean();
  if (openSession) {
    return { ok: false, reason: "already_checked_in" };
  }

  // On a scheduled working day, validate the geofence against the SCHEDULED site
  // (per-day rotation); otherwise fall back to the permanent site assignment.
  const found = await resolveCheckInSite(input, workDate);
  if (!found) {
    return { ok: false, reason: "no_assignment" };
  }
  // A native-geofence-triggered check-in is validated by the OS's wider ~100m
  // ring, so skip the precise 20m rejection (the app-open path still enforces it).
  if (
    !input.geofenceTriggered &&
    found.distance > found.site.radiusMeters + (input.accuracyMeters ?? 0)
  ) {
    return {
      ok: false,
      reason: "outside_geofence",
      nearestSite: found.site,
      distance: found.distance,
    };
  }

  // Server-side mock-location check
  const lastPing = await LocationPing.findOne({
    employeeId: new Types.ObjectId(input.employeeId),
  })
    .sort({ capturedAt: -1 })
    .lean();
  if (lastPing && !input.isMockLocation) {
    const dist = haversineDistanceMeters(
      { lat: lastPing.location.coordinates[1], lng: lastPing.location.coordinates[0] },
      { lat: input.lat, lng: input.lng }
    );
    const dtSec = (Date.now() - new Date(lastPing.capturedAt).getTime()) / 1000;
    if (dtSec > 1) {
      const speed = (dist / dtSec) * 3.6;
      if (speed > env.MOCK_LOCATION_SPEED_KMH) {
        input.isMockLocation = true; // server-side flagged
      }
    }
  }

  // Upsert attendance day
  const day = await AttendanceDay.findOneAndUpdate(
    {
      employeeId: new Types.ObjectId(input.employeeId),
      workDate,
    },
    {
      $setOnInsert: {
        companyId: new Types.ObjectId(input.companyId),
        siteId: found.site._id,
        workDate,
        status: "pending",
      },
      $set: { isFlagged: false },
    },
    { upsert: true, new: true }
  );

  // Optional: lookup schedule for the day
  const schedule = await EmployeeSchedule.findOne({
    employeeId: new Types.ObjectId(input.employeeId),
    workDate,
  }).lean();

  // Create session
  const session = await AttendanceSession.create({
    attendanceDayId: day._id,
    companyId: new Types.ObjectId(input.companyId),
    employeeId: new Types.ObjectId(input.employeeId),
    siteId: found.site._id,
    checkInAt: at,
    checkInLocation: { type: "Point", coordinates: [input.lng, input.lat] },
    checkInAccuracyMeters: input.accuracyMeters,
    checkInDistanceMeters: found.distance,
    // Freeze the geofence for this session at the moment of check-in.
    geofence: {
      lat: found.site.location.coordinates[1],
      lng: found.site.location.coordinates[0],
      radiusMeters: found.site.radiusMeters,
    },
    status: input.isMockLocation ? "flagged" : "active",
    deviceId: input.deviceId,
    appVersion: input.appVersion,
  });

  // First ping
  await LocationPing.create({
    attendanceDayId: day._id,
    sessionId: session._id,
    companyId: new Types.ObjectId(input.companyId),
    employeeId: new Types.ObjectId(input.employeeId),
    siteId: found.site._id,
    capturedAt: at,
    location: { type: "Point", coordinates: [input.lng, input.lat] },
    accuracyMeters: input.accuracyMeters,
    distanceFromSiteMeters: found.distance,
    isInsideGeofence: true,
    isMockLocation: input.isMockLocation ?? false,
    isGpsEnabled: true,
    batteryPercentage: input.batteryPercentage,
    networkType: input.networkType ?? "unknown",
    appState: input.appState ?? "unknown",
  });

  // Geofence event: entered_site
  await GeofenceEvent.create({
    attendanceDayId: day._id,
    sessionId: session._id,
    companyId: new Types.ObjectId(input.companyId),
    employeeId: new Types.ObjectId(input.employeeId),
    siteId: found.site._id,
    eventType: "entered_site",
    eventAt: at,
    location: { type: "Point", coordinates: [input.lng, input.lat] },
    accuracyMeters: input.accuracyMeters,
    distanceFromSiteMeters: found.distance,
  });

  // Update day. EARLIEST check-in of the day: an offline check-in syncing later
  // carries its original (earlier) capturedAt, so take the minimum rather than
  // only setting this when empty.
  const previousCheckIn = day.firstCheckInAt ? new Date(day.firstCheckInAt).getTime() : Infinity;
  if (at.getTime() < previousCheckIn) day.firstCheckInAt = at;
  if (schedule) {
    day.scheduleId = schedule._id;
    const graceMin = schedule.expectedStartAt
      ? await getGraceMinutesForSchedule(schedule)
      : 0;
    const lateness = evaluateLateness(
      schedule.expectedStartAt ? new Date(schedule.expectedStartAt).getTime() : null,
      at.getTime(),
      graceMin
    );
    day.status = lateness.status;
    if (lateness.status === "late") day.lateByMinutes = lateness.lateByMinutes;
  } else {
    day.status = "present";
  }
  if (input.isMockLocation) {
    day.isFlagged = true;
    day.flagReasons = Array.from(new Set([...(day.flagReasons || []), "mock_location_at_check_in"]));
  }
  if (input.geofenceTriggered) {
    // Audit trail: this check-in came from the coarse native geofence (app was
    // killed), not the precise app-open path. Not a flag, just a marker.
    day.flagReasons = Array.from(new Set([...(day.flagReasons || []), "geofence_check_in"]));
  }
  await day.save();

  // Ledger: record the check-in event (manual vs native-geofence ENTER).
  await recordAttendanceEvent({
    companyId: input.companyId,
    employeeId: input.employeeId,
    attendanceDayId: day._id,
    sessionId: session._id,
    siteId: found.site._id,
    type: "check-in",
    source: input.geofenceTriggered ? "geofence_enter" : "manual",
    at,
    workDate,
    lat: input.lat,
    lng: input.lng,
    accuracyMeters: input.accuracyMeters,
    distanceFromSiteMeters: found.distance,
    sessionStatus: session.status,
  });

  return {
    ok: true,
    attendanceDay: day.toObject(),
    session: session.toObject(),
    site: found.site,
  };
}

async function getGraceMinutesForSchedule(schedule: any): Promise<number> {
  if (!schedule?.shiftTemplateId) return 0;
  const tpl = await ShiftTemplate.findById(schedule.shiftTemplateId).lean();
  return tpl?.graceMinutes ?? 0;
}

export async function processCheckOut(opts: {
  employeeId: string;
  companyId: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  isMockLocation?: boolean;
  deviceId?: string;
  appVersion?: string;
  timezone: string;
  capturedAt?: string;
}) {
  await connectDB();
  // Effective check-out time: captured time for an offline check-out, else now.
  const at = opts.capturedAt ? new Date(opts.capturedAt) : new Date();

  // Enforce scheduled shift hours (when the employee has a schedule for the day).
  const gate = await scheduleGate(
    opts.employeeId,
    getWorkDateInTimezone(at, opts.timezone),
    at.getTime()
  );
  if (!gate.ok) return { ok: false as const, reason: gate.reason };

  const session = await AttendanceSession.findOne({
    employeeId: new Types.ObjectId(opts.employeeId),
    status: { $in: ["active", "flagged"] },
  }).sort({ checkInAt: -1 });
  if (!session) return { ok: false as const, reason: "no_active_session" };

  const { day } = await finalizeSession({
    session,
    lat: opts.lat,
    lng: opts.lng,
    accuracyMeters: opts.accuracyMeters,
    checkOutAt: at,
    status: opts.isMockLocation ? "flagged" : "completed",
  });
  return { ok: true as const, session, day };
}

/**
 * NATIVE GEOFENCE FALLBACK (app killed). These run ONLY when the OS geofence
 * fires while the precise app-open ping system is dead. They reuse the same
 * building blocks (finalizeSession / processCheckIn) so the primary logic is
 * untouched. The OS geofence is a wider ~100m ring; events are coarse (2-5 min).
 */

/** EXIT: the employee crossed out of the site geofence — auto check them out. */
export async function processGeofenceExit(opts: {
  employeeId: string;
  companyId: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  capturedAt?: string;
}) {
  await connectDB();
  // Never let a device clock running fast push the exit into the future, which
  // would credit work time that has not happened yet.
  const at = opts.capturedAt
    ? new Date(clampEventTimeToNow(new Date(opts.capturedAt).getTime(), Date.now()))
    : new Date();
  // Automatic OS-detected exit — no schedule gate (mirrors the sustained-absence
  // and end-of-shift auto-closes, which also bypass the manual gate).
  //
  // `checkInAt <= at` is a REPLAY GUARD. The native receiver queues events that
  // failed to upload, so an EXIT can arrive long after it happened; without this
  // it would close whichever session is open *now*, even one that began after
  // the employee had already left and come back. That case (leave 09:00 offline
  // -> return and check in 10:00 -> queued EXIT flushes 10:05) would close the
  // 10:00 session back-dated to 09:00, which clampCheckOut pins to the check-in
  // instant: a zero-length session and an employee silently checked out again.
  // A stale exit that matches nothing is simply dropped.
  const session = await AttendanceSession.findOne({
    employeeId: new Types.ObjectId(opts.employeeId),
    status: { $in: ["active", "flagged"] },
    checkInAt: { $lte: at },
  }).sort({ checkInAt: -1 });
  if (!session) return { ok: false as const, reason: "no_active_session" };
  const { day } = await finalizeSession({
    session,
    lat: opts.lat,
    lng: opts.lng,
    accuracyMeters: opts.accuracyMeters,
    checkOutAt: at,
    status: "auto_closed",
    reason: "auto_checkout_geofence_exit",
  });
  return { ok: true as const, session, day };
}

/** ENTER: the employee crossed into the site geofence — auto check them in. */
export async function processGeofenceEnter(opts: {
  employeeId: string;
  companyId: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  deviceId?: string;
  capturedAt?: string;
}) {
  await connectDB();
  // If a session is already open (e.g. the app-open path already checked them
  // in), do nothing — the precise logic wins.
  const existing = await AttendanceSession.findOne({
    employeeId: new Types.ObjectId(opts.employeeId),
    status: { $in: ["active", "flagged"] },
  })
    .select("_id")
    .lean();
  if (existing) return { ok: true as const, alreadyActive: true };

  // REPLAY GUARD, mirroring the one in processGeofenceExit. A queued ENTER can
  // arrive after the employee has already worked and checked out — replaying it
  // would open a SECOND session back-dated into that finished stretch, and
  // computeDayTotals sums every session, so the day's work time would be counted
  // twice. Skip when any session already starts at/after this instant, or was
  // still running at it. For a live event (at ≈ now) neither can match, so this
  // only ever suppresses genuinely stale replays.
  if (opts.capturedAt) {
    const at = new Date(opts.capturedAt);
    const superseded = await AttendanceSession.findOne({
      employeeId: new Types.ObjectId(opts.employeeId),
      $or: [{ checkInAt: { $gte: at } }, { checkOutAt: { $gte: at } }],
    })
      .select("_id")
      .lean();
    if (superseded) return { ok: true as const, superseded: true };
  }

  const timezone = await getCompanyTimezone(opts.companyId);
  return processCheckIn({
    employeeId: opts.employeeId,
    companyId: opts.companyId,
    timezone,
    lat: opts.lat,
    lng: opts.lng,
    accuracyMeters: opts.accuracyMeters,
    deviceId: opts.deviceId ?? "geofence",
    // Same clamp as the exit path: a fast device clock must not back-date the
    // check-in into the future, which evaluateLateness would then compare
    // against the shift start.
    capturedAt: opts.capturedAt
      ? new Date(
          clampEventTimeToNow(new Date(opts.capturedAt).getTime(), Date.now())
        ).toISOString()
      : undefined,
    geofenceTriggered: true,
  });
}

/**
 * Best-effort email to the company's admins when an employee checks out, so they
 * can follow up (e.g. call the employee). Includes name, code, phone, time, reason.
 */
async function notifyAdminOfCheckout(session: any, reason?: string) {
  const [employee, admins, timezone] = await Promise.all([
    User.findById(session.employeeId).lean(),
    User.find({ companyId: session.companyId, role: "admin", isActive: true })
      .select("email")
      .lean(),
    getCompanyTimezone(String(session.companyId)),
  ]);
  if (!employee || !admins.length) return;

  const when = formatInTimeZone(new Date(session.checkOutAt), timezone, "yyyy-MM-dd HH:mm");
  const reasonLabel =
    reason === "auto_checkout_left_site"
      ? "Automatic — left the site"
      : reason === "auto_checkout_shift_ended"
        ? "Automatic — shift ended"
        : reason === "auto_checkout_ping_gap"
          ? "Automatic — app closed / tracking lost"
          : reason === "auto_checkout_geofence_exit"
            ? "Automatic — left the site (geofence, app closed)"
            : "Manual check-out";

  const html = `
    <p><b>${employee.fullName}</b> has checked out.</p>
    <ul>
      <li>Name: ${employee.fullName}</li>
      <li>Employee code: ${employee.employeeCode || "—"}</li>
      <li>Phone: ${employee.phone || "—"}</li>
      <li>Time: ${when}</li>
      <li>Type: ${reasonLabel}</li>
    </ul>
    <p>You may want to call them to follow up.</p>`;

  await Promise.all(
    admins.map((a: any) =>
      sendEmail({ to: a.email, subject: `${employee.fullName} checked out`, html })
    )
  );
}

/**
 * Append one row to the immutable check-in/out ledger (AttendanceEvent). Records
 * every event with how it happened, indexed by work date, for later auditing.
 * Best-effort: never blocks or fails the attendance flow.
 */
async function recordAttendanceEvent(e: {
  companyId: any;
  employeeId: any;
  attendanceDayId: any;
  sessionId: any;
  siteId: any;
  type: "check-in" | "check-out";
  source: string;
  at: Date;
  workDate: string;
  lat?: number;
  lng?: number;
  accuracyMeters?: number;
  distanceFromSiteMeters?: number;
  sessionStatus?: string;
}) {
  try {
    await AttendanceEvent.create({
      companyId: new Types.ObjectId(String(e.companyId)),
      employeeId: new Types.ObjectId(String(e.employeeId)),
      attendanceDayId: e.attendanceDayId,
      sessionId: e.sessionId,
      siteId: e.siteId,
      type: e.type,
      source: e.source,
      at: e.at,
      workDate: e.workDate,
      location:
        e.lat != null && e.lng != null
          ? { type: "Point", coordinates: [e.lng, e.lat] }
          : null,
      accuracyMeters: e.accuracyMeters,
      distanceFromSiteMeters: e.distanceFromSiteMeters,
      sessionStatus: e.sessionStatus,
    });
  } catch {
    /* ledger is best-effort — never block check-in/out on it */
  }
}

/**
 * Close out an attendance session and roll its summary up to the day.
 * Shared by manual check-out and the automatic geofence-exit check-out.
 * `checkOutAt` is the effective end time (for auto check-out this is the
 * moment the employee crossed the site boundary, not when we processed it).
 */
async function finalizeSession(opts: {
  session: any;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  checkOutAt: Date;
  status: "completed" | "auto_closed" | "flagged";
  reason?: string;
}) {
  const { session } = opts;

  // Never let a back-dated check-out land before check-in (would yield negative /
  // zeroed durations and corrupt the day totals).
  const checkInMs = new Date(session.checkInAt).getTime();
  const checkOutAt = new Date(clampCheckOut(checkInMs, opts.checkOutAt.getTime()));

  session.checkOutAt = checkOutAt;
  session.checkOutLocation = { type: "Point", coordinates: [opts.lng, opts.lat] };
  session.checkOutAccuracyMeters = opts.accuracyMeters;
  session.status = opts.status;

  // distance from site at check-out — use the session's frozen geofence center.
  let siteLat: number;
  let siteLng: number;
  if (session.geofence && session.geofence.lat != null) {
    siteLat = session.geofence.lat;
    siteLng = session.geofence.lng;
  } else {
    const ws = await WorkSite.findById(session.siteId).lean();
    siteLng = ws!.location.coordinates[0];
    siteLat = ws!.location.coordinates[1];
  }
  session.checkOutDistanceMeters = haversineDistanceMeters(
    { lat: siteLat, lng: siteLng },
    { lat: opts.lat, lng: opts.lng }
  );
  await session.save();

  // Close any open outside logs as of the check-out time.
  await OutsideSiteLog.updateMany(
    { sessionId: session._id, returnedAt: null },
    { $set: { returnedAt: session.checkOutAt, status: "closed" } }
  );

  // Roll up the WHOLE day across all sessions (cumulative work/inside/outside,
  // plus break time between sessions) — never just this one session.
  const totals = await recomputeDayTotals(session.attendanceDayId);
  const outside = classifyOutsideForDay({
    totalOutsideSeconds: totals.totalOutsideSeconds,
  });

  const day = await AttendanceDay.findById(session.attendanceDayId);
  if (day) {
    // LATEST check-out of the day, never just "the most recently written one".
    // Sessions are not always finalized in chronological order — a replayed
    // geofence EXIT, the cron sweep and a manual check-out can close sessions in
    // any sequence — so assigning unconditionally let this value move backwards.
    const previousCheckOut = day.lastCheckOutAt ? new Date(day.lastCheckOutAt).getTime() : 0;
    if (new Date(session.checkOutAt).getTime() >= previousCheckOut) {
      day.lastCheckOutAt = session.checkOutAt;
    }
    day.totalWorkSeconds = totals.totalWorkSeconds;
    day.totalInsideSeconds = totals.totalInsideSeconds;
    day.totalOutsideSeconds = totals.totalOutsideSeconds;
    day.totalBreakSeconds = totals.totalBreakSeconds;
    day.totalUnaccountedSeconds = totals.totalUnaccountedSeconds;
    day.outsideVisitCount = totals.outsideVisitCount;
    day.breakCount = totals.breakCount;

    const reasons = new Set(day.flagReasons || []);
    if (outside.flagExcessiveOutside) {
      day.isFlagged = true;
      reasons.add("excessive_outside_time");
    } else {
      // Re-evaluated on every finalize: a later session can bring the day back
      // under the threshold, and a flag set by an earlier partial rollup must
      // not stick once it no longer holds.
      reasons.delete("excessive_outside_time");
      if (reasons.size === 0) day.isFlagged = false;
    }
    if (opts.reason) {
      reasons.add(opts.reason);
    }
    day.flagReasons = Array.from(reasons);

    // Derived, not mutated — see resolveDayStatus. Mutating meant half_day was a
    // one-way door (3h then 3h more stayed half_day at 6h) and a late day could
    // never be half_day at all.
    day.status = resolveDayStatus({
      currentStatus: day.status,
      totalWorkSeconds: day.totalWorkSeconds,
      lateByMinutes: day.lateByMinutes ?? 0,
    });
    await day.save();
  }

  // Ledger: record the check-out event with how it happened (manual, geofence
  // exit, shift end, sustained absence, ping gap).
  await recordAttendanceEvent({
    companyId: session.companyId,
    employeeId: session.employeeId,
    attendanceDayId: session.attendanceDayId,
    sessionId: session._id,
    siteId: session.siteId,
    type: "check-out",
    source: deriveCheckoutSource(opts.reason),
    at: checkOutAt,
    workDate: day?.workDate ?? getWorkDateInTimezone(checkOutAt, "UTC"),
    lat: opts.lat,
    lng: opts.lng,
    accuracyMeters: opts.accuracyMeters,
    distanceFromSiteMeters: session.checkOutDistanceMeters,
    sessionStatus: opts.status,
  });

  // Best-effort: email the company admins so they can follow up / call.
  try {
    await notifyAdminOfCheckout(session, opts.reason);
  } catch {
    /* email is best-effort — never block check-out on it */
  }

  return { ok: true as const, session, day };
}

/**
 * Cumulative totals for a whole attendance day, summed across ALL of its sessions:
 *   work    = Σ (checkOut − checkIn)            [for the open session, up to `nowMs`]
 *   inside  = Σ in-session time inside the geofence
 *   outside = Σ in-session time outside  +  Σ away-gaps (prev checkOut → next checkIn)
 * The "away gap" is the time the employee was fully checked out between sessions.
 */
async function recomputeDayTotals(attendanceDayId: any, nowMs?: number) {
  // One query for the day's sessions and ONE for all of its pings (grouped in
  // memory) — avoids an N+1 of one ping query per session on this hot path.
  const [sessions, allPings] = await Promise.all([
    AttendanceSession.find({ attendanceDayId }).sort({ checkInAt: 1 }).lean(),
    LocationPing.find({ attendanceDayId })
      .select("sessionId capturedAt isInsideGeofence")
      .sort({ capturedAt: 1 })
      .lean(),
  ]);

  const pingsBySession = new Map<string, any[]>();
  for (const p of allPings) {
    const key = String(p.sessionId);
    const arr = pingsBySession.get(key);
    if (arr) arr.push(p);
    else pingsBySession.set(key, [p]);
  }

  // Pure aggregation (work/inside/outside/break/unaccounted) — see
  // attendance-logic.ts. The DB fetch lives here; the math is unit-tested there.
  return computeDayTotals(sessions, pingsBySession, nowMs ?? Date.now(), {
    maxIntervalMs: env.PING_TRUST_WINDOW_MS,
  });
}

/**
 * Live cumulative day totals (all sessions + away gaps) while a session is open,
 * computed up to "now" so the employee dashboard can show them ticking. Returns
 * null when there is no active session.
 */
export async function liveTotalsForActiveSession(employeeId: string) {
  const session = await AttendanceSession.findOne({
    employeeId: new Types.ObjectId(employeeId),
    status: { $in: ["active", "flagged"] },
  }).sort({ checkInAt: -1 });
  if (!session) return null;
  return recomputeDayTotals(session.attendanceDayId, Date.now());
}

/** The scheduled shift end (UTC) for a session's day, or null if not scheduled. */
async function getShiftEnd(session: any): Promise<Date | null> {
  const day = await AttendanceDay.findById(session.attendanceDayId).lean();
  if (!day) return null;
  const schedule = await EmployeeSchedule.findOne({
    employeeId: session.employeeId,
    workDate: day.workDate,
  }).lean();
  if (!schedule || !schedule.isWorkingDay || !schedule.expectedEndAt) return null;
  return new Date(schedule.expectedEndAt);
}

/**
 * Batched form of getShiftEnd for the cron sweep: resolves the scheduled shift
 * end for MANY sessions in two queries instead of two per session. Returns a map
 * keyed by session id; a missing/non-working/open-ended schedule maps to null,
 * exactly as getShiftEnd returns null for the same cases.
 */
async function getShiftEndsForSessions(sessions: any[]): Promise<Map<string, Date | null>> {
  const result = new Map<string, Date | null>(
    sessions.map((s) => [String(s._id), null])
  );
  if (sessions.length === 0) return result;

  const days = await AttendanceDay.find({
    _id: { $in: sessions.map((s) => s.attendanceDayId) },
  })
    .select("_id workDate")
    .lean();
  const workDateByDayId = new Map(days.map((d: any) => [String(d._id), d.workDate]));

  // Fetch by the two key components and then match exact (employeeId, workDate)
  // pairs in memory. This can over-fetch slightly versus an $or of exact pairs,
  // but it is one indexed query rather than one round-trip per session.
  const schedules = await EmployeeSchedule.find({
    employeeId: { $in: sessions.map((s) => s.employeeId) },
    workDate: { $in: Array.from(new Set(workDateByDayId.values())) },
  })
    .select("employeeId workDate isWorkingDay expectedEndAt")
    .lean();
  const scheduleByPair = new Map<string, any>(
    schedules.map((s: any) => [`${String(s.employeeId)}|${s.workDate}`, s])
  );

  for (const session of sessions) {
    const workDate = workDateByDayId.get(String(session.attendanceDayId));
    if (!workDate) continue; // no AttendanceDay -> null, same as getShiftEnd
    const schedule = scheduleByPair.get(`${String(session.employeeId)}|${workDate}`);
    if (!schedule || !schedule.isWorkingDay || !schedule.expectedEndAt) continue;
    result.set(String(session._id), new Date(schedule.expectedEndAt));
  }
  return result;
}

/** Close one session at its scheduled shift end, storing cumulative day totals. */
async function closeSessionAtShiftEnd(session: any, shiftEnd: Date) {
  const lastPing = await LocationPing.findOne({ sessionId: session._id })
    .sort({ capturedAt: -1 })
    .lean();
  const coords = (lastPing?.location?.coordinates ?? session.checkInLocation?.coordinates ?? [
    0, 0,
  ]) as [number, number];
  await finalizeSession({
    session,
    lat: coords[1],
    lng: coords[0],
    accuracyMeters: lastPing?.accuracyMeters,
    checkOutAt: shiftEnd,
    status: "auto_closed",
    reason: "auto_checkout_shift_ended",
  });
}

/**
 * Sweep all still-open sessions and auto check-out any whose scheduled shift end
 * has already passed. Used by the cron backstop (covers the case where the app
 * was killed and stopped sending pings). Returns how many were closed.
 */
export async function autoCloseEndedShifts(): Promise<number> {
  await connectDB();
  const sessions = await AttendanceSession.find({
    status: { $in: ["active", "flagged"] },
  }).sort({ checkInAt: 1 });

  // Resolve every session's shift end up front (2 queries total). Previously this
  // was 2 queries per session inside the loop, so a company with N open sessions
  // paid 2N sequential round-trips just to decide which ones to close.
  const shiftEnds = await getShiftEndsForSessions(sessions);

  let closed = 0;
  for (const session of sessions) {
    const shiftEnd = shiftEnds.get(String(session._id));
    if (shiftEnd && Date.now() > shiftEnd.getTime()) {
      // Closing stays sequential: each close recomputes day totals and writes,
      // and concurrent closes on the same day would race on those rollups.
      await closeSessionAtShiftEnd(session, shiftEnd);
      closed++;
    }
  }
  return closed;
}

/**
 * Enforce that check-in / check-out happen within the scheduled shift window.
 * Window = [shift start − grace, shift end]. If no schedule exists for the day,
 * there is no gate. A scheduled non-working day blocks check-in entirely.
 */
async function scheduleGate(
  employeeId: string,
  workDate: string,
  atMs: number = Date.now()
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const schedule = await EmployeeSchedule.findOne({
    employeeId: new Types.ObjectId(employeeId),
    workDate,
  }).lean();
  if (!schedule) return { ok: true };

  // Only the shift's grace is needed, and only for a working day with a window.
  let graceMinutes = 0;
  if (schedule.isWorkingDay && schedule.expectedStartAt && schedule.expectedEndAt) {
    const shift = await ShiftTemplate.findById(schedule.shiftTemplateId).lean();
    graceMinutes = shift?.graceMinutes ?? 0;
  }
  return evaluateScheduleGate(
    {
      isWorkingDay: schedule.isWorkingDay,
      expectedStartAtMs: schedule.expectedStartAt
        ? new Date(schedule.expectedStartAt).getTime()
        : null,
      expectedEndAtMs: schedule.expectedEndAt
        ? new Date(schedule.expectedEndAt).getTime()
        : null,
    },
    graceMinutes,
    atMs
  );
}

/**
 * Backward-compatible wrapper around the pure summarizeSessionPings (the siteId
 * argument is unused). Kept so existing callers/tests keep working.
 */
export function summarizePings(
  pings: any[],
  _siteId: string,
  endTimeMs?: number
): { totalInside: number; totalOutside: number; outsideVisitCount: number } {
  return summarizeSessionPings(pings, endTimeMs ?? Date.now());
}

export async function processPings(opts: {
  employeeId: string;
  companyId: string;
  pings: Array<{
    lat: number;
    lng: number;
    accuracyMeters?: number;
    isMockLocation?: boolean;
    deviceId?: string;
    appVersion?: string;
    appState?: string;
    networkType?: string;
    batteryPercentage?: number;
    capturedAt?: string;
  }>;
}) {
  await connectDB();
  const employeeId = new Types.ObjectId(opts.employeeId);
  const companyId = new Types.ObjectId(opts.companyId);

  const session = await AttendanceSession.findOne({
    employeeId,
    status: { $in: ["active", "flagged"] },
  }).sort({ checkInAt: -1 });
  if (!session) return { ok: false as const, reason: "no_active_session" };

  // Use the geofence SNAPSHOT taken at check-in, so an admin editing the site
  // (or reassigning the employee) mid-shift can't move the geofence under them.
  // Fall back to the live site for sessions created before snapshots existed.
  let siteLat: number;
  let siteLng: number;
  let siteRadius: number;
  if (session.geofence && session.geofence.lat != null) {
    siteLat = session.geofence.lat;
    siteLng = session.geofence.lng;
    siteRadius = session.geofence.radiusMeters;
  } else {
    const site = await WorkSite.findById(session.siteId).lean();
    if (!site) return { ok: false as const, reason: "no_site" };
    siteLng = site.location.coordinates[0];
    siteLat = site.location.coordinates[1];
    siteRadius = site.radiusMeters;
  }

  // Company timezone (cached) — used to evaluate the lunch-break window.
  const timezone = await getCompanyTimezone(opts.companyId);

  // End-of-shift auto check-out: if the scheduled shift end has already passed,
  // close the session at the shift-end time (storing totals) instead of tracking
  // further. The employee never has to press check-out at the end of the day.
  const shiftEnd = await getShiftEnd(session);
  if (shiftEnd && Date.now() > shiftEnd.getTime()) {
    await closeSessionAtShiftEnd(session, shiftEnd);
    return {
      ok: true as const,
      received: 0,
      autoCheckedOut: true,
      autoCheckoutAt: shiftEnd.toISOString(),
    };
  }

  // Determine previous "inside" state from last ping
  const lastPing = await LocationPing.findOne({ sessionId: session._id })
    .sort({ capturedAt: -1 })
    .lean();
  let currentlyInside = lastPing ? !!lastPing.isInsideGeofence : true;

  const sorted = [...opts.pings].sort(
    (a, b) =>
      new Date(a.capturedAt ?? Date.now()).getTime() -
      new Date(b.capturedAt ?? Date.now()).getTime()
  );

  // Gap-based auto check-out: if tracking went silent for longer than the
  // threshold (the employee closed the app / lost the foreground service), close
  // the session at the LAST ping we actually received. Work/outside time are then
  // computed up to that point, and the just-arrived ping is dropped — the employee
  // must check in again. This makes closing the app effectively end the session.
  if (env.PING_GAP_CHECKOUT_ENABLED && lastPing && sorted.length) {
    const lastPingMs = new Date(lastPing.capturedAt).getTime();
    const nextMs = sorted[0].capturedAt ? new Date(sorted[0].capturedAt).getTime() : Date.now();
    if (
      shouldGapCheckout({
        checkInMs: new Date(session.checkInAt).getTime(),
        lastPingMs,
        nextPingMs: nextMs,
        gapThresholdMs: env.PING_GAP_CHECKOUT_MINUTES * 60_000,
      })
    ) {
      await finalizeSession({
        session,
        lat: lastPing.location.coordinates[1],
        lng: lastPing.location.coordinates[0],
        accuracyMeters: lastPing.accuracyMeters,
        checkOutAt: new Date(lastPingMs),
        status: "auto_closed",
        reason: "auto_checkout_ping_gap",
      });
      return {
        ok: true as const,
        received: 0,
        autoCheckedOut: true,
        autoCheckoutAt: new Date(lastPingMs).toISOString(),
      };
    }
  }

  const flagging: any[] = [];
  let autoCheckedOut = false;
  let autoCheckoutAt: Date | null = null;

  for (const p of sorted) {
    const { inside, distance } = isInsideGeofence(
      { lat: p.lat, lng: p.lng },
      { lat: siteLat, lng: siteLng },
      siteRadius,
      p.accuracyMeters ?? 0
    );
    // Ignore unreliable readings: a ping whose reported GPS accuracy is worse than
    // the configured limit should NOT move the geofence state — otherwise junk
    // readings inflate "outside" time and cause false exits. Carry the last state.
    const effectiveInside = effectiveInsideState(
      inside,
      p.accuracyMeters,
      currentlyInside,
      env.MAX_PING_ACCURACY_METERS
    );
    const capturedAt = p.capturedAt ? new Date(p.capturedAt) : new Date();
    await LocationPing.create({
      attendanceDayId: session.attendanceDayId,
      sessionId: session._id,
      companyId,
      employeeId,
      siteId: session.siteId,
      capturedAt,
      location: { type: "Point", coordinates: [p.lng, p.lat] },
      accuracyMeters: p.accuracyMeters,
      distanceFromSiteMeters: distance,
      isInsideGeofence: effectiveInside,
      isMockLocation: p.isMockLocation ?? false,
      isGpsEnabled: true,
      batteryPercentage: p.batteryPercentage,
      networkType: (p.networkType as any) ?? "unknown",
      appState: (p.appState as any) ?? "unknown",
    });
    // Geofence event on transition
    if (effectiveInside !== currentlyInside) {
      await GeofenceEvent.create({
        attendanceDayId: session.attendanceDayId,
        sessionId: session._id,
        companyId,
        employeeId,
        siteId: session.siteId,
        eventType: effectiveInside ? "entered_site" : "exited_site",
        eventAt: capturedAt,
        location: { type: "Point", coordinates: [p.lng, p.lat] },
        accuracyMeters: p.accuracyMeters,
        distanceFromSiteMeters: distance,
      });
      if (effectiveInside) {
        // close any open outside log
        const openLog = await OutsideSiteLog.findOne({
          sessionId: session._id,
          returnedAt: null,
        })
          .sort({ exitedAt: -1 })
          .lean();
        if (openLog) {
          const durationSeconds = Math.max(
            0,
            Math.floor((capturedAt.getTime() - new Date(openLog.exitedAt).getTime()) / 1000)
          );
          await OutsideSiteLog.updateOne(
            { _id: openLog._id },
            { $set: { returnedAt: capturedAt, durationSeconds, status: "closed" } }
          );
        }
      } else {
        await OutsideSiteLog.create({
          attendanceDayId: session.attendanceDayId,
          sessionId: session._id,
          companyId,
          employeeId,
          siteId: session.siteId,
          exitedAt: capturedAt,
          exitLocation: { type: "Point", coordinates: [p.lng, p.lat] },
          distanceFromSiteMeters: distance,
          status: "open",
        });
      }
      currentlyInside = effectiveInside;
    }
  }

  // Run mock detection over the whole session
  const allPings = await LocationPing.find({ sessionId: session._id })
    .sort({ capturedAt: 1 })
    .lean();
  const pingLikes: PingLike[] = allPings.map((p: { location: { coordinates: [number, number] }; accuracyMeters: number; isMockLocation: boolean; capturedAt: Date }) => ({
    lat: p.location.coordinates[1],
    lng: p.location.coordinates[0],
    accuracyMeters: p.accuracyMeters,
    isMockLocation: p.isMockLocation,
    capturedAt: p.capturedAt,
  }));
  const flags = flagPings(pingLikes);
  if (flags.length) {
    const day = await AttendanceDay.findById(session.attendanceDayId);
    if (day) {
      day.isFlagged = true;
      const reasons = new Set(day.flagReasons || []);
      for (const f of flags) {
        for (const r of f.reasons) reasons.add(r);
      }
      day.flagReasons = Array.from(reasons);
      await day.save();
    }
  }

  // Auto check-out on SUSTAINED absence: the most recent N pings are ALL beyond
  // the geofence radius + buffer. Requiring several consecutive readings means a
  // single GPS-drift spike (employee actually sitting still) won't end the shift.
  // Suppressed during the lunch window (company timezone).
  if (env.AUTO_CHECKOUT_ENABLED && !autoCheckedOut) {
    const need = Math.max(1, env.AUTO_CHECKOUT_CONSECUTIVE_PINGS);
    const threshold = siteRadius + env.AUTO_CHECKOUT_BUFFER_METERS;
    const latest = allPings[allPings.length - 1];
    const tail = allPings.slice(-need);
    // Each of the last N pings must be a RELIABLE reading that is beyond the
    // buffer. An inaccurate reading breaks the streak so junk can't check anyone out.
    const sustainedAway = isSustainedAway(
      tail,
      need,
      threshold,
      env.MAX_PING_ACCURACY_METERS
    );
    if (latest && sustainedAway) {
      // Back-date the check-out to when they crossed the site boundary (the open
      // outside-site log), falling back to the latest ping.
      const openLog = await OutsideSiteLog.findOne({
        sessionId: session._id,
        returnedAt: null,
      })
        .sort({ exitedAt: -1 })
        .lean();
      const leftAt = openLog ? new Date(openLog.exitedAt) : new Date(latest.capturedAt);
      // Lunch only suppresses auto-checkout WHILE the current ping is inside the
      // lunch window. If the employee left during lunch but is still away after
      // it ends, we check them out back-dated to lunch-end — paid through lunch,
      // not for the afternoon they stayed absent.
      const lunchEndMs = zonedDateTimeToUtc(
        getWorkDateInTimezone(leftAt, timezone),
        env.AUTO_CHECKOUT_LUNCH_END,
        timezone
      ).getTime();
      const decision = resolveAutoCheckout({
        leftAtMs: leftAt.getTime(),
        lunchEnabled: env.AUTO_CHECKOUT_LUNCH_BREAK_ENABLED,
        currentInLunch: isWithinLocalTimeWindow(
          new Date(latest.capturedAt),
          timezone,
          env.AUTO_CHECKOUT_LUNCH_START,
          env.AUTO_CHECKOUT_LUNCH_END
        ),
        leftInLunch: isWithinLocalTimeWindow(
          leftAt,
          timezone,
          env.AUTO_CHECKOUT_LUNCH_START,
          env.AUTO_CHECKOUT_LUNCH_END
        ),
        lunchEndMs,
      });
      if (!decision.suppress) {
        const checkOutAt = new Date(decision.checkOutAtMs);
        await finalizeSession({
          session,
          lat: latest.location.coordinates[1],
          lng: latest.location.coordinates[0],
          accuracyMeters: latest.accuracyMeters,
          checkOutAt,
          status: "auto_closed",
          reason: "auto_checkout_left_site",
        });
        autoCheckedOut = true;
        autoCheckoutAt = checkOutAt;
      }
    }
  }

  // Keep the day's running (cumulative) work/inside/outside totals fresh so live
  // displays and in-progress reports reflect every session plus the away-gaps
  // (skip if we just auto-closed the session above).
  if (!autoCheckedOut) {
    const totals = await recomputeDayTotals(session.attendanceDayId, Date.now());
    await AttendanceDay.findByIdAndUpdate(session.attendanceDayId, {
      $set: {
        totalWorkSeconds: totals.totalWorkSeconds,
        totalInsideSeconds: totals.totalInsideSeconds,
        totalOutsideSeconds: totals.totalOutsideSeconds,
        totalBreakSeconds: totals.totalBreakSeconds,
        totalUnaccountedSeconds: totals.totalUnaccountedSeconds,
        outsideVisitCount: totals.outsideVisitCount,
        breakCount: totals.breakCount,
      },
    });
  }

  return {
    ok: true as const,
    received: sorted.length,
    autoCheckedOut,
    autoCheckoutAt: autoCheckoutAt ? autoCheckoutAt.toISOString() : null,
  };
}
