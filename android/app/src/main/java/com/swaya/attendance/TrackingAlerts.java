package com.swaya.attendance;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Tells the employee when their phone has stopped the app from doing its job.
 *
 * WHY THIS EXISTS
 * ---------------
 * The tracking notification says "Attendance tracking active" on a LOW-priority
 * channel, and it keeps saying that when location services are switched off —
 * the service is genuinely still running, it just cannot get a fix. From the
 * employee's side the app looks fine and the shift records nothing. Turning
 * location off to save battery, or leaving a phone in aeroplane mode after a
 * flight, is ordinary behaviour that nobody connects to attendance.
 *
 * So this posts a SEPARATE, high-importance notification that names the setting
 * and opens it. Location off and internet off are reported differently on
 * purpose, because their consequences are not the same:
 *
 *   location off  — nothing is being captured. That time is lost for good and
 *                   will show up as offline time on the day.
 *   internet off  — capture continues and pings sit in PingQueue until the
 *                   network returns. Nothing is lost unless the queue overflows
 *                   or the day rolls over, so the wording is a heads-up rather
 *                   than an alarm.
 *
 * Alerts are also deliberately quiet about themselves: one notification per
 * distinct problem, after a grace period, repeated at most every 15 minutes.
 * An app that buzzes every 30 seconds in a lift gets its notifications turned
 * off, and then none of this works at all.
 */
final class TrackingAlerts {
    private static final String TAG = "TrackingAlerts";

    private static final String CHANNEL_ID = "attendance_alerts";
    private static final int NOTIFICATION_ID = 4802;

    static final int PROBLEM_NONE = 0;
    static final int PROBLEM_LOCATION = 1;
    static final int PROBLEM_INTERNET = 2;
    static final int PROBLEM_PERMISSION = 4;

    /**
     * How long a problem must persist before the employee hears about it.
     *
     * Connectivity flaps constantly — a lift, a tunnel, the moment a phone hands
     * over between cells — and none of that is worth a notification. It also
     * covers service start-up, where the network can briefly read as absent
     * before the radios have attached.
     */
    private static final long GRACE_MS = 60_000L;

    /**
     * How long before the same, still-unresolved problem is raised again. The
     * alert is dismissible (unlike the tracking notification), so without this a
     * swipe would silence a phone that goes on recording nothing all day.
     */
    private static final long REMIND_MS = 15 * 60_000L;

    /** The problem currently being timed, and when it was first seen. */
    private static int pendingProblem = PROBLEM_NONE;
    private static long problemSince = 0L;
    /** The problem the employee has actually been told about, and when. */
    private static int postedProblem = PROBLEM_NONE;
    private static long postedAt = 0L;

    private TrackingAlerts() {}

    // ------------------------------------------------------------- detection

    /**
     * Whether the device's location services are switched on at all.
     *
     * This is the master toggle, which is separate from this app's permission:
     * an employee can have granted everything and still be invisible because
     * the quick-settings tile is off.
     */
    static boolean isLocationEnabled(Context ctx) {
        try {
            LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
            // Unreadable: assume it is on. A false alarm trains people to ignore
            // the one that matters.
            if (lm == null) return true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return lm.isLocationEnabled();
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Throwable t) {
            Log.w(TAG, "could not read location state", t);
            return true;
        }
    }

    /** Whether there is any network the app could upload over. */
    static boolean hasInternet(Context ctx) {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network active = cm.getActiveNetwork();
                if (active == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                // INTERNET only, not VALIDATED: validation lags by a second or
                // two after connecting and would make every reconnection look
                // like an outage.
                return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            NetworkInfo info = cm.getActiveNetworkInfo();
            return info != null && info.isConnected();
        } catch (Throwable t) {
            Log.w(TAG, "could not read network state", t);
            return true;
        }
    }

    // -------------------------------------------------------------- decision

    /** What is currently wrong, as a bitmask. */
    static int detect(Context ctx, boolean hasLocationPermission) {
        int problem = PROBLEM_NONE;
        if (!hasLocationPermission) {
            // Report the permission, not the toggle: the toggle is irrelevant
            // while the app is not allowed to read location either way.
            problem |= PROBLEM_PERMISSION;
        } else if (!isLocationEnabled(ctx)) {
            problem |= PROBLEM_LOCATION;
        }
        if (!hasInternet(ctx)) problem |= PROBLEM_INTERNET;
        return problem;
    }

    /**
     * Called on the service's own heartbeat. Posts, updates or withdraws the
     * alert according to what is wrong right now.
     */
    static void evaluate(Context ctx, boolean hasLocationPermission) {
        evaluate(ctx, hasLocationPermission, false);
    }

