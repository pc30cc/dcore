package app.core.push

import android.content.Context
import androidx.core.content.edit
import app.core.BuildConfig
import app.core.common.Diag
import app.core.model.FirebaseClient
import app.core.model.Wire
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The four public values a Firebase app is started with (no `google-services.json`). */
@Serializable
data class FirebaseClientConfig(
    val appId: String = "",
    val apiKey: String = "",
    val projectId: String = "",
    val senderId: String = "",
) {
    val isComplete: Boolean get() = appId.isNotBlank() && apiKey.isNotBlank() && projectId.isNotBlank() && senderId.isNotBlank()

    companion object {
        /** The server's copy (`GET /v1/config`, `push.firebase`). */
        fun of(client: FirebaseClient): FirebaseClientConfig =
            FirebaseClientConfig(appId = client.appId.trim(), apiKey = client.apiKey.trim(), projectId = client.projectId.trim(), senderId = client.projectNumber.trim())
    }
}

/**
 * Firebase, configured from the build or from the server rather than from a
 * committed file.
 *
 * The four values come from the store's block of `brand.json` (or
 * `-P<store>.firebase.*`), which wins; or from the server's config, kept for
 * the next cold start (often one a push itself causes, before any screen has
 * asked the server anything). None of the four is a credential: they ship in
 * every APK made with them. The key that sends lives on the server only.
 *
 * Only Firebase Messaging is used: no analytics, no crash reporting.
 */
object PushConfig {

    val fromBuild: FirebaseClientConfig?
        get() = FirebaseClientConfig(
            appId = BuildConfig.FIREBASE_APP_ID,
            apiKey = BuildConfig.FIREBASE_API_KEY,
            projectId = BuildConfig.FIREBASE_PROJECT_ID,
            senderId = BuildConfig.FIREBASE_SENDER_ID,
        ).takeIf { it.isComplete }

    fun isReady(context: Context): Boolean =
        runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)

    /**
     * Starts the default Firebase app with the build's project, else the one
     * the server last sent; false (push stays off) when there is neither.
     * Cheap: no network, no token; the token is asked for only once somebody
     * signs in.
     */
    fun initialize(context: Context, diag: Diag = Diag.Android): Boolean {
        if (isReady(context)) return true
        val config = choose(fromBuild, stored(context)) ?: return false
        return start(context, config, diag)
    }

    /**
     * The server's project, as its config gave it. Kept for every launch
     * after; true when it just started Firebase (nothing was running), so
     * the caller registers now rather than at the next launch. A different
     * project takes effect at the next launch: Firebase cannot be restarted
     * with other options in a running process.
     */
    fun adopt(context: Context, incoming: FirebaseClientConfig?, diag: Diag = Diag.Android): Boolean {
        if (fromBuild != null) return false
        val config = incoming?.takeIf { it.isComplete } ?: return false
        if (config != stored(context)) save(context, config)
        if (isReady(context)) return false
        return start(context, config, diag)
    }

    fun choose(build: FirebaseClientConfig?, stored: FirebaseClientConfig?): FirebaseClientConfig? =
        build?.takeIf { it.isComplete } ?: stored?.takeIf { it.isComplete }

    private fun start(context: Context, config: FirebaseClientConfig, diag: Diag): Boolean = runCatching {
        if (FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(
                context,
                FirebaseOptions.Builder()
                    .setApplicationId(config.appId)
                    .setApiKey(config.apiKey)
                    .setProjectId(config.projectId)
                    .setGcmSenderId(config.senderId)
                    .build(),
            )
        }
        true
    }.getOrElse {
        diag.warn(AREA, "Firebase could not start: ${it.javaClass.simpleName}")
        false
    }

    // Plain preferences, read synchronously: Application.onCreate needs them
    // before a push that woke the process is handed over. Not credentials,
    // and not the person's data, so they outlive a sign-out.
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun stored(context: Context): FirebaseClientConfig? = runCatching {
        prefs(context).getString(KEY, null)?.let { Wire.json.decodeFromString(FirebaseClientConfig.serializer(), it) }
    }.getOrNull()

    private fun save(context: Context, config: FirebaseClientConfig) {
        prefs(context).edit { putString(KEY, Wire.json.encodeToString(FirebaseClientConfig.serializer(), config)) }
    }

    /** A fixed neutral name, never derived from the brand. */
    private const val PREFS = "push.firebase"
    private const val KEY = "client"
    private const val AREA = "Push"
}

/**
 * FCM behind [PushTransport]. The only Play services call made directly is
 * [GoogleApiAvailabilityLight.isGooglePlayServicesAvailable]: when it says no,
 * the app falls back silently (no dialog: the resolution dialogs open the
 * Play Store, which a Cafe Bazaar build must never do).
 */
class FirebasePush(
    private val context: Context,
    private val diag: Diag = Diag.Android,
) : PushTransport {

    override fun availability(): PushAvailability {
        val services = runCatching { GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) }
            .getOrDefault(ConnectionResult.SERVICE_MISSING)
        if (services != ConnectionResult.SUCCESS) return PushAvailability.NO_PLAY_SERVICES
        return if (PushConfig.initialize(context, diag)) PushAvailability.AVAILABLE else PushAvailability.NOT_CONFIGURED
    }

    // FCM 25.1 marks getToken/deleteToken deprecated in favour of
    // register()/unregister() with the token delivered to the service's
    // onRegistered callback. The old calls still work and keep one source for
    // the token here; the service listens to both callbacks.
    @Suppress("DEPRECATION")
    override suspend fun token(): String? {
        if (availability() != PushAvailability.AVAILABLE) return null
        val messaging = FirebaseMessaging.getInstance()
        // Auto-init is off in the manifest, so no token exists before the
        // first sign-in; asking for one is what turns it on.
        messaging.isAutoInitEnabled = true
        return messaging.token.await()
    }

    @Suppress("DEPRECATION")
    override suspend fun deleteToken() {
        if (!PushConfig.isReady(context)) return
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = false
        messaging.deleteToken().await()
    }
}

/** A Play services task, awaited without another artifact for two calls. */
internal suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        if (task.isSuccessful) {
            @Suppress("UNCHECKED_CAST")
            continuation.resume(task.result as T)
        } else {
            continuation.resumeWithException(task.exception ?: IllegalStateException("task failed"))
        }
    }
}
