package app.core.billing

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.core.appGraph
import java.util.concurrent.TimeUnit

/**
 * Sends the purchases the store took and the server has not answered for,
 * once there is a network: a one-off job with a network constraint and
 * exponential backoff, so a purchase made just before the network or the
 * app went away reaches the server while the phone sleeps. No polling: it
 * exists only while something waits.
 */
class PurchaseSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val left = applicationContext.appGraph.purchases.flushNow()
        return when {
            left == 0 -> Result.success()
            runAttemptCount < MAX_ATTEMPTS -> Result.retry()
            // The next launch, the network coming back or the paywall sends it again.
            else -> Result.failure()
        }
    }

    companion object {
        /** A fixed neutral name: never derived from the brand. */
        private const val NAME = "purchase-sync"
        private const val MAX_ATTEMPTS = 10

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<PurchaseSyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            runCatching { WorkManager.getInstance(context).enqueueUniqueWork(NAME, ExistingWorkPolicy.KEEP, request) }
        }
    }
}
