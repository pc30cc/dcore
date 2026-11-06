package app.core.store

import android.app.Activity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest

/**
 * Whether a newer version is out, and getting it.
 *
 * Only Google Play has an in-app update API. For Cafe Bazaar the check says
 * [UpdateCheck.Unsupported] and an update means opening the app's page in
 * Bazaar. Either way, a build too old to use is decided by the server
 * (`GET /v1/config`'s minimum version per store), not by the store.
 */
interface AppUpdates {
    suspend fun check(): UpdateCheck

    /**
     * Starts [update]. [launcher] receives the result of Play's update flow
     * (register it with `StartIntentSenderForResult`); other stores open their
     * app page instead. False when nothing could be started.
     */
    fun start(
        activity: Activity,
        launcher: ActivityResultLauncher<IntentSenderRequest>,
        update: UpdateCheck.Available,
        mode: UpdateMode,
    ): Boolean
}

enum class UpdateMode {
    /** Downloads in the background while the app is used, then asks to restart. */
    FLEXIBLE,

    /** Full screen until the update is installed. */
    IMMEDIATE,
}

sealed interface UpdateCheck {
    data object UpToDate : UpdateCheck

    data class Available(
        val versionCode: Int?,
        val flexibleAllowed: Boolean,
        val immediateAllowed: Boolean,
    ) : UpdateCheck

    /** The store cannot be asked from inside the app. [reason] is for logs, not for people. */
    data class Unsupported(val reason: String) : UpdateCheck

    data class Failed(val detail: String?) : UpdateCheck
}
