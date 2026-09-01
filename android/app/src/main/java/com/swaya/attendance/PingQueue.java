package com.swaya.attendance;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Durable FIFO buffer of location pings awaiting upload.
 *
 * The web tracker buffers failed pings in the service worker's IndexedDB, which
 * lives inside the WebView — so it dies with the Activity, exactly when tracking
 * matters most. This buffer lives in the service's own process state and is
 * written to disk, so a dead zone, a process kill or a reboot costs nothing but
 * delay: each ping keeps its own capturedAt and is applied at that time when it
 * finally reaches the server.
 *
 * SharedPreferences rather than a database: the volume is a few hundred small
 * objects a day and it must be readable from a Service with no Capacitor bridge.
 */
final class PingQueue {
    private static final String TAG = "PingQueue";
    private static final String PREFS = "PingQueue";
    private static final String KEY = "pending_pings";

    /**
     * Hard cap. At a 60s cadence this is ~4 hours of continuous buffering, well
     * beyond any realistic dead zone. When full the OLDEST pings are dropped:
     * recent positions are worth more than stale ones, and the alternative is
     * unbounded growth on a device that never regains signal.
     */
    private static final int MAX_ITEMS = 250;

    /** Older than this and the server would reject it anyway. */
    private static final long MAX_AGE_MS = 12L * 60L * 60L * 1000L;

    private PingQueue() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized JSONArray all(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString(KEY, "[]"));
        } catch (Exception e) {
            Log.e(TAG, "corrupt queue, resetting", e);
            return new JSONArray();
        }
    }

    private static synchronized void save(Context ctx, JSONArray items) {
        prefs(ctx).edit().putString(KEY, items.toString()).apply();
    }

    /** Append a ping. Returns the queue depth afterwards. */
    static synchronized int add(Context ctx, JSONObject ping) {
        JSONArray items = all(ctx);
        JSONArray next = new JSONArray();
        int drop = Math.max(0, items.length() + 1 - MAX_ITEMS);
        for (int i = drop; i < items.length(); i++) next.put(items.opt(i));
        if (drop > 0) Log.w(TAG, "queue full — dropped " + drop + " oldest ping(s)");
        next.put(ping);
        save(ctx, next);
        return next.length();
    }

    /** Oldest-first slice, for uploading in order. */
    static synchronized JSONArray peek(Context ctx, int max) {
        JSONArray items = all(ctx);
        JSONArray out = new JSONArray();
        for (int i = 0; i < Math.min(max, items.length()); i++) out.put(items.opt(i));
        return out;
    }

    /** Drop the first `count` entries — uploaded, or permanently rejected. */
    static synchronized void removeFirst(Context ctx, int count) {
        if (count <= 0) return;
        JSONArray items = all(ctx);
        JSONArray next = new JSONArray();
        for (int i = count; i < items.length(); i++) next.put(items.opt(i));
        save(ctx, next);
    }

    /** Discard pings the server would reject as stale. Returns how many went. */
    static synchronized int purgeExpired(Context ctx, long nowMs) {
        JSONArray items = all(ctx);
        JSONArray next = new JSONArray();
        int removed = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) { removed++; continue; }
            long at = o.optLong("enqueuedAt", 0L);
            if (at > 0 && nowMs - at > MAX_AGE_MS) { removed++; continue; }
            next.put(o);
        }
        if (removed > 0) {
            save(ctx, next);
            Log.w(TAG, "purged " + removed + " expired ping(s)");
        }
        return removed;
    }

    static synchronized int size(Context ctx) {
        return all(ctx).length();
    }

    static synchronized void clear(Context ctx) {
        save(ctx, new JSONArray());
    }
}
