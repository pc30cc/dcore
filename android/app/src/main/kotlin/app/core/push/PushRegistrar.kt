package app.core.push

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.DeviceUpdate
import app.core.model.PublicUid
import app.core.net.ApiError
import app.core.net.ServerApi
import app.core.storage.SecretStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.MessageDigest

/** What the registrar keeps between launches: plain values, never the token itself. */
interface PushState {
    /** A digest of the last registration the server accepted, and when. */
    suspend fun lastRegistration(): Pair<String, Long>?
    suspend fun setLastRegistration(fingerprint: String?, at: Long)

    /** Who the phone is registered for, so a background token rotation can register again without the UI. */
    suspend fun account(): PublicUid?
    suspend fun setAccount(account: PublicUid?)
}

/** [PushState] in the app's key-value store, under fixed neutral names. */
class StoredPushState(private val store: SecretStore) : PushState {
    override suspend fun lastRegistration(): Pair<String, Long>? {
        val raw = store.read(LAST) ?: return null
        val fingerprint = raw.substringBefore('@').takeIf { it.isNotEmpty() } ?: return null
        val at = raw.substringAfter('@', "").toLongOrNull() ?: return null
        return fingerprint to at
    }

    override suspend fun setLastRegistration(fingerprint: String?, at: Long) {
        if (fingerprint == null) store.remove(LAST) else store.write(LAST, "$fingerprint@$at")
    }

    override suspend fun account(): PublicUid? = store.read(ACCOUNT)?.takeIf { it.isNotBlank() }

    override suspend fun setAccount(account: PublicUid?) {
        if (account == null) store.remove(ACCOUNT) else store.write(ACCOUNT, account)
    }

    private companion object {
        const val LAST = "push.lastRegistration"
        const val ACCOUNT = "push.account"
    }
}

/** What a registration found; for the log and the tests. */
enum class PushResult { REGISTERED, UNCHANGED, SIGNED_OUT, RETRY_LATER }

/**
 * This phone's push registration (`PUT /v1/devices/current`), kept true and
 * sent only when it changes.
 *
 * The registration is the token (null on a phone without Google Play
 * services: the server then knows not to try), whether the person allows
 * notifications, the app version and the language the server writes push
 * texts in. Its SHA-256 fingerprint, with the account, is what "changed" is
 * measured against: the same registration is sent again only after
 * [REFRESH_MS] (weekly), which keeps the server's row fresh and costs nothing
 * in between. Calling [sync] on every return to the front is therefore free.
 *
 * Sign-out clears the token on the server while the session still exists,
 * then deletes it here, so one person's notifications cannot reach the next
 * person on the same phone.
 */
class PushRegistrar(
    private val api: ServerApi,
    private val transport: PushTransport,
    private val state: PushState,
    private val notificationsEnabled: () -> Boolean,
    private val appVersion: String,
    private val locale: () -> String,
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Android,
    /** Hands a failed registration to WorkManager, to try again once there is a network. */
    private val scheduleRetry: () -> Unit = {},
) {
    private val lock = Mutex()

    /** Signed in (or the account changed): register for it. Null when nobody is. */
    suspend fun bind(account: PublicUid?, reason: String): PushResult {
        if (state.account() != account) {
            state.setAccount(account)
            state.setLastRegistration(null, clock.nowMillis())
        }
        return sync(reason)
    }

    /**
     * Brings the server's view of this device in line with the phone's.
     * Safe to call as often as anything may have changed.
     */
    suspend fun sync(reason: String): PushResult = lock.withLock {
        val account = state.account() ?: return@withLock PushResult.SIGNED_OUT
        val availability = transport.availability()
        val token = if (availability == PushAvailability.AVAILABLE) {
            try {
                transport.token()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                diag.warn(AREA, "no push token yet: ${e.javaClass.simpleName}")
                scheduleRetry()
                return@withLock PushResult.RETRY_LATER
            }
        } else {
            null
        }
        val update = DeviceUpdate(
            pushToken = token,
            notificationsEnabled = notificationsEnabled(),
            appVersion = appVersion,
            locale = locale(),
        )
        val fingerprint = fingerprint(account, update)
        val last = state.lastRegistration()
        if (last != null && last.first == fingerprint && clock.nowMillis() - last.second < REFRESH_MS) {
            return@withLock PushResult.UNCHANGED
        }
        try {
            api.updateDevice(update)
            state.setLastRegistration(fingerprint, clock.nowMillis())
            // The token is never logged; its digest's first characters tell
            // two registrations apart in a field report.
            diag.info(AREA, "registered ($reason, ${availability.name.lowercase()}), #${fingerprint.take(6)}")
            PushResult.REGISTERED
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError.Unauthorized) {
            PushResult.SIGNED_OUT
        } catch (e: ApiError) {
            diag.warn(AREA, "registration failed ($reason): ${e.code ?: e.javaClass.simpleName}")
            scheduleRetry()
            PushResult.RETRY_LATER
        }
    }

    /** FCM handed out a new token: the next sync registers it. */
    suspend fun onNewToken(): PushResult = sync("token rotated")

    /**
     * Before the session is revoked: the server forgets this device's token.
     * Best effort: a phone offline at sign-out still deletes the token
     * afterwards ([afterSignOut]), which is what actually stops delivery.
     */
    suspend fun beforeSignOut() {
        lock.withLock {
            if (state.account() == null) return@withLock
            val cleared = try {
                api.updateDevice(DeviceUpdate(pushToken = null, notificationsEnabled = false, appVersion = appVersion, locale = locale()))
                true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                false
            }
            // Forgotten now, not only after: if the sign-out then fails, the
            // person is still signed in and the next sync must register again.
            state.setLastRegistration(null, clock.nowMillis())
            diag.info(AREA, "sign-out: token ${if (cleared) "cleared on the server" else "not cleared on the server"}")
        }
    }

    /** After the session is gone: forget who this phone was registered for, and the token. */
    suspend fun afterSignOut() {
        lock.withLock {
            state.setAccount(null)
            state.setLastRegistration(null, clock.nowMillis())
        }
        try {
            transport.deleteToken()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            diag.warn(AREA, "sign-out: token delete failed: ${e.javaClass.simpleName}")
        }
    }

    private fun fingerprint(account: PublicUid, update: DeviceUpdate): String {
        val text = listOf(account, update.pushToken ?: "-", update.notificationsEnabled.toString(), update.appVersion, update.locale)
            .joinToString("|")
        return MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val AREA = "Push"

        /** How long an unchanged registration stands before it is sent again. */
        const val REFRESH_MS = 7L * 24 * 60 * 60 * 1000
    }
}
