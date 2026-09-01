/**
 * Environment variable validation and defaults.
 * Loads once at boot, exposes a typed `env` object.
 * Falls back gracefully when SMTP creds are absent (console transport).
 */
import { randomBytes } from "crypto";

const DEFAULTS = {
  MONGODB_DB_NAME: "attendance",
  NEXTAUTH_URL: "http://localhost:3000",
  DEFAULT_TIMEZONE: "Asia/Kolkata",
  PING_INTERVAL_MS: 300_000, // 5 minutes
  MAX_PING_ACCURACY_METERS: 100,
  MOCK_LOCATION_SPEED_KMH: 200,
  AUTO_CHECKOUT_BUFFER_METERS: 50, // auto check-out once this far beyond the geofence radius
  EMAIL_FROM: "Geo Attendance <noreply@geo-attendance.local>",
} as const;

function readSecret(): string {
  const fromEnv = process.env.NEXTAUTH_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // In dev, fall back to a process-lifetime secret (with a loud warning).
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXTAUTH_SECRET must be set in production (>=16 chars).");
  }
  if (!globalThis.__DEV_NEXTAUTH_SECRET) {
    globalThis.__DEV_NEXTAUTH_SECRET = randomBytes(32).toString("hex");
    // eslint-disable-next-line no-console
    console.warn(
      "[env] NEXTAUTH_SECRET not set — generated an ephemeral one. Set it in .env.local for stable sessions."
    );
  }
  return globalThis.__DEV_NEXTAUTH_SECRET;
}

declare global {
  // eslint-disable-next-line no-var
  var __DEV_NEXTAUTH_SECRET: string | undefined;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  return v === "true" || v === "1" || v.toLowerCase() === "yes";
}

