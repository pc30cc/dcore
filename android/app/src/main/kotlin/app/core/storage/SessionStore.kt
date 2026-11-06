package app.core.storage

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the API client needs from the session: the bearer token, if any. */
fun interface AccessTokenSource {
    suspend fun accessToken(): String?
}

/**
 * The signed-in session's tokens.
 *
 * The server's design is a short-lived access token (15 minutes) and
 * a rotating refresh token bound to the device. This holds both, encrypted;
 * the refresh itself (`POST /auth/refresh`) is not wired yet because the
 * server's auth endpoints do not exist yet, so an expired access token
 * currently means signing in again.
 *
 * The access token is kept in memory after the first read so the Keystore is
 * not asked on every request.
 */
class SessionStore(private val store: SecureStore) : AccessTokenSource {
    private companion object {
        const val ACCESS = "session.access"
        const val REFRESH = "session.refresh"
    }

    private val lock = Mutex()
    private var loaded = false
    private var access: String? = null

    override suspend fun accessToken(): String? = lock.withLock {
        if (!loaded) {
            access = store.readSecret(ACCESS)
            loaded = true
        }
        access
    }

    suspend fun hasSession(): Boolean = accessToken() != null || store.readSecret(REFRESH) != null

    /** Stores the tokens a successful sign-in or refresh returned. */
    suspend fun save(accessToken: String, refreshToken: String?) {
        lock.withLock {
            access = accessToken
            loaded = true
        }
        store.writeSecret(ACCESS, accessToken)
        store.writeSecret(REFRESH, refreshToken)
    }

    suspend fun clear() {
        lock.withLock {
            access = null
            loaded = true
        }
        store.writeSecret(ACCESS, null)
        store.writeSecret(REFRESH, null)
    }
}
