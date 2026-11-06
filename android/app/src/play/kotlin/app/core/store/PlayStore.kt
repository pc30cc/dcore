package app.core.store

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.core.net.toUri
import app.core.diag.Diag
import app.core.diag.runCatchingUnlessCancelled
import com.google.android.gms.tasks.Task
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import com.google.android.play.core.ktx.isFlexibleUpdateAllowed
import com.google.android.play.core.ktx.isImmediateUpdateAllowed
import com.google.android.play.core.ktx.launchReview
import com.google.android.play.core.ktx.requestAppUpdateInfo
import com.google.android.play.core.ktx.requestReview
import com.google.android.play.core.review.ReviewManagerFactory
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The Play Store app's package. */
internal const val PLAY_STORE_PACKAGE = "com.android.vending"

internal class PlayStoreInfo : StoreInfo {
    override val store: Store = Store.PLAY
    override val storePackage: String = PLAY_STORE_PACKAGE

    override fun isStoreInstalled(context: Context): Boolean = PackageChecks.isInstalled(context, PLAY_STORE_PACKAGE)

    override fun installedByStore(context: Context): Boolean? = PackageChecks.installer(context)?.let { it == PLAY_STORE_PACKAGE }

    override fun appPageWebUrl(packageName: String): String = "https://play.google.com/store/apps/details?id=$packageName"

    fun appPageIntent(packageName: String): Intent =
        Intent(Intent.ACTION_VIEW, "market://details?id=$packageName".toUri()).setPackage(PLAY_STORE_PACKAGE)

    override fun openAppPage(activity: Activity): Boolean =
        PackageChecks.start(activity, appPageIntent(activity.packageName)) ||
            PackageChecks.start(activity, Intent(Intent.ACTION_VIEW, appPageWebUrl(activity.packageName).toUri()))
}

/**
 * Play In-App Updates.
 *
 * Implemented: the check and starting either flow. NOT implemented yet: the
 * flexible flow's ending. A flexible update downloads in the background and
 * then needs `completeUpdate()` behind a "restart to install" prompt, driven
 * by an install-state listener; until that is built, use [UpdateMode.IMMEDIATE].
 */
internal class PlayUpdates(context: Context, private val diag: Diag) : AppUpdates {
    private val manager by lazy { AppUpdateManagerFactory.create(context.applicationContext) }

    /** The answer [start] needs: Play starts a flow from the info object of the check, not from a version code. */
    @Volatile private var lastInfo: AppUpdateInfo? = null

    override suspend fun check(): UpdateCheck =
        runCatchingUnlessCancelled { manager.requestAppUpdateInfo() }.fold(
            onSuccess = { info ->
                lastInfo = info
                when (info.updateAvailability()) {
                    UpdateAvailability.UPDATE_AVAILABLE,
                    UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS,
                    -> UpdateCheck.Available(info.availableVersionCode(), info.isFlexibleUpdateAllowed, info.isImmediateUpdateAllowed)
                    UpdateAvailability.UPDATE_NOT_AVAILABLE -> UpdateCheck.UpToDate
                    else -> UpdateCheck.Failed("availability unknown")
                }
            },
            onFailure = { error ->
                diag.info(AREA, "update check failed: ${error.javaClass.simpleName}")
                UpdateCheck.Failed(error.javaClass.simpleName)
            },
        )

    override fun start(
        activity: Activity,
        launcher: ActivityResultLauncher<IntentSenderRequest>,
        update: UpdateCheck.Available,
        mode: UpdateMode,
    ): Boolean {
        val info = lastInfo ?: return false
        val type = when (mode) {
            UpdateMode.FLEXIBLE -> AppUpdateType.FLEXIBLE
            UpdateMode.IMMEDIATE -> AppUpdateType.IMMEDIATE
        }
        if (!info.isUpdateTypeAllowed(type)) return false
        return runCatching {
            manager.startUpdateFlowForResult(info, launcher, AppUpdateOptions.newBuilder(type).build())
        }.getOrElse { error ->
            diag.info(AREA, "update flow did not start: ${error.javaClass.simpleName}")
            false
        }
    }

    private companion object {
        const val AREA = "Updates"
    }
}

/** Play's in-app review sheet. Play decides whether it actually appears (quota) and never says. */
internal class PlayRating(context: Context, private val diag: Diag) : AppRating {
    private val manager by lazy { ReviewManagerFactory.create(context.applicationContext) }

    override suspend fun requestRating(activity: Activity): RatingOutcome =
        runCatchingUnlessCancelled {
            val info = manager.requestReview()
            manager.launchReview(activity, info)
        }.fold(
            onSuccess = { RatingOutcome.FlowFinished },
            onFailure = { error ->
                diag.info("Rating", "review flow unavailable: ${error.javaClass.simpleName}")
                RatingOutcome.Unavailable(error.javaClass.simpleName)
            },
        )
}

/**
 * Play Integrity, standard requests.
 *
 * The token provider is prepared once (it is the slow step, a warm-up Google
 * recommends doing ahead of the first request) and reused; a failed request
 * drops it so the next one prepares afresh. Needs the Google Cloud project
 * number linked in Play Console (`-Pplay.cloudProjectNumber`); without it the
 * answer is [IntegrityResult.Unsupported], and the server decides what an
 * unattested request may do.
 */
internal class PlayIntegrity(
    context: Context,
    private val cloudProjectNumber: Long,
    private val diag: Diag,
) : DeviceIntegrity {
    private val manager by lazy { IntegrityManagerFactory.createStandard(context.applicationContext) }
    private val lock = Mutex()
    private var provider: StandardIntegrityTokenProvider? = null

    override suspend fun token(requestHash: String): IntegrityResult {
        if (cloudProjectNumber <= 0L) {
            return IntegrityResult.Unsupported("no Google Cloud project number in this build (-Pplay.cloudProjectNumber)")
        }
        return runCatchingUnlessCancelled {
            val ready = lock.withLock {
                provider ?: manager.prepareIntegrityToken(
                    PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(cloudProjectNumber).build(),
                ).await().also { provider = it }
            }
            ready.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()).await().token()
        }.fold(
            onSuccess = { IntegrityResult.Token(it) },
            onFailure = { error ->
                lock.withLock { provider = null }
                diag.info("Integrity", "token failed: ${error.javaClass.simpleName}")
                IntegrityResult.Failed(error.javaClass.simpleName)
            },
        )
    }
}

/** A Play services [Task] as a suspension. */
internal suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        if (!continuation.isActive) return@addOnCompleteListener
        val error = task.exception
        when {
            error != null -> continuation.resumeWithException(error)
            task.isCanceled -> continuation.cancel()
            else -> continuation.resume(task.result)
        }
    }
}
