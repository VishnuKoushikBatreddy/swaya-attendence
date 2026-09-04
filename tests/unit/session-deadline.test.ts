/**
 * Every session must have a deadline.
 *
 * getShiftEnd used to return null whenever the roster was incomplete — a
 * schedule row with isWorkingDay true and no expectedEndAt passes the check-in
 * gate and then yields NO end time, so nothing could close the session. One ran
 * 11h41m in production before an unrelated geofence exit happened to end it.
 *
 * The cap is a backstop, not a policy: it only decides anything when the
 * schedule failed to.
 */
import { describe, it, expect } from "vitest";
import { resolveSessionDeadline } from "@/lib/attendance-logic";

const HOUR = 3_600_000;
const CHECK_IN = Date.parse("2026-09-04T04:30:00Z"); // 10:00 IST
const MAX = 16 * HOUR;

describe("resolveSessionDeadline", () => {
  it("uses the scheduled end when there is one", () => {
    const end = CHECK_IN + 7 * HOUR; // 17:00 IST
    expect(resolveSessionDeadline({ checkInMs: CHECK_IN, scheduledEndMs: end, maxSessionMs: MAX }))
      .toEqual({ deadlineMs: end, source: "schedule" });
  });

  it("falls back to the cap when the roster gives no end time", () => {
    // The exact hole behind the 11h41m session.
    const r = resolveSessionDeadline({ checkInMs: CHECK_IN, scheduledEndMs: null, maxSessionMs: MAX });
    expect(r.source).toBe("max_duration");
    expect(r.deadlineMs).toBe(CHECK_IN + MAX);
  });

  it("never returns a deadline beyond the cap", () => {
    // A schedule stretching past the cap is itself a roster error; honouring it
    // would reopen the same hole.
    const absurd = CHECK_IN + 40 * HOUR;
    const r = resolveSessionDeadline({ checkInMs: CHECK_IN, scheduledEndMs: absurd, maxSessionMs: MAX });
    expect(r.source).toBe("max_duration");
    expect(r.deadlineMs).toBe(CHECK_IN + MAX);
  });

  it("prefers the schedule when it lands exactly on the cap", () => {
    const end = CHECK_IN + MAX;
    expect(
      resolveSessionDeadline({ checkInMs: CHECK_IN, scheduledEndMs: end, maxSessionMs: MAX }).source
    ).toBe("schedule");
  });

  it("is always in the future relative to check-in", () => {
    for (const scheduledEndMs of [null, CHECK_IN + HOUR, CHECK_IN + 40 * HOUR]) {
      const r = resolveSessionDeadline({ checkInMs: CHECK_IN, scheduledEndMs, maxSessionMs: MAX });
      expect(r.deadlineMs).toBeGreaterThan(CHECK_IN);
    }
  });

  it("would have closed the 11h41m production session", () => {
    // Checked in 10:14:56 IST on 3 Sep with no usable end time; it stayed open
    // until 21:55. Under the cap it closes at 02:14 rather than never.
    const checkIn = Date.parse("2026-09-03T04:44:56Z");
    const actuallyClosed = Date.parse("2026-09-03T16:25:24Z"); // 21:55 IST
    const r = resolveSessionDeadline({ checkInMs: checkIn, scheduledEndMs: null, maxSessionMs: MAX });
    expect(r.deadlineMs).toBeLessThan(actuallyClosed + MAX);
    expect((r.deadlineMs - checkIn) / HOUR).toBe(16);
  });

  it("a shorter cap tightens the backstop", () => {
    const r = resolveSessionDeadline({
      checkInMs: CHECK_IN,
      scheduledEndMs: null,
      maxSessionMs: 10 * HOUR,
    });
    expect((r.deadlineMs - CHECK_IN) / HOUR).toBe(10);
  });
});