    static synchronized void evaluate(Context ctx, boolean hasLocationPermission, boolean immediate) {
        int problem = detect(ctx, hasLocationPermission);
        long now = System.currentTimeMillis();

        if (problem == PROBLEM_NONE) {
            // Resolved — take the alert down rather than leaving a stale warning
            // in the shade for someone who has already fixed it.
            clear(ctx);
            return;
        }

        if (problem != pendingProblem) {
            pendingProblem = problem;
            problemSince = now;
        }
        if (!immediate && now - problemSince < GRACE_MS) return;
        // Already said, and not yet time to say it again.
        if (problem == postedProblem && now - postedAt < REMIND_MS) return;

        post(ctx, problem);
        postedProblem = problem;
        postedAt = now;
    }

    /** Post immediately, skipping the grace period. For one-off, certain faults. */
    static synchronized void alertNow(Context ctx, int problem) {
        if (problem == PROBLEM_NONE) return;
        pendingProblem = problem;
        problemSince = System.currentTimeMillis();
        post(ctx, problem);
        postedProblem = problem;
        postedAt = System.currentTimeMillis();
    }

    /** Withdraw any alert and forget the state — tracking stopped, or all is well. */
    static synchronized void clear(Context ctx) {
        pendingProblem = PROBLEM_NONE;
        problemSince = 0L;
        if (postedProblem == PROBLEM_NONE) return;
        postedProblem = PROBLEM_NONE;
        postedAt = 0L;
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
        } catch (Throwable t) {
            Log.w(TAG, "could not withdraw alert", t);
        }
    }

    /** Test/diagnostic seam — forget what has been posted without touching the shade. */
    static synchronized void resetState() {
        pendingProblem = PROBLEM_NONE;
        problemSince = 0L;
        postedProblem = PROBLEM_NONE;
        postedAt = 0L;
    }

    // ------------------------------------------------------------- rendering

    static String titleFor(int problem) {
        if ((problem & PROBLEM_PERMISSION) != 0) return "Allow location for attendance";
        boolean loc = (problem & PROBLEM_LOCATION) != 0;
        boolean net = (problem & PROBLEM_INTERNET) != 0;
        if (loc && net) return "Turn on location and internet";
        if (loc) return "Turn on location";
        return "No internet connection";
    }

    static String bodyFor(int problem) {
        if ((problem & PROBLEM_PERMISSION) != 0) {
            return "Attendance can't record your shift without location permission. Tap to allow it.";
        }
        boolean loc = (problem & PROBLEM_LOCATION) != 0;
        boolean net = (problem & PROBLEM_INTERNET) != 0;
        if (loc && net) {
            return "Your attendance isn't being recorded. The app needs location and internet "
                    + "to track your shift. Tap to turn location on.";
        }
        if (loc) {
            return "Your attendance isn't being recorded while location is off. "
                    + "This time will count as offline. Tap to turn it on.";
        }
        // Deliberately calmer: capture continues and the pings are queued.
        return "Your location is being saved on this phone and will sync when you're back online.";
    }

    private static void post(Context ctx, int problem) {
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannel(nm);

            String body = bodyFor(problem);
            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_warning)
                    .setContentTitle(titleFor(problem))
                    .setContentText(body)
                    // The text is a sentence or two — without this it is elided
                    // at the very point it explains what to do.
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setCategory(NotificationCompat.CATEGORY_ERROR)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    // Dismissible, unlike the tracking notification: this one is
                    // a message, not a statement that tracking is running.
                    .setAutoCancel(true);

            PendingIntent fix = fixIntent(ctx, problem);
            if (fix != null) b.setContentIntent(fix);
            nm.notify(NOTIFICATION_ID, b.build());
            Log.d(TAG, "alerted problem=" + problem);
        } catch (Throwable t) {
            // A failed warning must never take the tracking service with it.
            Log.e(TAG, "could not post alert", t);
        }
    }

    private static void ensureChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Attendance problems", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Warns you when location or internet is off and your shift can't be recorded.");
        ch.setShowBadge(true);
        nm.createNotificationChannel(ch);
    }

    /**
     * Where tapping the alert goes. Straight to the setting that is wrong —
     * "check your settings" is not an instruction anyone can follow quickly.
     */
    private static PendingIntent fixIntent(Context ctx, int problem) {
        Intent target;
        if ((problem & PROBLEM_PERMISSION) != 0) {
            target = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            target.setData(Uri.fromParts("package", ctx.getPackageName(), null));
        } else if ((problem & PROBLEM_LOCATION) != 0) {
            // Location leads even when the network is down too: it is the one
            // losing data, and the internet problem often fixes itself.
            target = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        } else {
            target = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
        }
        target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        // An activity that does not resolve would make the alert do nothing when
        // tapped; fall back to opening the app, which at least shows the banner.
        if (ctx.getPackageManager().resolveActivity(target, 0) == null) {
            target = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (target == null) return null;
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        try {
            return PendingIntent.getActivity(ctx, 1, target, flags);
        } catch (Throwable t) {
            Log.w(TAG, "could not build fix intent", t);
            return null;
        }
    }
}
