package com.swaya.attendance;

import android.Manifest;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Thin bridge for starting and stopping {@link LocationTrackingService}.
 *
 * Only the START/STOP decision crosses the bridge. Capture and upload stay
 * entirely native, which is the whole point: once started, tracking no longer
 * depends on the WebView being alive.
 */
@CapacitorPlugin(name = "LocationTracking")
public class TrackingPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        boolean fine = ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED;
        if (!fine) {
            call.reject("Location permission not granted");
            return;
        }

        // Fall back to the SERVICE's default, not a second hardcoded number.
        // This said 60_000 while both the JS caller and the service used
        // 300_000, so a call that omitted intervalMs would silently have tracked
        // five times as fast as the configured cadence.
        long intervalMs = call.getLong("intervalMs", LocationTrackingService.DEFAULT_INTERVAL_MS);
        String deviceId = call.getString("deviceId", "android");
        // 0 = no scheduled end; the service then runs until explicitly stopped.
        long shiftEndMs = call.getLong("shiftEndMs", 0L);
        LocationTrackingService.start(getContext(), intervalMs, deviceId, shiftEndMs);

        JSObject res = new JSObject();
        res.put("started", true);
        res.put("intervalMs", intervalMs);
        res.put("shiftEndMs", shiftEndMs);
        call.resolve(res);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        LocationTrackingService.stop(getContext());
        call.resolve();
    }

    /** Lets the UI show whether native tracking is genuinely running. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject res = new JSObject();
        res.put("running", LocationTrackingService.running);
        res.put("queued", PingQueue.size(getContext()));
        call.resolve(res);
    }
}
