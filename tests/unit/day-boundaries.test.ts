/**
 * AttendanceDay.firstCheckInAt / lastCheckOutAt must be a true MIN / MAX across
 * the day, not "whatever was written most recently".
 *
 * Sessions are not finalized in chronological order: a replayed geofence EXIT,
 * the cron sweep and a manual check-out can close sessions in any sequence, and
 * an offline check-in syncs later carrying an EARLIER capturedAt. Assigning
 * unconditionally let the day's summary times move backwards/forwards wrongly,
 * which is what the employee screen reads for "Check-in" and "Check-out".
 *
 * These tests cover the comparison rule itself, mirroring the logic applied in
 * attendance-service.ts.
 */
import { describe, it, expect } from "vitest";

/** Mirror of the rule in processCheckIn. */
function nextFirstCheckIn(existing: Date | null, incoming: Date): Date {
  const prev = existing ? existing.getTime() : Infinity;
  return incoming.getTime() < prev ? incoming : (existing as Date);
}

/** Mirror of the rule in finalizeSession. */
function nextLastCheckOut(existing: Date | null, incoming: Date): Date {
  const prev = existing ? existing.getTime() : 0;
  return incoming.getTime() >= prev ? incoming : (existing as Date);
}

const T = (hhmm: string) => new Date(`2026-08-17T${hhmm}:00.000Z`);

describe("firstCheckInAt — earliest wins", () => {
  it("takes the first check-in of the day", () => {
    expect(nextFirstCheckIn(null, T("09:00"))).toEqual(T("09:00"));
  });

  it("is not overwritten by a later check-in", () => {
    expect(nextFirstCheckIn(T("09:00"), T("14:00"))).toEqual(T("09:00"));
  });

  it("IS corrected by an offline check-in that syncs late with an earlier time", () => {
    // Queued at 08:30 offline, replayed after a 09:00 check-in already landed.
    expect(nextFirstCheckIn(T("09:00"), T("08:30"))).toEqual(T("08:30"));
  });
});

describe("lastCheckOutAt — latest wins", () => {
  it("takes the first check-out of the day", () => {
    expect(nextLastCheckOut(null, T("13:00"))).toEqual(T("13:00"));
  });

  it("advances for a later check-out", () => {
    expect(nextLastCheckOut(T("13:00"), T("18:00"))).toEqual(T("18:00"));
  });

  it("does NOT move backwards when an older session is finalized afterwards", () => {
    // The 18:00 close already landed; a replayed EXIT then closes an earlier
    // session at 11:36. Without the guard the day would report 11:36.
    expect(nextLastCheckOut(T("18:00"), T("11:36"))).toEqual(T("18:00"));
  });

  it("is stable when the same check-out is written twice", () => {
    expect(nextLastCheckOut(T("18:00"), T("18:00"))).toEqual(T("18:00"));
  });
});

describe("the pair as displayed", () => {
  it("keeps first-in / last-out across a multi-session day", () => {
    // 09:00–13:00, then 14:00–18:00, finalized out of order.
    let first: Date | null = null;
    let last: Date | null = null;

    first = nextFirstCheckIn(first, T("09:00"));
    first = nextFirstCheckIn(first, T("14:00"));

    last = nextLastCheckOut(last, T("18:00")); // second session closed first
    last = nextLastCheckOut(last, T("13:00")); // first session closed after

    expect(first).toEqual(T("09:00"));
    expect(last).toEqual(T("18:00"));
    expect(last!.getTime()).toBeGreaterThan(first!.getTime());
  });
});
