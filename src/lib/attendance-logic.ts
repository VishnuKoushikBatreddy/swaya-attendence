/**
 * Pure attendance-engine decision logic — NO database, NO Mongoose, NO env reads.
 *
 * Every function here is a deterministic transformation of already-loaded data.
 * `attendance-service.ts` does the I/O (fetch documents, write documents) and
 * delegates the decisions to these helpers, which keeps the rules unit-testable.
 *
 * IMPORTANT: changing a function here changes production behaviour. These were
 * extracted verbatim from attendance-service.ts to preserve the exact semantics
 * (Math.floor / Math.max clamping, inclusive/exclusive bounds, etc.).
 */

// ---------------------------------------------------------------------------
// Per-session ping summary: time inside vs outside the geofence + excursions.
// ---------------------------------------------------------------------------
export type SummaryPing = {
  capturedAt: Date | string | number;
  isInsideGeofence: boolean;
};

export function summarizeSessionPings(
  pings: SummaryPing[],
  endTimeMs: number,
  opts?: {
    /** Session check-in. Time before it is not part of this session. */
    startTimeMs?: number;
    /**
     * How long a single ping's state may be trusted forward. Beyond this the
     * time is UNACCOUNTED rather than assumed to continue.
     */
    maxIntervalMs?: number;
  }
): {
  totalInside: number;
  totalOutside: number;
  outsideVisitCount: number;
  offline: number;
} {
  // Accumulated in MILLISECONDS and floored once at the end. Flooring each
  // interval instead loses up to a second per ping, and since work is floored
  // only once per session, a day with 60 pings drifted ~60s out of balance —
  // invisible in tests built on whole-minute timestamps, obvious on real data.
  let insideMs = 0;
  let outsideMs = 0;
  let offlineMs = 0;
  let outsideVisitCount = 0;
  let inOutsideRun = false;

  const cap = endTimeMs;
  const floor = opts?.startTimeMs ?? Number.NEGATIVE_INFINITY;
  const maxInterval = opts?.maxIntervalMs ?? Number.POSITIVE_INFINITY;

  // The stretch between check-in and the FIRST ping. The loop below only walks
  // forward from each ping, so without this the head of the session is dropped
  // entirely — not credited AND not reported — and work no longer equals
  // inside + outside + offline. With no pings at all the whole session is the
  // head, which is why a session that never reported anything used to come back
  // all-zero instead of fully offline.
  //
  // A ping is trusted BACKWARD by the same window it is trusted forward: one at
  // 09:02 is fair evidence of where someone was at 09:00. Without that symmetry
  // every ordinary day would carry a sliver of offline time from the gap between
  // checking in and the first fix landing.
  if (Number.isFinite(floor)) {
    const firstMs = pings.length
      ? Math.min(new Date(pings[0].capturedAt).getTime(), cap)
      : cap;
    const headMs = Math.max(0, firstMs - floor);
    const backCredited = pings.length ? Math.min(headMs, maxInterval) : 0;
    offlineMs += headMs - backCredited;
    if (backCredited > 0) {
      if (pings[0].isInsideGeofence) {
        insideMs += backCredited;
      } else {
        outsideMs += backCredited;
        outsideVisitCount++;
        inOutsideRun = true;
      }
    }
  }

  for (let i = 0; i < pings.length; i++) {
    const p = pings[i];
    const next = pings[i + 1];
    const inside = !!p.isInsideGeofence;

    // Clamp the interval to the session on BOTH sides. The upper clamp stops a
    // ping captured after the effective check-out from adding time; the lower
    // clamp stops a ping captured BEFORE check-in from doing the same, which an
    // offline ping replayed with an earlier timestamp could otherwise do.
    const tStart = Math.max(new Date(p.capturedAt).getTime(), floor);
    const rawEnd = next ? new Date(next.capturedAt).getTime() : cap;
    const tEnd = Math.min(rawEnd, cap);
    const spanMs = Math.max(0, tEnd - tStart);

    // A ping is evidence of where someone was AT THAT MOMENT, not for however
    // long the next ping happens to take. Extrapolating the whole gap meant a
    // single check-in ping could credit an entire 9-hour shift as "inside" —
    // and with distance-triggered native pings, a stationary employee routinely
    // produces gaps of hours. Only the trusted window counts; the rest is
    // reported as offline so the numbers stay honest instead of invented.
    const credited = Math.min(spanMs, maxInterval);
    offlineMs += spanMs - credited;

    if (inside) {
      insideMs += credited;
      if (inOutsideRun) inOutsideRun = false;
    } else {
      outsideMs += credited;
      if (credited > 0 && !inOutsideRun) {
        outsideVisitCount++;
        inOutsideRun = true;
      }
    }
  }

  const totalInside = Math.floor(insideMs / 1000);
  const totalOutside = Math.floor(outsideMs / 1000);
  // Offline is the part of the session nothing vouches for, so derive it as the
  // remainder rather than a fourth independent sum. That makes
  // work = inside + outside + offline hold EXACTLY instead of approximately —
  // three separately-floored totals cannot be relied on to add up.
  const spanSeconds = Number.isFinite(floor)
    ? Math.max(0, Math.floor((cap - floor) / 1000))
    : null;
  const offline =
    spanSeconds != null
      ? Math.max(0, spanSeconds - totalInside - totalOutside)
      : Math.floor(offlineMs / 1000);

  return { totalInside, totalOutside, outsideVisitCount, offline };
}

