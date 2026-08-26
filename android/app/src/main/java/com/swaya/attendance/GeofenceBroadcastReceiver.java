package com.swaya.attendance;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.util.Log;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingEvent;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Receives OS geofence ENTER/EXIT transitions — fires even when the app is killed
 * or after reboot — and delivers them to /api/geofence-event using the native
 * token stored by the web app (@capacitor/preferences -> "CapacitorStorage"). No
 * WebView/JavaScript is involved.
 *
 * Every transition is PERSISTED FIRST and only then uploaded. Previously the POST
 * was attempted inline and a failure was merely logged, so a transition that
 * happened with no connectivity — the exact case this receiver exists for — was
 * lost permanently. Now an offline EXIT/ENTER pair survives and is replayed, in
 * order, once the network returns; the server applies each at its own capturedAt,
 * so the resulting check-in/out times are the real ones.
 */
public class GeofenceBroadcastReceiver extends BroadcastReceiver {
    private static final String TAG = "GeofenceReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null || event.hasError()) {
            return;
        }

        int transition = event.getGeofenceTransition();
        final String transitionName;
        if (transition == Geofence.GEOFENCE_TRANSITION_ENTER) {
            transitionName = "ENTER";
        } else if (transition == Geofence.GEOFENCE_TRANSITION_EXIT) {
            transitionName = "EXIT";
        } else {
            return;
        }

        Location loc = event.getTriggeringLocation();
        final double lat = loc != null ? loc.getLatitude() : 0;
        final double lng = loc != null ? loc.getLongitude() : 0;
        final float accuracy = loc != null ? loc.getAccuracy() : 0;

        // WHEN THE CROSSING HAPPENED, not when this broadcast was delivered.
        //
        // Android does not deliver geofence transitions immediately: Doze and
        // OEM battery managers routinely hold them, sometimes for a long time.
        // Stamping the current wall clock therefore back-dated nothing and
        // over-reported presence — an EXIT held for 20 minutes credited 20
        // minutes of work the employee had not done, and a held ENTER could mark
        // someone late for a shift they arrived on time for.
        //
        // The triggering Location carries the UTC time of the fix that actually
        // crossed the boundary, which is the truth we want.
        final String capturedAt = triggerTimeIso(loc);

        SharedPreferences prefs =
            context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        final String token = prefs.getString("geofence_token", null);
        if (token == null || prefs.getString("geofence_url", null) == null) {
            // Signed out — the transition can't be attributed to anyone, so
            // there is nothing worth persisting.
            Log.w(TAG, "no token/url stored — skipping geofence event");
            return;
        }

        final Context appContext = context.getApplicationContext();

        // Persist BEFORE any network attempt. If the process dies mid-upload, or
        // there is no connectivity at all, the event is still on disk.
        try {
            // Named `queued` rather than `event`: `event` is already the
            // GeofencingEvent this method started from.
            JSONObject queued = new JSONObject();
            queued.put("transition", transitionName);
            queued.put("lat", lat);
            queued.put("lng", lng);
            queued.put("accuracy", accuracy);
            queued.put("capturedAt", capturedAt); // the fix time of the crossing
            queued.put("enqueuedAt", System.currentTimeMillis());
            // Bind the event to whoever was signed in AT THE TIME. Uploading with
            // whatever token happens to be current at flush time would file this
            // movement under a different employee if someone else signs in on the
            // device first. Native tokens last 30 days, comfortably longer than
            // the queue's 24h lifetime, so this costs nothing in practice.
            queued.put("token", token);
            int depth = GeofenceEventQueue.add(appContext, queued);
            Log.d(TAG, "queued " + transitionName + " (depth " + depth + ")");
        } catch (Exception e) {
            Log.e(TAG, "failed to queue geofence event", e);
            return;
        }

        // Network I/O must not run on the main thread; keep the broadcast alive.
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                // Drains the whole queue oldest-first, so a previously stranded
                // EXIT is delivered before the ENTER that followed it.
                boolean drained = GeofenceUploader.flush(appContext);
                if (!drained) {
                    // Still offline (or the server is failing) — hand off to
                    // WorkManager, which survives the process and a reboot.
                    GeofenceUploadWorker.schedule(appContext);
                }
            } catch (Exception e) {
                Log.e(TAG, "flush failed; scheduling retry", e);
                try {
                    GeofenceUploadWorker.schedule(appContext);
                } catch (Exception ignored) {
                    // WorkManager unavailable — the event stays queued for the
                    // next transition or boot to pick up.
                }
            } finally {
                pending.finish();
            }
        }).start();
    }

    /**
     * ISO-8601 UTC time of the fix that triggered the transition.
     *
     * Falls back to the current clock when the Location is missing or its
     * timestamp is not credible: some devices report 0, and a fix from a device
     * whose clock has since been corrected can land in the future or absurdly
     * far in the past. A wrong-but-recent time is far less damaging than a
     * wildly wrong one, and the server independently rejects anything outside
     * its freshness window (GEOFENCE_MAX_EVENT_AGE_MINUTES).
     */
    private static String triggerTimeIso(Location loc) {
        if (loc == null) return isoNow();
        long fixMs = loc.getTime();
        long nowMs = System.currentTimeMillis();
        boolean credible =
            fixMs > 0
                && fixMs <= nowMs + 60_000L                 // not in the future
                && nowMs - fixMs <= 24L * 60L * 60L * 1000L; // not older than a day
        if (!credible) {
            Log.w(TAG, "implausible fix time " + fixMs + " — falling back to now");
            return isoNow();
        }
        return isoAt(fixMs);
    }

    private static String isoAt(long epochMs) {
        SimpleDateFormat f =
            new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(epochMs));
    }

    private static String isoNow() {
        SimpleDateFormat f =
            new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }
}
