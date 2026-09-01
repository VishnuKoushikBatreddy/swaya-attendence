/**
 * isFlagged is DERIVED from flagReasons, never assigned on its own.
 *
 * The array mixes two kinds of string — real flags and benign audit markers —
 * and treating them alike broke isFlagged in both directions: a day that had
 * ever auto-closed could never be un-flagged, and a second check-in wiped a
 * flag that was still justified.
 */
import { describe, it, expect } from "vitest";
import {
  REAL_FLAG_REASONS,
  AUDIT_MARKER_REASONS,
  isRealFlagReason,
  deriveIsFlagged,
} from "@/lib/attendance-logic";

describe("reason classification", () => {
  it("treats every audit marker as NOT a flag", () => {
    for (const marker of AUDIT_MARKER_REASONS) {
      expect(isRealFlagReason(marker), `${marker} must not flag a day`).toBe(false);
    }
  });

  it("treats every real flag as a flag", () => {
    for (const flag of REAL_FLAG_REASONS) {
      expect(isRealFlagReason(flag), `${flag} must flag a day`).toBe(true);
    }
  });

  it("keeps the two sets disjoint", () => {
    for (const r of REAL_FLAG_REASONS) {
      expect(AUDIT_MARKER_REASONS.has(r), `${r} is in both sets`).toBe(false);
    }
  });

  it("classifies an unknown reason as a flag, not silently ignored", () => {
    // Safer to surface something nobody classified than to hide it.
    expect(isRealFlagReason("some_future_reason")).toBe(true);
  });
});

describe("deriveIsFlagged", () => {
  it("is false for no reasons", () => {
    expect(deriveIsFlagged([])).toBe(false);
    expect(deriveIsFlagged(null)).toBe(false);
    expect(deriveIsFlagged(undefined)).toBe(false);
  });

  it("is false when only audit markers are present", () => {
    // The exact case that used to pin a day as flagged forever: every normal
    // shift ends with an automatic close.
    expect(deriveIsFlagged(["auto_checkout_shift_ended"])).toBe(false);
    expect(
      deriveIsFlagged(["geofence_check_in", "auto_checkout_ping_gap", "auto_checkout_left_site"])
    ).toBe(false);
  });

  it("is true when a real flag is present", () => {
    expect(deriveIsFlagged(["excessive_offline_time"])).toBe(true);
    expect(deriveIsFlagged(["excessive_outside_time"])).toBe(true);
    expect(deriveIsFlagged(["mock_location_at_check_in"])).toBe(true);
  });

  it("is true when a real flag is buried among markers", () => {
    expect(
      deriveIsFlagged([
        "geofence_check_in",
        "auto_checkout_shift_ended",
        "excessive_offline_time",
        "auto_checkout_ping_gap",
      ])
    ).toBe(true);
  });

  it("accepts a Set as well as an array", () => {
    expect(deriveIsFlagged(new Set(["auto_checkout_shift_ended"]))).toBe(false);
    expect(deriveIsFlagged(new Set(["impossible_speed"]))).toBe(true);
  });

  it("is a pure function of the reasons — same input, same answer", () => {
    const reasons = ["geofence_check_in", "excessive_outside_time"];
    expect(deriveIsFlagged(reasons)).toBe(deriveIsFlagged(reasons));
  });
});

describe("every reason the codebase emits is classified", () => {
  // Guards the fallback in isRealFlagReason: an unknown string flags the day,
  // which is safe but noisy. If a new reason is introduced it must be put in one
  // of the two sets deliberately, and this is what forces that.
  const EMITTED = [
    // attendance-service.ts
    "excessive_outside_time",
    "excessive_offline_time",
    "mock_location_at_check_in",
    "geofence_check_in",
    "auto_checkout_geofence_exit",
    "auto_checkout_left_site",
    "auto_checkout_ping_gap",
    "auto_checkout_shift_ended",
    // attendance.ts (flagPings)
    "client_flagged_mock",
    "low_accuracy",
    "large_teleport",
    "impossible_speed",
  ];

  it.each(EMITTED)("%s is in exactly one set", (reason) => {
    const inFlags = REAL_FLAG_REASONS.has(reason);
    const inMarkers = AUDIT_MARKER_REASONS.has(reason);
    expect(inFlags || inMarkers, `${reason} is unclassified`).toBe(true);
    expect(inFlags && inMarkers).toBe(false);
  });
});
