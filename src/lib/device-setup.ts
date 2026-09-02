/**
 * Device power settings that decide whether background tracking survives.
 *
 * The app can be entirely correct and still record nothing: OEM battery managers
 * stop a foreground service as soon as the app leaves recents, unless the user
 * has granted exemptions that live in a different place on every brand and are
 * worded differently on every OS version. Telling employees to "find autostart
 * in settings" does not work at scale, and the failure is silent — a shift with
 * no pings looks identical to a bug in the app.
 *
 * These helpers let the app check what it can and open the right screen
 * directly. No-ops on web, so callers need no platform branching.
 */
import { isNative } from "./platform";

export type DeviceSetupStatus = {
  /** False on web and wherever the native plugin is unavailable. */
  supported: boolean;
  manufacturer: string;
  model: string;
  /**
   * Exempt from battery optimisation. Read from PowerManager, so this one is a
   * real answer rather than a guess.
   */
  batteryUnrestricted: boolean;
  /**
   * Whether a vendor autostart screen was found to open. NOT a statement that
   * autostart is enabled — that has no public API and cannot be read at all,
   * which is why the UI asks the employee to confirm it themselves.
   */
  autostartScreenAvailable: boolean;
  /** Whether the tracking service is actually running right now. */
  trackingServiceRunning: boolean;
};

const UNSUPPORTED: DeviceSetupStatus = {
  supported: false,
  manufacturer: "",
  model: "",
  batteryUnrestricted: true,
  autostartScreenAvailable: false,
  trackingServiceRunning: false,
};

type DeviceSetupPlugin = {
  getStatus(): Promise<Omit<DeviceSetupStatus, "supported">>;
  requestBatteryExemption(): Promise<{ opened: boolean; alreadyGranted?: boolean }>;
  openAutostartSettings(): Promise<{ opened: boolean; vendorScreen?: boolean }>;
  openAppSettings(): Promise<{ opened: boolean }>;
};

async function plugin(): Promise<DeviceSetupPlugin | null> {
  if (!isNative()) return null;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    return registerPlugin<DeviceSetupPlugin>("DeviceSetup");
  } catch {
    return null;
  }
}

export async function getDeviceSetupStatus(): Promise<DeviceSetupStatus> {
  const p = await plugin();
  if (!p) return UNSUPPORTED;
  try {
    const s = await p.getStatus();
    return { supported: true, ...s };
  } catch {
    // An older APK without the plugin: report unsupported rather than nagging
    // about settings this build cannot check or open.
    return UNSUPPORTED;
  }
}

/** One-tap system dialog. Returns false when there was nothing to open. */
export async function requestBatteryExemption(): Promise<boolean> {
  const p = await plugin();
  if (!p) return false;
  try {
    const r = await p.requestBatteryExemption();
    return !!r?.opened;
  } catch {
    return false;
  }
}

/** Vendor autostart screen, falling back to this app's settings page. */
export async function openAutostartSettings(): Promise<boolean> {
  const p = await plugin();
  if (!p) return false;
  try {
    const r = await p.openAutostartSettings();
    return !!r?.opened;
  } catch {
    return false;
  }
}

export async function openAppSettings(): Promise<boolean> {
  const p = await plugin();
  if (!p) return false;
  try {
    const r = await p.openAppSettings();
    return !!r?.opened;
  } catch {
    return false;
  }
}

/**
 * Per-brand wording for the autostart toggle.
 *
 * The screen the app opens is a long app list with no indication of which
 * setting matters, so the employee still needs to be told what to look for —
 * and the label differs on every brand.
 */
export function autostartHint(manufacturer: string): string {
  const m = (manufacturer || "").toLowerCase();
  if (m.includes("oneplus") || m.includes("oppo") || m.includes("realme")) {
    return 'Turn on "Allow auto launch" (or "Allow auto startup") for Swaya Attendance.';
  }
  if (m.includes("xiaomi") || m.includes("redmi") || m.includes("poco")) {
    return 'Turn on "Autostart" for Swaya Attendance.';
  }
  if (m.includes("vivo") || m.includes("iqoo")) {
    return 'Allow Swaya Attendance to start in the background.';
  }
  if (m.includes("huawei") || m.includes("honor")) {
    return 'Open "App launch", switch Swaya Attendance to "Manage manually" and enable all three options.';
  }
  if (m.includes("samsung")) {
    return 'Make sure Swaya Attendance is not in "Sleeping apps" or "Deep sleeping apps".';
  }
  return 'Allow Swaya Attendance to run in the background and start automatically.';
}
