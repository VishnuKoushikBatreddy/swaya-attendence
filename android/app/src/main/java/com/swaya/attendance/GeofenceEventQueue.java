package com.swaya.attendance;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Durable FIFO queue of geofence events waiting to be uploaded.
 *
 * The receiver fires ENTER/EXIT even with no connectivity — which is exactly
 * when it matters, since the OS geofence exists to cover the app being dead.
 * Previously a failed POST was logged and dropped, so the transition was lost
 * for good. Events are persisted here first and drained by GeofenceUploader.
 *
 * Backed by SharedPreferences (a JSON array) rather than a database: the volume
 * is a handful of events per day and it must be readable from a BroadcastReceiver
 * with no Capacitor/WebView involvement.
 *
 * ORDER MATTERS. An EXIT followed by an ENTER replayed backwards would check the
 * employee in and then immediately close that new session. Every operation here
 * preserves insertion order, and the uploader stops at the first failure rather
 * than skipping ahead.
 */
final class GeofenceEventQueue {
    private static final String TAG = "GeofenceQueue";
    private static final String PREFS = "GeofenceQueue";
    private static final String KEY = "pending_events";

    /**
     * Hard cap. Well above any plausible day of transitions, but stops a wedged
     * queue from growing without bound. Oldest entries are discarded first.
     */
    private static final int MAX_ITEMS = 200;

    /**
     * Client-side expiry. The server independently rejects anything older than
     * GEOFENCE_MAX_EVENT_AGE_MINUTES (default 12h) with a 400, which the uploader
     * drops; this is the belt-and-braces case where the device never reaches the
     * server at all. Deliberately longer than the server window.
     */
    private static final long MAX_AGE_MS = 24L * 60L * 60L * 1000L;

    private GeofenceEventQueue() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized JSONArray all(Context context) {
        String raw = prefs(context).getString(KEY, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception e) {
            Log.e(TAG, "corrupt queue, resetting", e);
            return new JSONArray();
        }
    }

    private static synchronized void save(Context context, JSONArray items) {
        prefs(context).edit().putString(KEY, items.toString()).apply();
    }

    /** Append an event. Returns the queue depth after the add. */
    static synchronized int add(Context context, JSONObject event) {
        JSONArray items = all(context);
        JSONArray next = new JSONArray();
        // Trim from the front so the newest events survive a full queue.
        int drop = Math.max(0, items.length() + 1 - MAX_ITEMS);
        for (int i = drop; i < items.length(); i++) {
            next.put(items.opt(i));
        }
        if (drop > 0) {
            Log.w(TAG, "queue full — discarded " + drop + " oldest event(s)");
        }
        next.put(event);
        save(context, next);
        return next.length();
    }

    /** Remove the first `count` entries (they were uploaded or permanently rejected). */
    static synchronized void removeFirst(Context context, int count) {
        if (count <= 0) return;
        JSONArray items = all(context);
        JSONArray next = new JSONArray();
        for (int i = count; i < items.length(); i++) {
            next.put(items.opt(i));
        }
        save(context, next);
    }

    /**
     * Drop entries whose enqueuedAt is older than MAX_AGE_MS. Returns how many
     * were removed. Order of the survivors is preserved.
     */
    static synchronized int purgeExpired(Context context, long nowMs) {
        JSONArray items = all(context);
        JSONArray next = new JSONArray();
        int removed = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) { removed++; continue; }
            long enqueuedAt = o.optLong("enqueuedAt", 0L);
            if (enqueuedAt > 0 && nowMs - enqueuedAt > MAX_AGE_MS) {
                removed++;
                continue;
            }
            next.put(o);
        }
        if (removed > 0) {
            save(context, next);
            Log.w(TAG, "purged " + removed + " expired event(s)");
        }
        return removed;
    }

    static synchronized boolean isEmpty(Context context) {
        return all(context).length() == 0;
    }
}