// ---------------------------------------------------------------------------
// Cumulative day totals across ALL sessions of a day, including away-gaps.
//   work    = Σ (checkOut − checkIn)            [open session counts up to nowMs]
//   inside  = Σ in-session time inside the geofence
//   outside = Σ in-session time outside  +  Σ away-gaps (prev checkOut → next checkIn)
// ---------------------------------------------------------------------------
export type DaySession = {
  _id: unknown;
  checkInAt: Date | string | number;
  checkOutAt?: Date | string | number | null;
};

export function computeDayTotals(
  sessions: DaySession[],
  pingsBySession: Map<string, SummaryPing[]>,
  nowMs: number,
  opts?: { maxIntervalMs?: number }
): {
  totalWorkSeconds: number;
  totalInsideSeconds: number;
  totalOutsideSeconds: number;
  totalBreakSeconds: number;
  totalOfflineSeconds: number;
  outsideVisitCount: number;
  breakCount: number;
} {
  let totalWorkSeconds = 0;
  let totalInsideSeconds = 0;
  let totalOutsideSeconds = 0;
  let totalBreakSeconds = 0;
  let totalOfflineSeconds = 0;
  let outsideVisitCount = 0;
  let breakCount = 0;
  let prevCheckOutMs: number | null = null;

  for (const s of sessions) {
    const startMs = new Date(s.checkInAt).getTime();
    const endMs = s.checkOutAt ? new Date(s.checkOutAt).getTime() : nowMs;
    totalWorkSeconds += Math.max(0, Math.floor((endMs - startMs) / 1000));

    const summ = summarizeSessionPings(pingsBySession.get(String(s._id)) || [], endMs, {
      startTimeMs: startMs,
      maxIntervalMs: opts?.maxIntervalMs,
    });
    totalInsideSeconds += summ.totalInside;
    totalOutsideSeconds += summ.totalOutside;
    totalOfflineSeconds += summ.offline;
    outsideVisitCount += summ.outsideVisitCount;

    // Time between a check-out and the next check-in is a BREAK, reported on its
    // own. Folding it into "outside" conflated two different things: outside is
    // time on the clock but away from the fence, whereas a break is time off the
    // clock entirely. That made `outside` incomparable to `work` (it could
    // exceed it), and it flagged anyone who took a normal lunch, because a
    // 1-hour break sailed past the 30-minute excessive-outside threshold.
    if (prevCheckOutMs != null) {
      totalBreakSeconds += Math.max(0, Math.floor((startMs - prevCheckOutMs) / 1000));
      breakCount += 1;
    }
    prevCheckOutMs = endMs;
  }

  // Within a session: work = inside + outside + offline. Breaks sit outside
  // work entirely, so the day reconciles as work + break = elapsed on site.
  return {
    totalWorkSeconds,
    totalInsideSeconds,
    totalOutsideSeconds,
    totalBreakSeconds,
    totalOfflineSeconds,
    outsideVisitCount,
    breakCount,
  };
}

