package com.swaya.attendance;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Drains {@link GeofenceEventQueue} to /api/geofence-event.
 *
 * Never call from the main thread — it does blocking network I/O.
 *
 * Outcome rules, mirroring the web offline queue in src/lib/offline-queue.ts:
 *   2xx  -> uploaded, remove
 *   4xx  -> the server rejected it permanently (bad token, inactive employee, or
 *           a capturedAt outside the staleness window). Remove: retrying cannot
 *           help, and a stale event only gets staler.
 *   5xx / network failure -> keep it and stop draining, so ordering is preserved.
 *
 * Stopping at the first retryable failure is deliberate. Skipping ahead could
 * deliver an ENTER before the EXIT that preceded it, which would check the
 * employee in and then immediately close that brand-new session.
 */
final class GeofenceUploader {
    private static final String TAG = "GeofenceUploader";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 15000;

    private GeofenceUploader() {}

    /**
     * Attempt to upload every queued event, oldest first.
     *
     * @return true when the queue was fully drained (nothing left to retry).
     */
    static boolean flush(Context context) {
        GeofenceEventQueue.purgeExpired(context, System.currentTimeMillis());

        JSONArray items = GeofenceEventQueue.all(context);
        if (items.length() == 0) return true;

        SharedPreferences prefs =
            context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String baseUrl = prefs.getString("geofence_url", null);
        String currentToken = prefs.getString("geofence_token", null);
        if (baseUrl == null || currentToken == null) {
            // Signed out: the events can never be attributed to anyone. Drop them
            // rather than retrying forever against a URL we no longer have.
            Log.w(TAG, "no token/url — discarding " + items.length() + " queued event(s)");
            GeofenceEventQueue.removeFirst(context, items.length());
            return true;
        }

        int settled = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject event = items.optJSONObject(i);
            if (event == null) { settled++; continue; }

            // Prefer the token captured when the event fired, so a queued event is
            // always attributed to the employee it belongs to even if someone else
            // has since signed in on this device.
            String eventToken = event.optString("token", null);
            int status = post(baseUrl, eventToken != null ? eventToken : currentToken, event);
            if (status >= 200 && status < 300) {
                settled++;
            } else if (status >= 400 && status < 500) {
                Log.w(TAG, "server rejected event (HTTP " + status + ") — dropping");
                settled++;
            } else {
                // 5xx or no connectivity — stop here and keep the rest in order.
                Log.d(TAG, "upload deferred at index " + i + " (HTTP " + status + ")");
                break;
            }
        }

        GeofenceEventQueue.removeFirst(context, settled);
        boolean drained = GeofenceEventQueue.isEmpty(context);
        Log.d(TAG, "flush settled=" + settled + " drained=" + drained);
        return drained;
    }

    /**
     * POST one event.
     *
     * @return the HTTP status, or 0 when the request could not be made at all
     *         (treated as retryable).
     */
    private static int post(String baseUrl, String token, JSONObject event) {
        HttpURLConnection conn = null;
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("transition", event.optString("transition"));
            body.put("lat", event.optDouble("lat", 0));
            body.put("lng", event.optDouble("lng", 0));
            body.put("accuracy", event.optDouble("accuracy", 0));
            // The time the transition actually happened. The server applies the
            // event at THIS instant, not on arrival — that is what makes a late
            // retry produce a correctly back-dated check-in/out.
            body.put("capturedAt", event.optString("capturedAt"));

            URL url = new URL(baseUrl + "/api/geofence-event");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            Log.d(TAG, "geofence-event " + event.optString("transition") + " -> HTTP " + code);
            return code;
        } catch (Exception e) {
            Log.e(TAG, "geofence post failed", e);
            return 0; // retryable
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
