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
  endTimeMs: number
): { totalInside: number; totalOutside: number; outsideVisitCount: number } {
  let totalInside = 0;
  let totalOutside = 0;
  let outsideVisitCount = 0;
  let inOutsideRun = false;

  const cap = endTimeMs;
  for (let i = 0; i < pings.length; i++) {
    const p = pings[i];
    const next = pings[i + 1];
    const inside = !!p.isInsideGeofence;
    // Clamp EVERY interval's end to the session end (checkout / "now"), so pings
    // captured after the effective checkout don't add time and intervals can't be
    // double-counted against the away-gap.
    const rawEnd = next ? new Date(next.capturedAt).getTime() : cap;
    const tEnd = Math.min(rawEnd, cap);
    const dt = Math.max(0, Math.floor((tEnd - new Date(p.capturedAt).getTime()) / 1000));
    if (inside) {
      totalInside += dt;
      if (inOutsideRun) inOutsideRun = false;
    } else {
      totalOutside += dt;
      if (!inOutsideRun) {
        outsideVisitCount++;
        inOutsideRun = true;
      }
    }
  }
  return { totalInside, totalOutside, outsideVisitCount };
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
  nowMs: number
): {
  totalWorkSeconds: number;
  totalInsideSeconds: number;
  totalOutsideSeconds: number;
  outsideVisitCount: number;
} {
  let totalWorkSeconds = 0;
  let totalInsideSeconds = 0;
  let totalOutsideSeconds = 0;
  let outsideVisitCount = 0;
  let prevCheckOutMs: number | null = null;

  for (const s of sessions) {
    const startMs = new Date(s.checkInAt).getTime();
    const endMs = s.checkOutAt ? new Date(s.checkOutAt).getTime() : nowMs;
    totalWorkSeconds += Math.max(0, Math.floor((endMs - startMs) / 1000));

    const summ = summarizeSessionPings(pingsBySession.get(String(s._id)) || [], endMs);
    totalInsideSeconds += summ.totalInside;
    totalOutsideSeconds += summ.totalOutside;
    outsideVisitCount += summ.outsideVisitCount;

    // Time away between the previous check-out and this check-in counts as outside.
    if (prevCheckOutMs != null) {
      totalOutsideSeconds += Math.max(0, Math.floor((startMs - prevCheckOutMs) / 1000));
      outsideVisitCount += 1;
    }
    prevCheckOutMs = endMs;
  }

  return { totalWorkSeconds, totalInsideSeconds, totalOutsideSeconds, outsideVisitCount };
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

export function classifyOutsideForDay(opts: {
  totalOutsideSeconds: number;
  midDayCheckouts: number;
  flagThresholdSeconds?: number;
}): { flagExcessiveOutside: boolean; outsideCounts: boolean } {
  const threshold = opts.flagThresholdSeconds ?? 30 * 60;
  // No real departure -> outside time is jitter -> full day present, no flag.
  if (opts.midDayCheckouts <= 0) {
    return { flagExcessiveOutside: false, outsideCounts: false };
  }
  return {
    flagExcessiveOutside: opts.totalOutsideSeconds > threshold,
    outsideCounts: true,
  };
}