// ---------------------------------------------------------------------------
// GPS reliability / drift protection.
// ---------------------------------------------------------------------------

/** A ping is reliable when it has no accuracy reading or one within the limit. */
export function isReliablePing(
  accuracyMeters: number | null | undefined,
  maxAccuracyMeters: number
): boolean {
  return accuracyMeters == null || accuracyMeters <= maxAccuracyMeters;
}

/**
 * The geofence state to record for a ping. An UNRELIABLE reading must not move
 * the state — it carries the previous one forward, so junk GPS can't inflate
 * "outside" time or cause a false exit.
 */
export function effectiveInsideState(
  reportedInside: boolean,
  accuracyMeters: number | null | undefined,
  prevInside: boolean,
  maxAccuracyMeters: number
): boolean {
  return isReliablePing(accuracyMeters, maxAccuracyMeters) ? reportedInside : prevInside;
}

/**
 * Sustained-absence auto-checkout trigger: the most recent `need` pings must ALL
 * be RELIABLE readings beyond `threshold` (radius + buffer). An inaccurate reading
 * breaks the streak, so a single GPS-drift spike never ends the shift.
 */
export type AwayPing = {
  accuracyMeters?: number | null;
  distanceFromSiteMeters?: number | null;
};

export function isSustainedAway(
  tail: AwayPing[],
  need: number,
  threshold: number,
  maxAccuracyMeters: number
): boolean {
  if (tail.length < need) return false;
  return tail.every(
    (pp) =>
      isReliablePing(pp.accuracyMeters, maxAccuracyMeters) &&
      (pp.distanceFromSiteMeters ?? 0) > threshold
  );
}

// ---------------------------------------------------------------------------
// Scheduled-hours gate + lateness.
// ---------------------------------------------------------------------------
export type GateSchedule = {
  isWorkingDay: boolean;
  expectedStartAtMs?: number | null;
  expectedEndAtMs?: number | null;
} | null;

export const GATE_DAY_OFF_REASON =
  "Today is a scheduled day off — no check-in required.";
export const GATE_OUT_OF_HOURS_REASON =
  "You can only check in or out during your scheduled shift hours.";

/**
 * Enforce that check-in/out happens within [start − grace, end]. No schedule =>
 * no gate. A scheduled non-working day blocks the action entirely.
 */
export function evaluateScheduleGate(
  schedule: GateSchedule,
  graceMinutes: number,
  atMs: number
): { ok: true } | { ok: false; reason: string } {
  if (!schedule) return { ok: true };
  if (!schedule.isWorkingDay) return { ok: false, reason: GATE_DAY_OFF_REASON };
  if (schedule.expectedStartAtMs != null && schedule.expectedEndAtMs != null) {
    const graceMs = graceMinutes * 60_000;
    const start = schedule.expectedStartAtMs - graceMs;
    const end = schedule.expectedEndAtMs;
    if (atMs < start || atMs > end) {
      return { ok: false, reason: GATE_OUT_OF_HOURS_REASON };
    }
  }
  return { ok: true };
}