export const env = {
  MONGODB_URI: process.env.MONGODB_URI ?? "",
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || DEFAULTS.MONGODB_DB_NAME,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL || DEFAULTS.NEXTAUTH_URL,
  NEXTAUTH_SECRET: readSecret(),
  DEFAULT_TIMEZONE:
    process.env.DEFAULT_TIMEZONE || DEFAULTS.DEFAULT_TIMEZONE,
  // DEFAULT_GEOFENCE_RADIUS_METERS was declared here and documented in
  // .env.local.example but never read: a site's radius is set per-site in the
  // admin UI (WorkSite.radiusMeters), so the variable did nothing. Removed
  // rather than left as a setting that silently has no effect.
  PING_INTERVAL_MS: num("PING_INTERVAL_MS", DEFAULTS.PING_INTERVAL_MS),
  MAX_PING_ACCURACY_METERS: num(
    "MAX_PING_ACCURACY_METERS",
    DEFAULTS.MAX_PING_ACCURACY_METERS
  ),
  MOCK_LOCATION_SPEED_KMH: num(
    "MOCK_LOCATION_SPEED_KMH",
    DEFAULTS.MOCK_LOCATION_SPEED_KMH
  ),
  // Auto check-out the employee when a ping shows them beyond the geofence
  // radius plus this buffer. Buffer absorbs GPS jitter near the boundary.
  AUTO_CHECKOUT_ENABLED: bool("AUTO_CHECKOUT_ENABLED", true),
  AUTO_CHECKOUT_BUFFER_METERS: num(
    "AUTO_CHECKOUT_BUFFER_METERS",
    DEFAULTS.AUTO_CHECKOUT_BUFFER_METERS
  ),
  // Number of CONSECUTIVE pings that must read beyond the radius+buffer before we
  // auto check-out. Requiring several in a row means a single GPS-drift spike
  // (employee actually sitting still) won't end the shift.
  AUTO_CHECKOUT_CONSECUTIVE_PINGS: num("AUTO_CHECKOUT_CONSECUTIVE_PINGS", 3),
  // Suppress auto check-out during the afternoon lunch window (company timezone),
  // so leaving the site radius for lunch doesn't end the shift. Times are HH:mm.
  AUTO_CHECKOUT_LUNCH_BREAK_ENABLED: bool("AUTO_CHECKOUT_LUNCH_BREAK_ENABLED", true),
  AUTO_CHECKOUT_LUNCH_START: process.env.AUTO_CHECKOUT_LUNCH_START || "13:00",
  AUTO_CHECKOUT_LUNCH_END: process.env.AUTO_CHECKOUT_LUNCH_END || "14:00",
  // Gap-based auto check-out: if tracking goes silent for longer than this many
  // minutes (the employee closed the app / lost the foreground service), close
  // the session at the LAST ping received. Kept comfortably above PING_INTERVAL_MS
  // so a few dropped pings on a flaky network (lifts, basements, dead zones) don't
  // end the shift — at the default 5-minute interval, 15 minutes tolerates ~3
  // missed pings. If you shorten PING_INTERVAL_MS, this stays a wall-clock
  // tolerance and simply forgives proportionally more misses.
  PING_GAP_CHECKOUT_ENABLED: bool("PING_GAP_CHECKOUT_ENABLED", true),
  PING_GAP_CHECKOUT_MINUTES: num("PING_GAP_CHECKOUT_MINUTES", 15),
  // How long a single location ping vouches for the employee's position when
  // computing inside/outside time. Beyond this the gap is reported as
  // offline rather than assumed to continue — otherwise one ping at
  // check-in credited an entire shift as "inside". Set a little above
  // PING_INTERVAL_MS so a normally-tracked shift is fully accounted. Kept about
  // 1.5x the interval: at exactly the interval, a few seconds of ordinary jitter
  // would leave a sliver offline on every single gap.
  PING_TRUST_WINDOW_MS: num("PING_TRUST_WINDOW_MS", 480_000), // 8 minutes
  // A checked-in employee whose phone has not reported for this long is shown as
  // OFFLINE on the live board, and the admin is notified once. Comfortably above
  // PING_INTERVAL_MS so a couple of dropped pings on a flaky network don't raise
  // a false alarm.
  // Must exceed 2x PING_INTERVAL_MS — that is the boundary deriveConnectivity
  // uses for "live", so a smaller value would collapse the stale band entirely
  // and flip employees straight from live to offline.
  OFFLINE_AFTER_MS: num("OFFLINE_AFTER_MS", 15 * 60_000),
  // Raise an in-app admin notification when someone leaves the site or goes
  // offline mid-shift. These were SMTP emails until delivery proved unreliable
  // (unset credentials silently discarded every message); they are rows in the
  // notifications collection now, read from the admin dashboard.
  NOTIFY_ADMIN_ON_SITE_EXIT: bool("NOTIFY_ADMIN_ON_SITE_EXIT", true),
  NOTIFY_ADMIN_ON_OFFLINE: bool("NOTIFY_ADMIN_ON_OFFLINE", true),
  // Auto check-in: while an employee is inside their site's geofence during
  // scheduled hours and not yet checked in, the app checks them in without a tap.
  // Off switch is server-side and delivered on /api/attendance/today, so it can
  // be disabled without a rebuild or a redeploy of the app shell.
  AUTO_CHECKIN_ENABLED: bool("AUTO_CHECKIN_ENABLED", true),
  // How often the client may re-evaluate its position for auto check-in. Each
  // attempt costs a GPS fix, so this is deliberately slower than the ping rate.
  AUTO_CHECKIN_POLL_MS: num("AUTO_CHECKIN_POLL_MS", 60_000),
  // How far back a native geofence event's own `capturedAt` may reach. The
  // Android receiver queues failed uploads and retries them, so a legitimate
  // event can arrive hours late and must still be applied at the time it
  // happened. 12 hours covers a full shift spent offline while still bounding
  // how far a stale or forged timestamp could rewrite history.
  GEOFENCE_MAX_EVENT_AGE_MINUTES: num("GEOFENCE_MAX_EVENT_AGE_MINUTES", 720),
  // Tolerance for a device clock running ahead of the server.
  GEOFENCE_MAX_CLOCK_SKEW_MINUTES: num("GEOFENCE_MAX_CLOCK_SKEW_MINUTES", 5),
  // Shared secret Vercel Cron sends as a Bearer token to the close-shifts job.
  CRON_SECRET: process.env.CRON_SECRET || "",
  SMTP_HOST: process.env.SMTP_HOST || "",
  SMTP_PORT: num("SMTP_PORT", 587),
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  EMAIL_FROM: process.env.EMAIL_FROM || DEFAULTS.EMAIL_FROM,
  NODE_ENV: process.env.NODE_ENV || "development",
};

export const isEmailConfigured = Boolean(
  env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS
);

export const isMongoConfigured = Boolean(env.MONGODB_URI);
