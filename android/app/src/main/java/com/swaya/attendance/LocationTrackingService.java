package com.swaya.attendance;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Foreground service that captures and uploads location for the whole shift,
 * independently of the WebView.
 *
 * WHY THIS EXISTS
 * ---------------
 * Tracking previously ran as JavaScript: @capacitor-community/background-
 * geolocation delivers each fix to JS over the Capacitor bridge, and the upload
 * was a fetch() in the WebView. Both die when the Activity is destroyed. The
 * plugin's own service makes that explicit — its onUnbind() stops every watcher
 * and calls stopSelf() when the app goes away, deliberately, to avoid crashes.
 * So "employee swiped the app away" silently ended tracking.
 *
 * Everything here runs in the service process with no bridge and no WebView, the
 * same pattern GeofenceBroadcastReceiver/GeofenceUploader already use to survive
 * the app being killed.
 *
 * WHAT IT DOES NOT FIX
 * --------------------
 * Force-stop (by the user or an OEM battery manager) kills this like anything
 * else; no app survives it. It also does not improve GPS quality — concrete
 * still blocks satellites. The server-side accuracy guards remain necessary.
 */
public class LocationTrackingService extends Service {
    private static final String TAG = "LocationTracking";

    static final String ACTION_START = "com.swaya.attendance.START_TRACKING";
    static final String ACTION_STOP = "com.swaya.attendance.STOP_TRACKING";
    static final String EXTRA_INTERVAL_MS = "intervalMs";
    static final String EXTRA_DEVICE_ID = "deviceId";

    private static final String CHANNEL_ID = "attendance_tracking";
    private static final int NOTIFICATION_ID = 4801;

    /**
     * Default cadence. Attendance needs to know "are they on site", not to draw
     * a moving map, so this is deliberately far slower than navigation-grade
     * tracking — the difference is what makes an 8-hour shift survivable on a
     * phone with no charger. Overridable from JS via PING_INTERVAL_MS.
     */
    static final long DEFAULT_INTERVAL_MS = 300_000L;
    private static final long MIN_INTERVAL_MS = 15_000L;
    private static final long MAX_INTERVAL_MS = 15 * 60_000L;

    /** Upload attempt cadence, independent of capture. */
    private static final long FLUSH_INTERVAL_MS = 5 * 60_000L;

    /**
     * How many capture intervals of total silence before the watchdog decides
     * the location provider has stopped delivering and re-arms it. Three is
     * forgiving enough to ride out an ordinary missed fix.
     */
    private static final int WATCHDOG_MISSED_INTERVALS = 3;

    /** Flush early once the buffer reaches a full batch. */
    private static final int FLUSH_AT_DEPTH = PingUploader.BATCH_SIZE;

    /** Set when the Activity is gone, so pings can report appState honestly. */
    private static volatile boolean appTaskRemoved = false;

    private FusedLocationProviderClient client;
    private LocationCallback callback;
    private HandlerThread worker;
    private Handler workerHandler;
    private Handler mainHandler;

    private long intervalMs = DEFAULT_INTERVAL_MS;
    private String deviceId = "android";
    private volatile Location lastFix = null;
    private volatile long lastFixAt = 0L;
    private volatile long lastFlushAt = 0L;
    private volatile int consecutiveFixFailures = 0;
    private volatile long serviceStartedAt = 0L;
    private Runnable watchdog;

    /** Whether the service is currently tracking — read by the plugin. */
    static volatile boolean running = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        client = LocationServices.getFusedLocationProviderClient(this);
        worker = new HandlerThread("ping-upload");
        worker.start();
        workerHandler = new Handler(worker.getLooper());
        mainHandler = new Handler(Looper.getMainLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            stopTracking();
            return START_NOT_STICKY;
        }

        // Android hands a NULL intent back when it recreates a START_STICKY
        // service after reclaiming the process, and the recreated object starts
        // from its field defaults. Nothing used to re-read the saved config
        // despite the comment below claiming otherwise, so a restarted service
        // silently reverted to deviceId "android" and the default cadence —
        // losing whatever interval the server had configured.
        SharedPreferences saved = getSharedPreferences("TrackingConfig", Context.MODE_PRIVATE);
        long requested = saved.getLong("intervalMs", DEFAULT_INTERVAL_MS);
        String savedDevice = saved.getString("deviceId", null);
        if (savedDevice != null) deviceId = savedDevice;

