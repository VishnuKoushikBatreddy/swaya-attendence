/**
 * Stateless tokens for NATIVE uploads (the OS geofence receiver runs without the
 * WebView, so it can't use the NextAuth session cookie). A token embeds the
 * employee + company and is HMAC-signed with NEXTAUTH_SECRET — no DB lookup to
 * verify. The employee is still re-checked for `isActive` at the endpoint.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";

export type NativeTokenPayload = {
  employeeId: string;
  companyId: string;
  exp: number; // epoch ms
};

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(body: string): string {
  return createHmac("sha256", env.NEXTAUTH_SECRET).update(body).digest("base64url");
}

export function mintNativeToken(
  employeeId: string,
  companyId: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const payload: NativeTokenPayload = {
    employeeId,
    companyId,
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyNativeToken(token: string | null | undefined): NativeTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Constant-time signature comparison.
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as NativeTokenPayload;
    if (
      !payload ||
      typeof payload.employeeId !== "string" ||
      typeof payload.companyId !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Whether a token is close enough to expiry that it should be replaced.
 *
 * The native service has no session and cannot re-mint on its own, and the only
 * thing that used to refresh the token was opening the app. An employee who did
 * not open it for a month hit a 401, which the uploader treats as permanent and
 * drops the batch — pings lost, with nothing on screen to say why.
 *
 * Since the device talks to the server every few minutes anyway, a token past
 * this point is simply swapped on the next upload. The window is generous
 * because it only has to be longer than the longest plausible offline stretch.
 */
export function shouldRefreshNativeToken(
  payload: NativeTokenPayload,
  nowMs: number = Date.now(),
  refreshWithinMs: number = 7 * 24 * 60 * 60 * 1000
): boolean {
  return payload.exp - nowMs < refreshWithinMs;
}
