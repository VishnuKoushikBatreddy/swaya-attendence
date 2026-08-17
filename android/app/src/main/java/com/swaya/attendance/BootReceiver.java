package com.swaya.attendance;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * On device reboot, if the employee was checked in (flag stored by the web app
 * via @capacitor/preferences), post a notification prompting them to reopen the
 * app so location tracking resumes. Modern Android restricts silently launching
 * apps / foreground services from BOOT_COMPLETED, so a tap-to-resume prompt is
 * the reliable approach.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            return;
        }

        // Flush any geofence events stranded by the reboot FIRST — before the
        // checkedIn early-return below. A queued EXIT is precisely the case where
        // the flag is stale (the employee left, but the check-out never reached
        // the server), so gating the flush on it would strand the event forever.
        // WorkManager runs this off the main thread once there is connectivity.
        try {
            if (!GeofenceEventQueue.isEmpty(context.getApplicationContext())) {
                GeofenceUploadWorker.schedule(context.getApplicationContext());
            }
        } catch (Exception e) {
            Log.e("BootReceiver", "failed to schedule geofence flush", e);
        }

        // @capacitor/preferences stores values in the "CapacitorStorage" prefs file.
        SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String checkedIn = prefs.getString("checkedIn", "false");
        if (!"true".equals(checkedIn)) {
            return;
        }

        // Android drops geofences on reboot — re-register the site geofence so the
        // killed-app ENTER/EXIT fallback keeps working after a restart.
        reRegisterGeofence(context, prefs);

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }

        String channelId = "attendance_boot";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                channelId, "Attendance", NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(channel);
        }

        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(context, 0, launch, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Resume attendance tracking")
            .setContentText("Your phone restarted. Tap to reopen and resume location tracking.")
            .setAutoCancel(true)
            .setContentIntent(pi);

        nm.notify(1001, builder.build());
    }

    /** Re-add the site geofence after reboot from the config the web app stored. */
    private void reRegisterGeofence(Context context, SharedPreferences prefs) {
        String latS = prefs.getString("geofence_lat", null);
        String lngS = prefs.getString("geofence_lng", null);
        String radiusS = prefs.getString("geofence_radius", "100");
        if (latS == null || lngS == null) {
            return;
        }
        boolean hasFine = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean hasBackground = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(
                context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!hasFine || !hasBackground) {
            return;
        }
        try {
            GeofenceHelper.register(
                context,
                Double.parseDouble(latS),
                Double.parseDouble(lngS),
                Float.parseFloat(radiusS));
        } catch (Exception e) {
            Log.e("BootReceiver", "geofence re-register failed", e);
        }
    }
}