        if (intent != null) {
            // An explicit start wins over the stored config and refreshes it.
            requested = intent.getLongExtra(EXTRA_INTERVAL_MS, requested);
            String d = intent.getStringExtra(EXTRA_DEVICE_ID);
            if (d != null) deviceId = d;
        }
        intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, requested));

        startForeground(NOTIFICATION_ID, buildNotification("Starting…"));

        if (!hasLocationPermission()) {
            // Nothing useful can happen without permission; stop rather than sit
            // in the notification shade pretending to track.
            Log.w(TAG, "location permission missing — stopping");
            stopTracking();
            return START_NOT_STICKY;
        }

        requestUpdates();
        running = true;
        if (serviceStartedAt == 0L) serviceStartedAt = System.currentTimeMillis();
        startWatchdog();

        // START_STICKY: if Android reclaims the process under memory pressure it
        // recreates the service with a null intent. START_REDELIVER_INTENT would
        // replay a possibly stale interval, so the config is re-read from
        // preferences at the top of this method instead.
        return START_STICKY;
    }

    private void requestUpdates() {
        if (callback != null) return;

        LocationRequest request = new LocationRequest.Builder(
                // HIGH_ACCURACY, but only once per interval. Balanced accuracy
                // is roughly 100m, which is the whole geofence radius on a small
                // site — it would put employees outside their own fence. The
                // battery saving comes from the long interval, not from a
                // coarser fix.
                Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
                .setMinUpdateIntervalMillis(intervalMs / 2)
                // 0, not 10: a mason standing still all morning must still
                // report. Distance-filtered updates were why a stationary
                // employee produced no pings at all and looked offline.
                .setMinUpdateDistanceMeters(0f)
                .setWaitForAccurateLocation(false)
                .build();

        callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                // Outermost guard for the whole capture path. This callback is
                // delivered on the worker looper, so anything thrown here that
                // is not caught kills the process and with it the foreground
                // service — one bad fix would end tracking for the shift. A
                // dropped fix costs five minutes; a dead service costs the day.
                try {
                    Location loc = result.getLastLocation();
                    if (loc == null) {
                        consecutiveFixFailures++;
                        return;
                    }
                    consecutiveFixFailures = 0;
                    lastFix = loc;
                    lastFixAt = System.currentTimeMillis();
                    enqueue(loc);
                    maybeFlush();
                    updateNotification();
                } catch (Throwable t) {
                    Log.e(TAG, "location callback failed — tracking continues", t);
                }
            }
        };

        try {
            client.requestLocationUpdates(request, callback, worker.getLooper());
            Log.d(TAG, "tracking started at " + intervalMs + "ms");
        } catch (SecurityException e) {
            Log.e(TAG, "permission revoked while starting", e);
            stopTracking();
        }
    }

    /** Buffer a ping. Upload is deliberately decoupled from capture. */
    private void enqueue(Location loc) {
        try {
            JSONObject p = new JSONObject();
            p.put("lat", loc.getLatitude());
            p.put("lng", loc.getLongitude());
            p.put("accuracy", loc.getAccuracy());
            // The fix's own time, not "now" — a buffered ping must be applied at
            // the moment it was taken, which is what lets a dead-zone batch
            // reconstruct the shift correctly.
            p.put("capturedAt", iso(loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis()));
            p.put("deviceId", deviceId);
            p.put("isMockLocation", isMock(loc));
            // "killed" was in the LocationPing enum but could never be sent:
            // reporting it required JS, which does not exist once the app is
            // gone. The service can tell the truth.
            p.put("appState", appTaskRemoved ? "killed" : "background");
            p.put("enqueuedAt", System.currentTimeMillis());
            int depth = PingQueue.add(this, p);
            Log.d(TAG, "ping queued (depth " + depth + ")");
        } catch (Exception e) {
            Log.e(TAG, "failed to queue ping", e);
        }
    }

    private void maybeFlush() {
        long now = System.currentTimeMillis();
        boolean due = now - lastFlushAt >= FLUSH_INTERVAL_MS;
        boolean full = PingQueue.size(this) >= FLUSH_AT_DEPTH;
        if (!due && !full) return;
        lastFlushAt = now;

        workerHandler.post(() -> {
            // EVERYTHING here is inside a catch-all on purpose.
            //
            // This runs on a HandlerThread, and an uncaught exception on a
            // background thread does not merely abandon the upload — it takes
            // the entire process down, foreground service included. Tracking
            // would then stop dead after a single flush with nothing in the app
            // to show why, which is exactly the failure this guards against.
            // Losing one upload is recoverable; losing the service is not, since
            // the queue keeps the pings and the next tick retries them.
            try {
                boolean drained = PingUploader.flush(getApplicationContext());
                if (PingUploader.lastBatchAutoCheckedOut) {
                    // The server closed the session — keep tracking pointless.
                    Log.d(TAG, "server auto-checked-out; stopping tracking");
                    mainHandler.post(this::stopTracking);
                    return;
                }
                if (!drained) Log.d(TAG, "flush incomplete; will retry");
            } catch (Throwable t) {
                // Roll the clock back so the next fix retries immediately rather
                // than waiting out a full flush interval for a failure that may
                // well be transient.
                lastFlushAt = 0L;
                Log.e(TAG, "flush failed — tracking continues, pings stay queued", t);
            }
        });
    }

    private boolean isMock(Location loc) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return loc.isMock();
        return loc.isFromMockProvider();
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Recovers from the two ways tracking dies quietly.
     *
     * FusedLocationProviderClient can simply stop delivering — Doze, an OEM
     * battery manager, or a provider hiccup — and nothing noticed: the service
     * stayed alive with its notification showing while producing no fixes at
     * all. consecutiveFixFailures was counted and then never acted upon.
     *
     * The second problem is subtler. maybeFlush() only ran from
     * onLocationResult, so NO FIX meant NO UPLOAD: anything already queued sat
     * there indefinitely, even with a working network. This flushes on its own
     * schedule so buffered pings drain regardless.
     */
    private void startWatchdog() {
        stopWatchdog();
        watchdog = new Runnable() {
            @Override
            public void run() {
                try {
                    if (!running) return;
                    long reference = lastFixAt > 0 ? lastFixAt : serviceStartedAt;
                    long silentMs = System.currentTimeMillis() - reference;
                    if (silentMs > intervalMs * WATCHDOG_MISSED_INTERVALS) {
                        Log.w(TAG, "no fix for " + (silentMs / 1000) + "s — re-arming location updates");
                        reArmUpdates();
                        // Re-arming alone is not enough. The stream is
                        // PRIORITY_HIGH_ACCURACY, which is GPS-first and can
                        // starve indefinitely indoors — rebuilding a request
                        // that is already starved just starves again. Force one
                        // coarse fix so the shift is not recorded as a silent
                        // hole. Roughly 100m accuracy is too imprecise to move
                        // the geofence state (effectiveInsideState carries the
                        // previous state forward for an unreliable reading), but
                        // it proves the employee's phone is alive, which a
                        // missing ping cannot.
                        forceCoarseFix();
                    }
                    // Drain independently of captures, so a queue that filled up
                    // before the network returned does not wait for a new fix.
                    PingUploader.flush(getApplicationContext());
                } catch (Throwable t) {
                    Log.e(TAG, "watchdog tick failed — tracking continues", t);
                } finally {
                    if (running && workerHandler != null) {
                        workerHandler.postDelayed(this, intervalMs);
                    }
                }
            }
        };
        workerHandler.postDelayed(watchdog, intervalMs);
    }

    /**
     * One-shot balanced-accuracy fix, used only when the high-accuracy stream
     * has gone silent. Best-effort: a failure here just means the next watchdog
     * tick tries again.
     */
    private void forceCoarseFix() {
        if (!hasLocationPermission()) return;
        try {
            CancellationTokenSource cts = new CancellationTokenSource();
            client.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, cts.getToken())
                .addOnSuccessListener(loc -> {
                    if (loc == null) return;
                    try {
                        lastFix = loc;
                        lastFixAt = System.currentTimeMillis();
                        enqueue(loc);
                        PingUploader.flush(getApplicationContext());
                        updateNotification();
                        Log.d(TAG, "forced coarse fix delivered");
                    } catch (Throwable t) {
                        Log.e(TAG, "forced fix handling failed", t);
                    }
                })
                .addOnFailureListener(e -> Log.w(TAG, "forced coarse fix failed", e));
        } catch (Throwable t) {
            Log.e(TAG, "could not request a forced fix", t);
        }
    }

    private void stopWatchdog() {
        if (watchdog != null && workerHandler != null) {
            workerHandler.removeCallbacks(watchdog);
        }
        watchdog = null;
    }

    /** Tear the location request down and build it again from scratch. */
    private void reArmUpdates() {
        try {
            if (callback != null) client.removeLocationUpdates(callback);
        } catch (Exception ignore) {
            // Already gone — rebuilding below is still the right move.
        }
        callback = null;
        try {
            requestUpdates();
        } catch (Throwable t) {
            Log.e(TAG, "could not re-arm location updates", t);
        }
    }

    private void stopTracking() {
        running = false;
        stopWatchdog();
        if (callback != null) {
            try { client.removeLocationUpdates(callback); } catch (Exception ignore) {}
            callback = null;
        }
        // One last attempt to deliver whatever is buffered, then hand anything
        // still queued to the geofence upload worker's retry path on next start.
        workerHandler.post(() -> PingUploader.flush(getApplicationContext()));
        stopForeground(true);
        stopSelf();
    }

    /**
     * The employee swiped the app away. The whole point of this service is that
     * this is NOT the end of tracking — record it so pings report appState
     * "killed", and keep going.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        appTaskRemoved = true;
        Log.d(TAG, "app task removed — tracking continues");
        updateNotification();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (callback != null) {
            try { client.removeLocationUpdates(callback); } catch (Exception ignore) {}
        }
        if (worker != null) worker.quitSafely();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- notification

    private Notification buildNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Attendance tracking", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while your location is being recorded for attendance.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = launch != null
                ? PendingIntent.getActivity(this, 0, launch, flags)
                : null;

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Attendance tracking active")
                .setContentText(text)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        if (pi != null) b.setContentIntent(pi);
        return b.build();
    }

    /**
     * A live notification is not decoration: it shows the employee that tracking
     * is genuinely working, which is both reassurance and the main reason they
     * stop swiping the app away.
     */
    private void updateNotification() {
        String text;
        if (lastFixAt == 0) {
            text = "Waiting for GPS…";
        } else {
            long agoSec = (System.currentTimeMillis() - lastFixAt) / 1000;
            int queued = PingQueue.size(this);
            text = "Updated " + (agoSec < 60 ? agoSec + "s" : (agoSec / 60) + "m") + " ago"
                    + (queued > 0 ? " · " + queued + " waiting to sync" : "");
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private static String iso(long epochMs) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(epochMs));
    }

    // ---------------------------------------------------------------- control

    static void start(Context ctx, long intervalMs, String deviceId) {
        Intent i = new Intent(ctx, LocationTrackingService.class);
        i.setAction(ACTION_START);
        i.putExtra(EXTRA_INTERVAL_MS, intervalMs);
        i.putExtra(EXTRA_DEVICE_ID, deviceId);
        // Persist so a restart (reboot, or Android recreating a sticky service)
        // can resume with the same configuration.
        SharedPreferences p = ctx.getSharedPreferences("TrackingConfig", Context.MODE_PRIVATE);
        p.edit().putLong("intervalMs", intervalMs).putString("deviceId", deviceId).apply();
        ContextCompat.startForegroundService(ctx, i);
    }

    static void stop(Context ctx) {
        Intent i = new Intent(ctx, LocationTrackingService.class);
        i.setAction(ACTION_STOP);
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (Exception e) {
            ctx.stopService(new Intent(ctx, LocationTrackingService.class));
        }
    }

    /** Resume with the last known configuration — used after a reboot. */
    static void restartFromSavedConfig(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences("TrackingConfig", Context.MODE_PRIVATE);
        start(ctx, p.getLong("intervalMs", DEFAULT_INTERVAL_MS), p.getString("deviceId", "android"));
    }
}