/** Late once the employee is more than `graceMinutes` past the shift start. */
export function evaluateLateness(
  expectedStartAtMs: number | null | undefined,
  atMs: number,
  graceMinutes: number
): { status: "present" | "late"; lateByMinutes: number } {
  if (expectedStartAtMs == null) return { status: "present", lateByMinutes: 0 };
  const lateMs = atMs - expectedStartAtMs;
  if (lateMs > graceMinutes * 60_000) {
    return { status: "late", lateByMinutes: Math.floor(lateMs / 60_000) };
  }
  return { status: "present", lateByMinutes: 0 };
}

// ---------------------------------------------------------------------------
// Time helpers.
// ---------------------------------------------------------------------------

/** Never let a back-dated check-out land before its check-in. */
export function clampCheckOut(checkInMs: number, checkOutMs: number): number {
  return checkOutMs < checkInMs ? checkInMs : checkOutMs;
}

/**
 * Upper-bound a client-supplied event time at "now".
 *
 * capturedAt comes from the device, and evaluateEventFreshness deliberately
 * tolerates a few minutes of clock skew so a slightly-fast phone isn't rejected
 * outright. That tolerance must not become free work time: a future-dated event
 * would otherwise extend a session past the present. Times in the past are left
 * untouched — back-dating is the whole point of the retry queue.
 */
export function clampEventTimeToNow(capturedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(capturedAtMs)) return nowMs;
  return capturedAtMs > nowMs ? nowMs : capturedAtMs;
}

/** Resolve a shift end: if end is at/before start it's an overnight shift (+1 day). */
export function resolveShiftEnd(startMs: number, endMs: number): number {
  return endMs <= startMs ? endMs + 86_400_000 : endMs;
}

/**
 * Map an internal auto-checkout `reason` to the audit-ledger `source` label
 * (used by the AttendanceEvent log). No reason = a manual check-out.
 */
export function deriveCheckoutSource(
  reason: string | undefined | null
):
  | "manual"
  | "geofence_exit"
  | "auto_sustained_absence"
  | "auto_shift_end"
  | "auto_ping_gap" {
  switch (reason) {
    case "auto_checkout_geofence_exit":
      return "geofence_exit";
    case "auto_checkout_left_site":
      return "auto_sustained_absence";
    case "auto_checkout_shift_ended":
      return "auto_shift_end";
    case "auto_checkout_ping_gap":
      return "auto_ping_gap";
    default:
      return "manual";
  }
}

/**
 * True when the silence between the last received ping and the next one exceeds
 * the gap threshold — i.e. tracking stopped (app closed / service killed) long
 * enough that we should auto-check-out the employee at the last known ping.
 */
export function isPingGapCheckout(
  lastPingMs: number,
  nextPingMs: number,
  gapThresholdMs: number
): boolean {
  return nextPingMs - lastPingMs > gapThresholdMs;
}

/**
 * Whether a ping gap should actually end the session.
 *
 * The gap rule closes at the LAST ping, i.e. the last moment we can prove the
 * employee was present. That is sound — unless the only ping on record is the
 * one written at check-in, in which case "the last proven moment" IS the
 * check-in instant and closing there produces a ZERO-LENGTH session: check-in
 * and check-out identical, the whole shift erased.
 *
 * That is reachable in normal use. The native watcher is distance-triggered, so
 * an employee sitting at a desk emits no pings at all; when they finally move,
 * the gap fires and silently ends a shift they never left.
 *
 * With no tracking data beyond check-in there is nothing to close *to*, so the
 * gap rule stands down and the session is left to the mechanisms that do have
 * evidence: a geofence EXIT, sustained absence, the scheduled shift end, or a
 * manual check-out.
 */
export function shouldGapCheckout(opts: {
  checkInMs: number;
  lastPingMs: number;
  nextPingMs: number;
  gapThresholdMs: number;
}): boolean {
  if (!isPingGapCheckout(opts.lastPingMs, opts.nextPingMs, opts.gapThresholdMs)) {
    return false;
  }
  // Only close when there is at least one ping AFTER check-in to close at.
  return opts.lastPingMs > opts.checkInMs;
}

