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
 * Drains {@link PingQueue} to /api/native/pings in batches.
 *
 * Never call from the main thread — it does blocking network I/O.
 *
 * Batching is the point: one request carrying N pings instead of N requests
 * means far fewer serverless invocations and database connections for the same
 * data. Outcome rules match the geofence uploader, so behaviour is consistent
 * across both native upload paths:
 *   2xx -> delivered, remove
 *   4xx -> permanently rejected (bad token, inactive employee), remove; retrying
 *          cannot help and would block every later ping behind it
 *   5xx / no connectivity -> keep, stop draining, try again later
 */
final class PingUploader {
    private static final String TAG = "PingUploader";
    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 20000;

    /** Pings per request. Keeps the body small while collapsing many pings. */
    static final int BATCH_SIZE = 25;

    private PingUploader() {}

    /** True when the caller should auto-check-out (the server closed the session). */
    static boolean lastBatchAutoCheckedOut = false;

    /**
     * Upload as much of the queue as possible, oldest first.
     *
     * @return true when the queue was fully drained.
     */
    static boolean flush(Context ctx) {
        // Reset FIRST, before any early return.
        //
        // This used to sit below the two returns underneath, so a flush that
        // found an empty queue left the flag at whatever the previous flush set
        // it to. Once it had been true even once, the very next empty flush made
        // the service read a stale true and stop tracking for a check-out that
        // had already been handled.
        lastBatchAutoCheckedOut = false;

        PingQueue.purgeExpired(ctx, System.currentTimeMillis());
        if (PingQueue.size(ctx) == 0) return true;

        SharedPreferences prefs =
            ctx.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String baseUrl = prefs.getString("geofence_url", null);
        String token = prefs.getString("geofence_token", null);
        if (baseUrl == null || token == null) {
            // HOLD, do not discard. This used to call PingQueue.clear(), which
            // threw away work the employee had genuinely done. The usual reason
            // the token is missing is not "signed out for good" — it is the
            // minutes right after an app update or reinstall, before the WebView
            // has re-registered it. Deleting the buffer in that window silently
            // lost a chunk of the shift.
            //
            // Keeping them is safe: PingQueue is bounded to MAX_ITEMS and purges
            // anything older than MAX_AGE_MS, so a genuinely abandoned queue
            // still drains itself rather than growing without limit.
            Log.w(TAG, "no token/url — holding " + PingQueue.size(ctx) + " ping(s) until it returns");
            return false;
        }

        while (PingQueue.size(ctx) > 0) {
            JSONArray batch = PingQueue.peek(ctx, BATCH_SIZE);
            if (batch.length() == 0) break;

            int status = post(prefs, baseUrl, token, batch);
            if (status >= 200 && status < 300) {
                PingQueue.removeFirst(ctx, batch.length());
            } else if (status >= 400 && status < 500) {
                Log.w(TAG, "server rejected batch (HTTP " + status + ") — dropping " + batch.length());
                PingQueue.removeFirst(ctx, batch.length());
            } else {
                Log.d(TAG, "upload deferred (HTTP " + status + "), " + PingQueue.size(ctx) + " queued");
                return false;
            }
        }
        return true;
    }

    /** @return HTTP status, or 0 when the request could not be made (retryable). */
    private static int post(
            SharedPreferences prefs, String baseUrl, String token, JSONArray pings) {
        HttpURLConnection conn = null;
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            // Strip the local bookkeeping field the server does not accept —
            // the schema rejects unknown keys on strict objects, and enqueuedAt
            // is only ever used for local expiry.
            JSONArray cleaned = new JSONArray();
            for (int i = 0; i < pings.length(); i++) {
                JSONObject p = new JSONObject(pings.optJSONObject(i).toString());
                p.remove("enqueuedAt");
                cleaned.put(p);
            }
            body.put("pings", cleaned);

            URL url = new URL(baseUrl + "/api/native/pings");
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
            if (code >= 200 && code < 300) {
                // The server may have auto-checked-out the employee from these
                // pings (sustained absence, shift end, ping gap). Surface it so
                // the service can stop tracking instead of pinging a closed
                // session for the rest of the day.
                String resp = readBody(conn);
                if (resp != null) {
                    try {
                        JSONObject data = new JSONObject(resp).optJSONObject("data");
                        if (data != null) {
                            lastBatchAutoCheckedOut = data.optBoolean("autoCheckedOut", false);

                            // The native token is long-lived but not immortal.
                            // Once it expired the server answered 401, which the
                            // 4xx branch treats as permanent and DROPS the batch
                            // — so an employee who had not opened the app in a
                            // month lost pings with nothing to indicate why.
                            // The service already talks to the server every few
                            // minutes, so the server hands back a fresh token as
                            // expiry approaches and it is simply stored here. No
                            // app launch required.
                            String refreshed = data.optString("refreshedToken", null);
                            if (refreshed != null && !refreshed.isEmpty()) {
                                prefs.edit().putString("geofence_token", refreshed).apply();
                                Log.d(TAG, "native token refreshed by the server");
                            }
                        }
                    } catch (Exception parseErr) {
                        // Fall back to the old string probe rather than losing
                        // the auto-checkout signal on an unexpected body.
                        lastBatchAutoCheckedOut = resp.contains("\"autoCheckedOut\":true");
                    }
                }
            }
            Log.d(TAG, "uploaded " + pings.length() + " ping(s) -> HTTP " + code);
            return code;
        } catch (Exception e) {
            Log.e(TAG, "ping upload failed", e);
            return 0;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readBody(HttpURLConnection conn) {
        try (java.io.InputStream in = conn.getInputStream()) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }
}
