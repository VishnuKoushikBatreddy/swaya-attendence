package com.swaya.attendance;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/**
 * Retries queued geofence events once the device has connectivity again.
 *
 * WorkManager is used rather than a plain thread because the work must outlive
 * the broadcast, the process, and a reboot — the whole scenario this fixes is
 * "the app is dead and the network is down".
 */
public class GeofenceUploadWorker extends Worker {

    private static final String WORK_NAME = "geofence-upload";

    public GeofenceUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        boolean drained = GeofenceUploader.flush(getApplicationContext());
        // Result.retry() re-runs with the exponential backoff configured below;
        // anything still queued is preserved in order.
        return drained ? Result.success() : Result.retry();
    }

    /**
     * Queue a drain attempt for when the network is available.
     *
     * KEEP (not REPLACE) as the conflict policy: if an attempt is already
     * pending, adding a second event must not reset its backoff timer.
     */
    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(GeofenceUploadWorker.class)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();

        WorkManager.getInstance(context)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request);
    }
}
