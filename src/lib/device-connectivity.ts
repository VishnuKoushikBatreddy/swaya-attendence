/**
 * What to tell the employee when their phone can't do its job.
 *
 * Two switches silently break attendance: location services and the internet.
 * Neither produces an error the employee ever sees — the app keeps rendering,
 * the tracking notification keeps saying "active", and the shift simply records
 * nothing. Someone who turns location off to save battery on a long day has no
 * reason to connect that to their pay.
 *
 * The consequences differ, and so does the wording:
 *
 *   location off  — nothing is captured. That time is gone and lands on the day
 *                   as offline time.
 *   internet off  — capture continues; pings queue on the device and sync later.
 *                   Worth mentioning, not worth alarming anyone about.
 *
 * Kept as pure logic so the decision can be tested directly, and so the banner
 * and the Android notification (TrackingAlerts.java) can be checked against each
 * other rather than drifting into saying different things about the same state.
 */

export type LocationPermission = "granted" | "denied" | "prompt" | "unknown";

export type ConnectivityProblem = {
  id: "location-permission" | "location-off" | "location-and-internet" | "internet-off";
  title: string;
  message: string;
  /**
   * True when attendance is being LOST right now, false when it is only being
   * delayed. Drives how loudly this is presented.
   */
  losingData: boolean;
  /** Which settings screen would fix it, where the app can open one. */
  fix: "permission" | "location" | "network" | null;
};

export type ConnectivityInput = {
  /** Whether the device has any usable network. */
  online: boolean;
  /**
   * The device's master location toggle. `null` means it could not be read —
   * which is always the case in a browser, where no such API exists. Unknown
   * is treated as fine: a false alarm teaches people to ignore the real one.
   */
  locationEnabled: boolean | null;
  /** This app's location permission. "unknown" is likewise treated as fine. */
  locationPermission: LocationPermission;
};

export function describeConnectivityProblem(
  input: ConnectivityInput
): ConnectivityProblem | null {
  const noInternet = !input.online;
  // Permission outranks the toggle: while the app is not allowed to read
  // location, whether the device's switch is on makes no difference.
  const noPermission = input.locationPermission === "denied";
  const locationOff = !noPermission && input.locationEnabled === false;

  if (noPermission) {
    return {
      id: "location-permission",
      title: "Allow location for attendance",
      message:
        "Attendance can't record your shift without location permission. " +
        "Allow it in your phone's settings for this app.",
      losingData: true,
      fix: "permission",
    };
  }

  if (locationOff && noInternet) {
    return {
      id: "location-and-internet",
      title: "Turn on location and internet",
      message:
        "Your attendance isn't being recorded. The app needs location and " +
        "internet to track your shift.",
      losingData: true,
      fix: "location",
    };
  }

  if (locationOff) {
    return {
      id: "location-off",
      title: "Turn on location",
      message:
        "Your attendance isn't being recorded while location is off. " +
        "This time will count as offline.",
      losingData: true,
      fix: "location",
    };
  }

  if (noInternet) {
    return {
      id: "internet-off",
      title: "No internet connection",
      message:
        "Your location is being saved on this phone and will sync when " +
        "you're back online.",
      losingData: false,
      fix: "network",
    };
  }

  return null;
}

/**
 * Read this app's location permission without prompting for it.
 *
 * The Permissions API is the only way to ask "am I allowed?" without also asking
 * the employee — calling getCurrentPosition to find out would throw a system
 * dialog at them. Safari and older Android WebViews don't implement it for
 * geolocation, hence "unknown", which the logic above treats as fine.
 */
export async function readLocationPermission(): Promise<LocationPermission> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    const state = status.state;
    if (state === "granted" || state === "denied" || state === "prompt") return state;
    return "unknown";
  } catch {
    return "unknown";
  }
}
