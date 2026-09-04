package com.swaya.attendance;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Device-level settings that decide whether background tracking survives.
 *
 * The app can do everything right and still be killed: OEM battery managers stop
 * a foreground service the moment the app leaves recents unless the user has
 * granted two separate exemptions. Those live in different places on every
 * brand, are worded differently on every OS version, and are close to
 * undiscoverable — telling an employee to "find autostart in settings" does not
 * work at scale.
 *
 * So the app checks what it can, and takes the employee straight to the screen
 * rather than describing where it is.
 *
 * WHAT CAN AND CANNOT BE DETECTED
 * Battery optimisation is readable through PowerManager, so that one is a real
 * check. Autostart is a vendor feature with no public API — there is no way to
 * read it, only to open the screen. It is therefore reported as "unknown" rather
 * than guessed at, and shown as a prompt the employee confirms themselves.
 */
@CapacitorPlugin(name = "DeviceSetup")
public class DeviceSetupPlugin extends Plugin {

    private static final String TAG = "DeviceSetup";

    /**
     * Vendor autostart screens, tried in order. These are internal activities
     * rather than public API: they vary by model and disappear between OS
     * versions, so every one is attempted defensively and the app falls back to
     * its own settings page when none resolve.
     */
    private static final String[][] AUTOSTART_TARGETS = {
        // OnePlus (OxygenOS, and the ColorOS-derived builds on newer models)
        { "com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity" },
        { "com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity" },
        { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
        { "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity" },
        // Xiaomi / Redmi / POCO
        { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
        // Vivo / iQOO
        { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
        { "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager" },
        // Huawei / Honor
        { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
        { "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity" },
        // Samsung
        { "com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity" },
        // Asus
        { "com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity" },
    };

    /**
     * What the app can determine about this device's power settings.
     *
     * `batteryUnrestricted` is authoritative. `autostartScreenAvailable` only
     * says a vendor screen was found to open — never that autostart is enabled,
     * because that is not readable.
     */
    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject res = new JSObject();
        res.put("platform", "android");
        res.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        res.put("model", Build.MODEL == null ? "" : Build.MODEL);
        res.put("sdkInt", Build.VERSION.SDK_INT);
        res.put("batteryUnrestricted", isIgnoringBatteryOptimizations());
        res.put("autostartScreenAvailable", resolveAutostartIntent() != null);
        res.put("trackingServiceRunning", LocationTrackingService.running);
        // The device's master location toggle and its network state, both read
        // from the OS. The WebView cannot see either: navigator.onLine only
        // reports whether the browser has a connection object, and there is no
        // web API at all for "location services are switched off" — a denied
        // geolocation call looks the same as an indoor timeout.
        res.put("locationServicesEnabled", TrackingAlerts.isLocationEnabled(getContext()));
        res.put("internetAvailable", TrackingAlerts.hasInternet(getContext()));
        call.resolve(res);
    }

    /** The device's location settings screen — where the master toggle lives. */
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("opened", true));
        } catch (Exception e) {
            Log.w(TAG, "location settings refused to open", e);
            openAppDetails(call);
        }
    }

    /** Wi-Fi / mobile data settings. */
    @PluginMethod
    public void openNetworkSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("opened", true));
        } catch (Exception e) {
            Log.w(TAG, "network settings refused to open", e);
            openAppDetails(call);
        }
    }

    /**
     * Ask the system to exempt this app from battery optimisation.
     *
     * This is the single most effective setting, and the only one with a direct
     * request dialog — one tap rather than a walk through Settings.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            call.resolve(new JSObject().put("opened", false));
            return;
        }
        if (isIgnoringBatteryOptimizations()) {
            call.resolve(new JSObject().put("opened", false).put("alreadyGranted", true));
            return;
        }
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("opened", true));
        } catch (Exception e) {
            // Some builds refuse the direct request; fall back to the list.
            Log.w(TAG, "direct battery exemption request failed", e);
            try {
                Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(list);
                call.resolve(new JSObject().put("opened", true).put("fallback", true));
            } catch (Exception e2) {
                call.reject("could_not_open_battery_settings");
            }
        }
    }

    /** Open the vendor autostart screen, or this app's settings page if there is none. */
    @PluginMethod
    public void openAutostartSettings(PluginCall call) {
        Intent target = resolveAutostartIntent();
        if (target != null) {
            try {
                target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(target);
                call.resolve(new JSObject().put("opened", true).put("vendorScreen", true));
                return;
            } catch (Exception e) {
                Log.w(TAG, "vendor autostart screen refused to open", e);
            }
        }
        openAppDetails(call);
    }

    /** This app's own settings page — always available, useful as a last resort. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openAppDetails(call);
    }

    private void openAppDetails(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("opened", true).put("vendorScreen", false));
        } catch (Exception e) {
            call.reject("could_not_open_settings");
        }
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (Exception e) {
            Log.w(TAG, "could not read battery optimisation state", e);
            return false;
        }
    }

    /** The first autostart activity this device actually has, or null. */
    private Intent resolveAutostartIntent() {
        for (String[] target : AUTOSTART_TARGETS) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(target[0], target[1]));
            // Only offer a screen that genuinely resolves — sending an employee
            // to an activity that does not exist is worse than saying nothing.
            if (getContext().getPackageManager().resolveActivity(i, 0) != null) {
                return i;
            }
        }
        return null;
    }
}