/**
 * Decide whether a day's "outside" time should count against the employee.
 *
 * Outside minutes only matter when the employee actually CHECKED OUT and left the
 * site during the day. `midDayCheckouts` = (number of the day's sessions − 1): a
 * single continuous session is 0 — they never left and came back, so any outside
 * time is GPS jitter near the geofence boundary, not a real departure. In that
 * case the day stays a FULL PRESENT day and is not flagged for outside time.
 */
/**
 * Lunch-aware auto-checkout decision.
 *
 * The lunch break only suppresses auto-checkout WHILE the current ping is inside
 * the lunch window — not because the employee's exit happened to start during
 * lunch. So:
 *  - Currently inside the lunch window  -> suppress (they may just be at lunch).
 *  - Past lunch and still away:
 *      • left DURING lunch  -> check out at lunch-end (paid through lunch only,
 *        not for the afternoon they stayed absent).
 *      • left OUTSIDE lunch -> check out at the actual exit time.
 * All times are epoch ms; the caller resolves lunch-window membership and the
 * lunch-end instant in the company timezone.
 */
export function resolveAutoCheckout(opts: {
  leftAtMs: number;
  lunchEnabled: boolean;
  currentInLunch: boolean;
  leftInLunch: boolean;
  lunchEndMs: number;
}): { suppress: boolean; checkOutAtMs: number } {
  if (opts.lunchEnabled && opts.currentInLunch) {
    return { suppress: true, checkOutAtMs: opts.leftAtMs };
  }
  // Past the lunch window. If the exit began during lunch, clamp the check-out to
  // lunch-end so the employee is paid through lunch but not beyond it.
  const checkOutAtMs =
    opts.lunchEnabled && opts.leftInLunch
      ? Math.max(opts.leftAtMs, opts.lunchEndMs)
      : opts.leftAtMs;
  return { suppress: false, checkOutAtMs };
}

// ---------------------------------------------------------------------------
// Client-supplied timestamp validation (native geofence events).
// ---------------------------------------------------------------------------

export const EVENT_STALE_REASON = "Event is too old to apply";
export const EVENT_FUTURE_REASON = "Event timestamp is in the future";
export const EVENT_INVALID_REASON = "Event timestamp is not a valid date";

/**
 * Decide whether a client-supplied `capturedAt` may be trusted as the effective
 * time of an event.
 *
 * The native geofence receiver retries failed uploads, so an event legitimately
 * arrives long after it happened and MUST be applied at its original time — that
 * is the whole point of the queue. But an unbounded window is dangerous: these
 * events are authenticated by a long-lived native token rather than a session
 * cookie, and a stale or forged timestamp would silently rewrite a finished day.
 *
 * So: accept anything within `maxAgeMs` of now, reject beyond it, and reject
 * future timestamps outside a small tolerance for device clock skew.
 * Rejections are permanent (the caller should DROP, not retry) — a stale event
 * only gets staler.
 */
