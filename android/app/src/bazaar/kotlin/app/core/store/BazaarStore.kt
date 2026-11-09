package app.core.store

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.core.net.toUri

/** The Cafe Bazaar app's package. */
internal const val BAZAAR_PACKAGE = "com.farsitel.bazaar"

internal class BazaarStoreInfo : StoreInfo {
    override val store: Store = Store.BAZAAR
    override val storePackage: String = BAZAAR_PACKAGE

    override fun isStoreInstalled(context: Context): Boolean = PackageChecks.isInstalled(context, BAZAAR_PACKAGE)

    override fun installedByStore(context: Context): Boolean? = PackageChecks.installer(context)?.let { it == BAZAAR_PACKAGE }

    override fun appPageWebUrl(packageName: String): String = "https://cafebazaar.ir/app/$packageName"

    /** `bazaar://details?id=<package>` in the Bazaar app. */
    fun appPageIntent(packageName: String): Intent =
        Intent(Intent.ACTION_VIEW, "bazaar://details?id=$packageName".toUri()).setPackage(BAZAAR_PACKAGE)

    /** Bazaar's own "rate and review" screen for [packageName] (its documented `ACTION_EDIT` intent). */
    fun ratingIntent(packageName: String): Intent =
        Intent(Intent.ACTION_EDIT, "bazaar://details?id=$packageName".toUri()).setPackage(BAZAAR_PACKAGE)

    fun webIntent(packageName: String): Intent = Intent(Intent.ACTION_VIEW, appPageWebUrl(packageName).toUri())

    override fun openAppPage(activity: Activity): Boolean =
        PackageChecks.start(activity, appPageIntent(activity.packageName)) ||
            PackageChecks.start(activity, webIntent(activity.packageName))

    override fun isOwnStoreLink(url: String): Boolean = runCatching {
        val uri = java.net.URI(url)
        val host = uri.host.orEmpty()
        uri.scheme == BAZAAR_SCHEME || (uri.scheme == "https" && (host == BAZAAR_WEB_HOST || host.endsWith(".$BAZAAR_WEB_HOST")))
    }.getOrDefault(false)

    /**
     * Cafe Bazaar documents no link to its subscription list: the server's
     * link when the brand set one on Bazaar's own site, else this app's page
     * in Bazaar, where its subscription shows.
     */
    override fun openSubscriptions(activity: Activity, productId: String?, serverLink: String?): Boolean {
        val own = serverLink?.takeIf(::isOwnStoreLink)
        if (own != null) {
            val intent = Intent(Intent.ACTION_VIEW, own.toUri())
            if (PackageChecks.start(activity, Intent(intent).setPackage(BAZAAR_PACKAGE)) || PackageChecks.start(activity, intent)) return true
        }
        return openAppPage(activity)
    }

    /** Bazaar's own site, where the Bazaar app is downloaded. */
    override fun openStoreInstall(activity: Activity): Boolean =
        PackageChecks.start(activity, Intent(Intent.ACTION_VIEW, BAZAAR_HOME.toUri()))
}

private const val BAZAAR_SCHEME = "bazaar"
private const val BAZAAR_WEB_HOST = "cafebazaar.ir"
private const val BAZAAR_HOME = "https://cafebazaar.ir/"

/**
 * Cafe Bazaar offers apps no in-app update API, so there is nothing to check
 * from here: [check] says so, and [start] opens the app's page in Bazaar,
 * where its update button is. Forcing an update on a build that is too old is
 * the server's job (`GET /config`, minimum version for `bazaar`).
 */
internal class BazaarUpdates(private val info: BazaarStoreInfo) : AppUpdates {
    override suspend fun check(): UpdateCheck =
        UpdateCheck.Unsupported("Cafe Bazaar has no in-app update API; the server's minimum version decides")

    override fun start(
        activity: Activity,
        launcher: ActivityResultLauncher<IntentSenderRequest>,
        update: UpdateCheck.Available,
        mode: UpdateMode,
    ): Boolean = info.openAppPage(activity)
}

/** Bazaar's rating screen for this app, or its page on the web when the Bazaar app is missing. */
internal class BazaarRating(private val info: BazaarStoreInfo) : AppRating {
    override suspend fun requestRating(activity: Activity): RatingOutcome =
        when {
            PackageChecks.start(activity, info.ratingIntent(activity.packageName)) -> RatingOutcome.OpenedStore
            PackageChecks.start(activity, info.webIntent(activity.packageName)) -> RatingOutcome.OpenedStore
            else -> RatingOutcome.Unavailable("neither the Bazaar app nor a browser could open the app's page")
        }
}

/**
 * Cafe Bazaar has no device attestation comparable to Play Integrity. The
 * server treats Bazaar sign-ups without a token: phone verification and rate
 * limits carry the weight there.
 */
internal object BazaarIntegrity : DeviceIntegrity {
    override suspend fun token(requestHash: String): IntegrityResult =
        IntegrityResult.Unsupported("Cafe Bazaar has no device attestation API")
}
