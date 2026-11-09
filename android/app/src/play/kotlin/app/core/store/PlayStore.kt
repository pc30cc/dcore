package app.core.store

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.core.net.toUri
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import com.google.android.gms.tasks.Task
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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

    override fun isOwnStoreLink(url: String): Boolean = runCatching {
        val uri = java.net.URI(url)
        uri.scheme == "https" && uri.host == PLAY_HOST
    }.getOrDefault(false)

    /**
     * Play's subscription centre, at [productId]'s subscription when it is
     * known (Google's documented deep link), opened in the Play Store app
     * when it is there.
     */
    fun subscriptionsUrl(packageName: String, productId: String?): String =
        if (productId.isNullOrBlank()) {
            SUBSCRIPTIONS_URL
        } else {
            "$SUBSCRIPTIONS_URL?sku=${java.net.URLEncoder.encode(productId, "UTF-8")}&package=${java.net.URLEncoder.encode(packageName, "UTF-8")}"
        }

    override fun openSubscriptions(activity: Activity, productId: String?, serverLink: String?): Boolean {
        val link = serverLink?.takeIf(::isOwnStoreLink) ?: subscriptionsUrl(activity.packageName, productId)
        val intent = Intent(Intent.ACTION_VIEW, link.toUri())
        return PackageChecks.start(activity, Intent(intent).setPackage(PLAY_STORE_PACKAGE)) || PackageChecks.start(activity, intent)
    }

    /** The Play Store comes with the phone; when it is missing there is nowhere to get it from. Its web page is the fallback. */
    override fun openStoreInstall(activity: Activity): Boolean =
        PackageChecks.start(activity, Intent(Intent.ACTION_VIEW, appPageWebUrl(activity.packageName).toUri()))

    private companion object {
        const val PLAY_HOST = "play.google.com"
        const val SUBSCRIPTIONS_URL = "https://play.google.com/store/account/subscriptions"
    }
}

/**
 * Play In-App Updates.
 *
 * The check, either flow, and the flexible flow's ending: while a flexible
 * update downloads, an install-state listener reports it; once downloaded,
 * [downloaded] says so and [completeFlexible] installs it (Play restarts the
 * app). An update downloaded in an earlier session is reported by the next
 * [check].
 */
internal class PlayUpdates(context: Context, private val diag: Diag) : AppUpdates {
    private val manager by lazy { AppUpdateManagerFactory.create(context.applicationContext) }

    private val _downloaded = MutableStateFlow(false)
    override val downloaded: StateFlow<Boolean> = _downloaded.asStateFlow()

    private val listener = InstallStateUpdatedListener { state ->
        when (state.installStatus()) {
            InstallStatus.DOWNLOADED -> _downloaded.value = true
            InstallStatus.INSTALLED, InstallStatus.FAILED, InstallStatus.CANCELED -> {
                _downloaded.value = false
                stopListening()
            }
            else -> Unit
        }
    }

    @Volatile private var listening = false

    private fun startListening() {
        if (listening) return
        listening = true
        runCatching { manager.registerListener(listener) }
    }

    private fun stopListening() {
        if (!listening) return
        listening = false
        runCatching { manager.unregisterListener(listener) }
    }

    override suspend fun completeFlexible(): Boolean =
        runCatchingUnlessCancelled { manager.completeUpdate().await() }.fold(
            onSuccess = { true },
            onFailure = { error ->
                diag.info(AREA, "completing the update failed: ${error.javaClass.simpleName}")
                false
            },
        )

    /** The answer [start] needs: Play starts a flow from the info object of the check, not from a version code. */
    @Volatile private var lastInfo: AppUpdateInfo? = null

    override suspend fun check(): UpdateCheck =
        runCatchingUnlessCancelled { manager.requestAppUpdateInfo() }.fold(
            onSuccess = { info ->
                lastInfo = info
                if (info.installStatus() == InstallStatus.DOWNLOADED) _downloaded.value = true
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
        if (mode == UpdateMode.FLEXIBLE) startListening()
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