export function evaluateEventFreshness(
  capturedAtMs: number,
  nowMs: number,
  maxAgeMs: number,
  maxSkewMs: number
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(capturedAtMs)) {
    return { ok: false, reason: EVENT_INVALID_REASON };
  }
  if (capturedAtMs - nowMs > maxSkewMs) {
    return { ok: false, reason: EVENT_FUTURE_REASON };
  }
  if (nowMs - capturedAtMs > maxAgeMs) {
    return { ok: false, reason: EVENT_STALE_REASON };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tracking window: when may the device send location at all?
// ---------------------------------------------------------------------------

/**
 * Whether location tracking should be running right now.
 *
 * Tracking used to run for as long as a session was open, which is not the same
 * as "during the shift": a session that outlives its shift (nothing has closed
 * it yet) kept the GPS awake for hours afterwards, costing battery and
 * recording positions nobody asked for. Location is only collected inside the
 * scheduled window now.
 *
 * The same grace period as check-in applies at the start, so someone who checks
 * in a few minutes early is tracked from that moment rather than sitting
 * untracked until the hour turns.
 *
 * With NO schedule there is no window to enforce, and check-in itself is
 * ungated in that case — so tracking follows the session, exactly as before.
 * Restricting it would mean unscheduled work produced no location data at all.
 */
export function isWithinTrackingWindow(opts: {
  scheduleStartMs: number | null;
  scheduleEndMs: number | null;
  graceMinutes: number;
  nowMs: number;
}): boolean {
  if (opts.scheduleStartMs == null || opts.scheduleEndMs == null) return true;
  const start = opts.scheduleStartMs - opts.graceMinutes * 60_000;
  return opts.nowMs >= start && opts.nowMs <= opts.scheduleEndMs;
}

// ---------------------------------------------------------------------------
// Live connectivity: is the phone still reporting?
// ---------------------------------------------------------------------------

export type Connectivity = "live" | "stale" | "offline";

/**
 * How current an employee's position is.
 *
 * A checked-in session tells you a session is OPEN, not that the phone is still
 * talking to us. Showing "checked in" identically whether the last ping arrived
 * 30 seconds or 4 hours ago is misleading — a dead phone looked exactly like
 * someone actively working. This separates the two.
 *
 *   live    — reported within a couple of ping intervals; the position is current
 *   stale   — overdue, but not yet long enough to call it offline
 *   offline — silent past the threshold, or never reported at all
 *
 * Thresholds derive from the configured ping interval so this stays correct if
 * the cadence changes, rather than hard-coding minutes.
 */
export function deriveConnectivity(
  lastSeenAtMs: number | null,
  nowMs: number,
  pingIntervalMs: number,
  offlineAfterMs: number
): Connectivity {
  if (lastSeenAtMs == null || !Number.isFinite(lastSeenAtMs)) return "offline";
  const age = nowMs - lastSeenAtMs;
  // A clock slightly ahead should read as current, not as a negative age bug.
  if (age <= 0) return "live";
  if (age >= offlineAfterMs) return "offline";
  // Two intervals tolerates one dropped ping without crying wolf.
  return age <= pingIntervalMs * 2 ? "live" : "stale";
}

// ---------------------------------------------------------------------------
// Auto check-in eligibility (client-side gate before spending a GPS fix).
// ---------------------------------------------------------------------------

export const AUTO_CHECKIN_REASONS = {
  DISABLED: "disabled",
  ALREADY_CHECKED_IN: "already_checked_in",
  NOT_REQUIRED: "not_required",
  NO_SITE: "no_site",
  NO_SCHEDULE: "no_schedule",
  OUTSIDE_HOURS: "outside_hours",
  MANUAL_CHECKOUT: "manual_checkout",
} as const;

/**
 * Whether the app should try to check this employee in automatically.
 *
 * This answers "should we even look at the GPS", not "are they inside" — the
 * caller does the distance test, and the server re-applies its own schedule gate
 * regardless. Keeping it pure means the rules below are unit-tested rather than
 * buried in a React effect.
 *
 * Two conditions are load-bearing:
 *
 * NO_SCHEDULE — without expectedStartAt/expectedEndAt there is no defined shift
 * window. The server's gate treats "no schedule" as "no restriction", so
 * auto-checking-in would mark someone present for merely walking past the site
 * at any hour. Automatic check-in requires an explicit window; manual check-in
 * is unaffected.
 *
 * MANUAL_CHECKOUT — if the employee checked themselves out, they meant it.
 * Re-checking them in while they are still on site would make leaving early
 * impossible. An AUTOMATIC close (geofence exit, sustained absence, shift end,
 * ping gap) does not suppress: returning to site after one of those should check
 * them back in, which is the whole point.
 */
export function evaluateAutoCheckIn(opts: {
  enabled: boolean;
  isCheckedIn: boolean;
  noCheckInNeeded: boolean;
  hasSite: boolean;
  scheduleStartMs: number | null;
  scheduleEndMs: number | null;
  graceMinutes: number;
  /** Status of the most recent session today: "completed" means manual. */
  lastSessionStatus: string | null;
  nowMs: number;
}): { ok: true } | { ok: false; reason: string } {
  const R = AUTO_CHECKIN_REASONS;
  if (!opts.enabled) return { ok: false, reason: R.DISABLED };
  if (opts.isCheckedIn) return { ok: false, reason: R.ALREADY_CHECKED_IN };
  if (opts.noCheckInNeeded) return { ok: false, reason: R.NOT_REQUIRED };
  if (!opts.hasSite) return { ok: false, reason: R.NO_SITE };
  if (opts.lastSessionStatus === "completed") {
    return { ok: false, reason: R.MANUAL_CHECKOUT };
  }
  if (opts.scheduleStartMs == null || opts.scheduleEndMs == null) {
    return { ok: false, reason: R.NO_SCHEDULE };
  }
  // Same window the server enforces in evaluateScheduleGate, so the client never
  // fires a request the server is going to reject.
  const start = opts.scheduleStartMs - opts.graceMinutes * 60_000;
  if (opts.nowMs < start || opts.nowMs > opts.scheduleEndMs) {
    return { ok: false, reason: R.OUTSIDE_HOURS };
  }
  return { ok: true };
}

/**
 * The day's status, derived fresh from its totals.
 *
 * Previously this was applied as two mutations:
 *
 *   if (status === "pending") status = "present";
 *   if (work < 4h && status === "present") status = "half_day";
 *
 * which had two failure modes. Once a day became "half_day" it could never
 * become "present" again, because the second test required "present" — so an
 * employee who worked 3 hours, then returned and worked 3 more, stayed
 * half_day at 6 hours. And a "late" day never qualified for half_day at all,
 * since it matched neither branch: two hours' work after a late arrival was
 * recorded as a full late day.
 *
 * Deriving the status instead of mutating it makes it idempotent — recomputing
 * after every session yields the same answer for the same totals.
 *
 * Precedence: a genuinely short day is half_day even if it also started late;
 * the lateness is not lost, it stays on the day as lateByMinutes.
 * absent is set elsewhere and is never overwritten here.
 */
export function resolveDayStatus(opts: {
  currentStatus: string | null | undefined;
  totalWorkSeconds: number;
  lateByMinutes: number;
  halfDayThresholdSeconds?: number;
}): string {
  const threshold = opts.halfDayThresholdSeconds ?? 4 * 3600;
  // Absence is decided elsewhere and must not be overwritten here.
  if (opts.currentStatus === "absent") return "absent";
  if (opts.totalWorkSeconds < threshold) return "half_day";
  return opts.lateByMinutes > 0 ? "late" : "present";
}

export function classifyOutsideForDay(opts: {
  totalOutsideSeconds: number;
  flagThresholdSeconds?: number;
}): { flagExcessiveOutside: boolean; outsideCounts: boolean } {
  const threshold = opts.flagThresholdSeconds ?? 30 * 60;
  // Outside time counts regardless of how many times the employee checked out.
  //
  // This used to be ignored entirely unless there had been a mid-day check-out,
  // on the theory that outside time in one continuous session was boundary
  // jitter. That inverted the incentive: someone who left for four hours WITHOUT
  // checking out kept the full day unflagged, while the same absence taken
  // honestly — checking out and back in — lost the hours and got flagged.
  //
  // Jitter is already handled upstream and does not need this exemption: a
  // reading worse than MAX_PING_ACCURACY_METERS cannot change the inside/outside
  // state at all (see effectiveInsideState), and the threshold below tolerates
  // genuine boundary noise.
  return {
    flagExcessiveOutside: opts.totalOutsideSeconds > threshold,
    outsideCounts: true,
  };
}

/**
 * Whether a day rests on too little evidence to be trusted.
 *
 * Offline time is in-session time no ping vouches for: the phone was off, out of
 * signal, denied location, or the app was killed by the OS. It is NOT proof of
 * absence — the employee may well have been at their desk the whole time — so it
 * does not reduce totalWorkSeconds, which stays the elapsed session.
 *
 * But without a flag, a phone that dies at noon produces a full 9-hour day that
 * is indistinguishable in reports from one tracked end to end. That is the same
 * inverted incentive classifyOutsideForDay exists to close: the least evidence
 * gave the cleanest record.
 *
 * Two conditions, both required:
 *  - a SHARE of the session (default 25%), so the threshold scales with a 2-hour
 *    shift and a 10-hour one instead of flagging every short day; and
 *  - an absolute FLOOR (default 15 minutes, one OFFLINE_AFTER_MS), so a single
 *    tunnel or lift ride on a brief shift is not treated as a missing day.
 */
export function classifyOfflineForDay(opts: {
  totalOfflineSeconds: number;
  totalWorkSeconds: number;
  flagRatio?: number;
  flagFloorSeconds?: number;
}): { flagExcessiveOffline: boolean; offlineRatio: number } {
  const ratio = opts.flagRatio ?? 0.25;
  const floor = opts.flagFloorSeconds ?? 15 * 60;
  const offlineRatio =
    opts.totalWorkSeconds > 0 ? opts.totalOfflineSeconds / opts.totalWorkSeconds : 0;
  return {
    flagExcessiveOffline:
      opts.totalOfflineSeconds > floor && offlineRatio > ratio,
    offlineRatio,
  };
}

// ---------------------------------------------------------------------------
// Day flags vs audit markers.
//
// `flagReasons` holds two different kinds of string, and conflating them broke
// isFlagged in both directions:
//
//  - REAL FLAGS mean something is wrong and a human should look.
//  - MARKERS are audit breadcrumbs: how a check-in or check-out happened. An
//    automatic check-out at the end of a shift is completely normal.
//
// isFlagged used to be cleared only when flagReasons was EMPTY, so a single
// benign marker pinned a day as flagged forever, long after the real reason had
// been removed. Deriving it from the real flags alone fixes that, and makes the
// value impossible to contradict: it is always a function of the reasons list.
// ---------------------------------------------------------------------------

/** Reasons that genuinely warrant attention. */
export const REAL_FLAG_REASONS = new Set([
  "excessive_outside_time",
  "excessive_offline_time",
  "mock_location_at_check_in",
  "mock_location_detected",
  "client_flagged_mock",
  "impossible_speed",
  "large_teleport",
  "low_accuracy",
]);

/** Breadcrumbs describing HOW something happened. Never a reason to flag. */
export const AUDIT_MARKER_REASONS = new Set([
  "geofence_check_in",
  "auto_checkout_geofence_exit",
  "auto_checkout_left_site",
  "auto_checkout_ping_gap",
  "auto_checkout_shift_ended",
]);

/**
 * Whether a reason string is a real flag.
 *
 * Unknown strings count as flags deliberately: a reason nobody classified is
 * more safely surfaced to an admin than silently ignored. The paired test
 * asserts every reason the codebase actually emits is in one of the two sets,
 * so this fallback only ever applies to something genuinely new.
 */
export function isRealFlagReason(reason: string): boolean {
  return !AUDIT_MARKER_REASONS.has(reason);
}

/** isFlagged, derived from the reasons list so the two can never disagree. */
export function deriveIsFlagged(reasons: Iterable<string> | null | undefined): boolean {
  if (!reasons) return false;
  for (const r of reasons) {
    if (isRealFlagReason(r)) return true;
  }
  return false;
}
