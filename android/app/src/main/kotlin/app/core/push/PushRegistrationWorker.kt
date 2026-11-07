package app.core.push

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.core.appGraph
import java.util.concurrent.TimeUnit

/**
 * Registers this device again, once there is a network to do it on.
 *
 * What WorkManager is used for here, and nothing like polling: a one-off job
 * with a network constraint and exponential backoff. A token rotation can
 * arrive with the app closed and the phone offline; this is what makes it
 * land eventually, while the phone sleeps in between.
 */
class PushRegistrationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val reason = inputData.getString(KEY_REASON) ?: "retry"
        return when (applicationContext.appGraph.push.registrar.sync(reason)) {
            PushResult.RETRY_LATER -> if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.failure()
            else -> Result.success()
        }
    }

    companion object {
        /** A fixed neutral name: never derived from the brand. */
        private const val NAME = "push-registration"
        private const val KEY_REASON = "reason"
        private const val MAX_ATTEMPTS = 6

        /**
         * [replace] is for news (a new token), which starts a fresh attempt
         * now. A failure inside an attempt keeps the one already queued
         * rather than cancelling the worker that is reporting it.
         */
        fun enqueue(context: Context, reason: String, replace: Boolean = true) {
            val request = OneTimeWorkRequestBuilder<PushRegistrationWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setInputData(workDataOf(KEY_REASON to reason))
                .build()
            runCatching {
                WorkManager.getInstance(context).enqueueUniqueWork(
                    NAME,
                    if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                    request,
                )
            }
        }

        fun cancel(context: Context) {
            runCatching { WorkManager.getInstance(context).cancelUniqueWork(NAME) }
        }
    }
}
