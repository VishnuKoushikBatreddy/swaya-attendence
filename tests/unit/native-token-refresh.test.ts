/**
 * Native tokens must renew themselves before they expire.
 *
 * The tracking service has no session and cannot re-mint on its own, and the
 * only thing that used to refresh the token was opening the app. An employee who
 * did not open it for a month hit a 401 — which PingUploader treats as a
 * permanent rejection and DROPS the batch. Pings lost, nothing on screen to
 * explain it.
 *
 * The device talks to the server every few minutes anyway, so the server hands
 * back a replacement as expiry approaches.
 */
import { describe, it, expect } from "vitest";
import {
  mintNativeToken,
  verifyNativeToken,
  shouldRefreshNativeToken,
} from "@/lib/native-token";

const EMP = "6a96b7cbaeb610fdc0451206";
const CO = "6a82d4cec22c4c840f6cdc0c";
const DAY = 24 * 60 * 60 * 1000;

describe("shouldRefreshNativeToken", () => {
  it("leaves a freshly minted token alone", () => {
    const payload = verifyNativeToken(mintNativeToken(EMP, CO))!;
    expect(shouldRefreshNativeToken(payload)).toBe(false);
  });

  it("refreshes once inside the final week", () => {
    const payload = verifyNativeToken(mintNativeToken(EMP, CO, 3 * DAY))!;
    expect(shouldRefreshNativeToken(payload)).toBe(true);
  });

  it("refreshes a token that is about to lapse", () => {
    const payload = verifyNativeToken(mintNativeToken(EMP, CO, 60_000))!;
    expect(shouldRefreshNativeToken(payload)).toBe(true);
  });

  it("does not refresh with comfortably more than the window left", () => {
    const payload = verifyNativeToken(mintNativeToken(EMP, CO, 20 * DAY))!;
    expect(shouldRefreshNativeToken(payload)).toBe(false);
  });

  it("honours a custom window", () => {
    const payload = verifyNativeToken(mintNativeToken(EMP, CO, 10 * DAY))!;
    expect(shouldRefreshNativeToken(payload, Date.now(), 5 * DAY)).toBe(false);
    expect(shouldRefreshNativeToken(payload, Date.now(), 15 * DAY)).toBe(true);
  });

  it("the replacement is valid and carries the same identity", () => {
    // A refresh that changed who the token was for would silently reattribute
    // an employee's pings.
    const old = verifyNativeToken(mintNativeToken(EMP, CO, 3 * DAY))!;
    const replacement = verifyNativeToken(mintNativeToken(old.employeeId, old.companyId))!;

    expect(replacement.employeeId).toBe(EMP);
    expect(replacement.companyId).toBe(CO);
    expect(replacement.exp).toBeGreaterThan(old.exp);
    expect(shouldRefreshNativeToken(replacement)).toBe(false);
  });

  it("the window is longer than any plausible offline stretch", () => {
    // The device only receives a replacement when it manages to upload, so the
    // window has to outlast a long dead zone. A day would not be enough.
    const payload = verifyNativeToken(mintNativeToken(EMP, CO, 8 * DAY))!;
    expect(shouldRefreshNativeToken(payload)).toBe(false);
    const nearly = verifyNativeToken(mintNativeToken(EMP, CO, 6 * DAY))!;
    expect(shouldRefreshNativeToken(nearly)).toBe(true);
  });
});
