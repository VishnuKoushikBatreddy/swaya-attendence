/**
 * Cross-platform tracker — native background-geolocation on Android/iOS,
 * web setInterval on regular browsers.
 *
 * The web tracker's behavior mirrors useBackgroundTracker (see
 * src/hooks/useBackgroundTracker.ts); the native version delegates to
 * @capacitor-community/background-geolocation, which keeps a foreground
 * service alive so pings keep arriving even when the app is closed.
 *
 * Both paths POST to the same /api/pings endpoint with the same payload,
 * so the server-side processPings() doesn't need to know which one fired.
 */
import { isNative, getPlatform } from './platform';
import { readBatteryPercent, readNetworkType } from './device-status';
import { notifyCheckedOut } from './notifications';

type PingPayload = {
  lat: number;
  lng: number;
  accuracy?: number;
  isMockLocation?: boolean;
  batteryPercentage?: number;
  networkType?: 'wifi' | 'mobile_data' | 'offline' | 'unknown';
  appState?: 'foreground' | 'background' | 'killed' | 'unknown';
  deviceId: string;
  appVersion?: string;
  capturedAt: string;
};

const DEFAULT_DEVICE_ID = 'web';
const APP_VERSION = '1.0.0';

/**
 * Web ping cadence.
 *
 * Mirrors the PING_INTERVAL_MS default in src/lib/env.ts. The server sends the
 * configured value down on /api/attendance/today; this is the fallback used
 * before that arrives (or if the request fails), so the two must stay in step.
 *
 * NOTE: this governs the WEB tracker only. The native Android watcher is
 * distance-triggered (distanceFilter below), not time-triggered — the plugin
 * exposes no interval knob — so PING_INTERVAL_MS does not apply there.
 */
const DEFAULT_PING_INTERVAL_MS = 180_000;

// Guard rails against a misconfigured env var: sub-second polling would hammer
// the battery and the API, and an absurdly long one would silently disable
// tracking. Values outside this range are clamped, not rejected.
const MIN_PING_INTERVAL_MS = 5_000;
const MAX_PING_INTERVAL_MS = 30 * 60_000;

function resolveIntervalMs(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PING_INTERVAL_MS;
  }
  return Math.min(MAX_PING_INTERVAL_MS, Math.max(MIN_PING_INTERVAL_MS, Math.floor(requested)));
}

let nativeWatcherId: string | null = null;
let webInterval: ReturnType<typeof setInterval> | null = null;
let webFirstTick: ReturnType<typeof setTimeout> | null = null;
// Called when the server reports it auto-checked-out the employee from a ping.
let onAutoCheckoutCb: (() => void) | null = null;

/**
 * Start tracking. Idempotent — calling twice is a no-op.
 */
export async function startTracker(opts: {
  active: boolean;
  deviceId?: string;
  intervalMs?: number;
  onError?: (e: Error) => void;
  onAutoCheckout?: () => void;
} = { active: true }) {
  if (!opts.active) return;
  onAutoCheckoutCb = opts.onAutoCheckout ?? null;
  const deviceId = opts.deviceId ?? DEFAULT_DEVICE_ID;
  const intervalMs = resolveIntervalMs(opts.intervalMs);

  if (isNative()) {
    // intervalMs is deliberately not forwarded — the native watcher fires on
    // movement (distanceFilter), so there is no interval to set.
    return startNative({ deviceId, onError: opts.onError });
  }
  return startWeb({ deviceId, intervalMs });
}

export async function stopTracker() {
  if (isNative()) {
    if (nativeWatcherId) {
      try {
        const mod = await loadBackgroundGeolocation();
        await mod.BackgroundGeolocation.removeWatcher({ id: nativeWatcherId });
      } catch {
        // ignore
      }
      nativeWatcherId = null;
    }
    onAutoCheckoutCb = null;
    return;
  }
  if (webInterval) {
    clearInterval(webInterval);
    webInterval = null;
  }
  if (webFirstTick) {
    clearTimeout(webFirstTick);
    webFirstTick = null;
  }
  onAutoCheckoutCb = null;
}

// ─── Native (Android/iOS) ───────────────────────────────────────────────

async function startNative(opts: {
  deviceId: string;
  onError?: (e: Error) => void;
}) {
  if (nativeWatcherId) return;
  try {
    const { BackgroundGeolocation } = await loadBackgroundGeolocation();
    // The plugin uses a Watcher API; we get a callback per location and
    // POST it ourselves to /api/pings (same payload shape as the web path).
    const id = await BackgroundGeolocation.addWatcher(
      {
        // backgroundMessage makes the watcher survive the app being
        // backgrounded. On Android it pins a persistent notification.
        backgroundMessage: 'Swaya Attendance is tracking your location',
        backgroundTitle: 'Swaya Attendance',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10,
      },
      async (location: { latitude: number; longitude: number; accuracy: number; simulated: boolean; time: number }, error: { code: string; message?: string } | undefined) => {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') {
            opts.onError?.(new Error('Location permission denied'));
            try {
              await BackgroundGeolocation.openSettings();
            } catch {
              // ignore
            }
          } else {
            opts.onError?.(new Error(error.message || 'Geolocation error'));
          }
          return;
        }
        await postPing({
          lat: location.latitude,
          lng: location.longitude,
          accuracy: location.accuracy,
          isMockLocation: location.simulated,
          batteryPercentage: (await readBatteryPercent()) ?? undefined,
          networkType: await readNetworkType(),
          appState: 'background',
          deviceId: opts.deviceId,
          appVersion: APP_VERSION,
          capturedAt: new Date(location.time).toISOString(),
        });
      }
    );
    nativeWatcherId = id;
  } catch (e) {
    nativeWatcherId = null;
    opts.onError?.(e as Error);
  }
}

async function loadBackgroundGeolocation() {
  // This community plugin (v1.x) ships ONLY native code — there is no JS bundle
  // to import. It is consumed through Capacitor's registerPlugin, which returns a
  // proxy that bridges to the native implementation on Android/iOS.
  const { registerPlugin } = await import('@capacitor/core');
  const BackgroundGeolocation: any = registerPlugin('BackgroundGeolocation');
  if (!BackgroundGeolocation) {
    throw new Error('BackgroundGeolocation plugin not available');
  }
  return { BackgroundGeolocation };
}

/**
 * The service-worker registration used to queue pings that failed to send.
 *
 * Deliberately a function rather than a module-level promise: building a
 * rejected promise eagerly produces an unhandled rejection whenever no ping
 * happens to fail, since nothing is awaiting it.
 *
 * Tests the VALUE, not just the key — in an insecure context some browsers
 * expose `navigator.serviceWorker` as undefined while `'serviceWorker' in
 * navigator` is still true, and reading `.ready` off that throws. The queue is
 * only a fallback, so its absence must never stop pings from being sent.
 */
async function swRegistration(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    throw new Error('no service worker');
  }
  return navigator.serviceWorker.ready;
}

/** Hand a failed ping to the service worker's retry queue. Best-effort. */
async function queuePing(payload: PingPayload) {
  try {
    const reg = await swRegistration();
    reg.active?.postMessage({ type: 'enqueue-ping', ping: payload });
  } catch {
    // No service worker (or it never activated) — the ping is dropped.
  }
}

async function postPing(payload: PingPayload) {
  try {
    const res = await fetch('/api/pings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pings: [payload] }),
    });
    if (res.ok) {
      // The server may have auto-checked-out the employee from this ping.
      const json = await res.json().catch(() => null);
      if (json?.data?.autoCheckedOut) {
        onAutoCheckoutCb?.();
        void notifyCheckedOut();
      }
      return;
    }
    // Server rejected it (5xx, offline shim, etc.) — hand it to the retry queue.
    await queuePing(payload);
  } catch {
    // Network down — same fallback.
    await queuePing(payload);
  }
}

// ─── Web (setInterval, with SW fallback) ────────────────────────────────

async function startWeb(opts: { deviceId: string; intervalMs: number }) {
  if (webInterval) return;


  async function sendPing(coords: { lat: number; lng: number; accuracy?: number }) {
    const capturedAt = new Date().toISOString();
    const battery = (await readBatteryPercent()) ?? undefined;
    const network = await readNetworkType();
    const payload: PingPayload = {
      lat: coords.lat,
      lng: coords.lng,
      accuracy: coords.accuracy,
      isMockLocation: false,
      batteryPercentage: battery,
      networkType: network,
      appState:
        document.visibilityState === 'visible'
          ? 'foreground'
          : 'background',
      deviceId: opts.deviceId,
      appVersion: APP_VERSION,
      capturedAt,
    };

    try {
      const res = await fetch('/api/pings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pings: [payload] }),
      });
      if (!res.ok) throw new Error('ping failed: ' + res.status);
      const json = await res.json().catch(() => null);
      if (json?.data?.autoCheckedOut) {
        onAutoCheckoutCb?.();
        void notifyCheckedOut();
      }
    } catch {
      await queuePing(payload);
    }
  }

  function tick() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void sendPing({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      () => {
        // permission denied or no fix — silent
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 1000 }
    );
  }

  webInterval = setInterval(tick, opts.intervalMs);
  webFirstTick = setTimeout(tick, 1500);
}

// Re-export for callers that want to know which platform the tracker chose
export { getPlatform };
