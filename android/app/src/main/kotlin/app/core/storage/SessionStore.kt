package app.core.storage

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.AccountStatus
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.model.PublicUid
import app.core.model.TokenPair
import app.core.model.Wire
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import java.time.Instant

/**
 * The session's tokens, as one sealed value.
 *
 * Both tokens are written in ONE edit: refresh tokens rotate on every use, so
 * a new access token stored beside a stale refresh token (a crash between two
 * writes) would make the next refresh a reuse, which the server answers by
 * revoking the session.
 *
 * [accessDeadlineMillis] is on THIS phone's clock: the access token's
 * lifetime as the server counted it, added to the time the answer arrived.
 * A phone whose clock is hours off still refreshes when the token is about to
 * lapse, instead of on every request or never.
 */
@Serializable
data class StoredTokens(
    val access: String,
    val refresh: String,
    val accessDeadlineMillis: Long,
    val refreshExpiresAtMillis: Long? = null,
    /** When this pair arrived, on this phone's clock. */
    val receivedAtMillis: Long = 0,
)

/** The signed-in account, as far as this phone knows. Not a credential: its public id and state. */
@Serializable
data class SessionAccount(
    val id: PublicUid,
    val status: AccountStatus = AccountStatus.Unknown,
    val onboardingStep: Int = 0,
)

/** What the HTTP funnel needs from the session. */
interface TokenStore {
    suspend fun tokens(): StoredTokens?

    /** The account the session belongs to, for keys of personal cached answers. */
    suspend fun accountId(): PublicUid?

    /**
     * Stores [pair] in place of the session whose refresh token is
     * [previousRefresh]. False, and nothing stored, when the session has
     * changed meanwhile (signed out, or signed in again): a refresh that was
     * in flight must not bring a signed-out session back.
     */
    suspend fun rotate(previousRefresh: String, pair: TokenPair, receivedAtMillis: Long, serverDateMillis: Long?): Boolean

    /**
     * Forgets the session, if it is still the one whose refresh token is
     * [ifRefresh] (null: whichever it is). True when something was forgotten.
     */
    suspend fun clear(ifRefresh: String? = null): Boolean
}

/**
 * The signed-in session: tokens (sealed) and the account they belong to.
 *
 * Kept in memory after the first read, so the Keystore is not asked on every
 * request. The account is stored too, so a launch without a network still
 * knows who is signed in; every request that comes back 401 corrects that.
 */
class SessionStore(
    private val store: SecretStore,
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Android,
) : TokenStore {
    private companion object {
        const val AREA = "Session"
        const val TOKENS = "session.tokens"
        const val ACCOUNT = "session.account"

        /** No access token lives longer than this, whatever a clock says. */
        const val MAX_ACCESS_TTL_MS = 24L * 60 * 60 * 1000
    }

    private val lock = Mutex()
    private var loaded = false
    private var tokens: StoredTokens? = null
    private var account: SessionAccount? = null

    private suspend fun load() {
        if (loaded) return
        tokens = store.readSecret(TOKENS)?.let { raw ->
            runCatching { Wire.json.decodeFromString(StoredTokens.serializer(), raw) }
                .onFailure { diag.warn(AREA, "stored session no longer reads; signed out") }
                .getOrNull()
        }
        account = store.read(ACCOUNT)?.let { raw ->
            runCatching { Wire.json.decodeFromString(SessionAccount.serializer(), raw) }.getOrNull()
        }
        loaded = true
    }

    override suspend fun tokens(): StoredTokens? = lock.withLock {
        load()
        tokens
    }

    override suspend fun accountId(): PublicUid? = lock.withLock {
        load()
        account?.id
    }

    suspend fun account(): SessionAccount? = lock.withLock {
        load()
        account
    }

    suspend fun hasSession(): Boolean = tokens() != null

    /** Keeps a successful sign-in. [serverDateMillis] is the answer's `Date` header, when it had one. */
    suspend fun signIn(result: AuthResult, receivedAtMillis: Long = clock.nowMillis(), serverDateMillis: Long? = null) {
        lock.withLock {
            loaded = true
            val next = stored(result.tokens, receivedAtMillis, serverDateMillis)
            tokens = next
            account = SessionAccount(result.user.id, result.user.status, result.user.onboardingStep)
            persist()
        }
    }

    /** What `GET /v1/me` or a restore said about the account. Ignored for another account. */
    suspend fun updateAccount(user: AuthUser) {
        lock.withLock {
            load()
            if (tokens == null) return
            if (account != null && account?.id != user.id) {
                diag.warn(AREA, "an answer for another account was ignored")
                return
            }
            account = SessionAccount(user.id, user.status, user.onboardingStep)
            persist()
        }
    }

    override suspend fun rotate(
        previousRefresh: String,
        pair: TokenPair,
        receivedAtMillis: Long,
        serverDateMillis: Long?,
    ): Boolean = lock.withLock {
        load()
        if (tokens?.refresh != previousRefresh) return false
        tokens = stored(pair, receivedAtMillis, serverDateMillis)
        persist()
        true
    }

    override suspend fun clear(ifRefresh: String?): Boolean = lock.withLock {
        load()
        if (tokens == null && account == null) return false
        if (ifRefresh != null && tokens?.refresh != ifRefresh) return false
        tokens = null
        account = null
        store.writeSecret(TOKENS, null)
        store.remove(ACCOUNT)
        true
    }

    private suspend fun persist() {
        val current = tokens
        store.writeSecret(TOKENS, current?.let { Wire.json.encodeToString(StoredTokens.serializer(), it) })
        val who = account
        if (who == null) {
            store.remove(ACCOUNT)
        } else {
            store.write(ACCOUNT, Wire.json.encodeToString(SessionAccount.serializer(), who))
        }
    }

    private fun stored(pair: TokenPair, receivedAtMillis: Long, serverDateMillis: Long?) = StoredTokens(
        access = pair.accessToken,
        refresh = pair.refreshToken,
        accessDeadlineMillis = deadline(pair.accessExpiresAt, receivedAtMillis, serverDateMillis),
        refreshExpiresAtMillis = pair.refreshExpiresAt?.toEpochMilli(),
        receivedAtMillis = receivedAtMillis,
    )

    /**
     * The local time at which an access token expiring at [expiresAt] (server
     * time) lapses: its remaining lifetime as the server saw it
     * ([serverDateMillis], else this phone's clock), from [receivedAtMillis].
     */
    private fun deadline(expiresAt: Instant, receivedAtMillis: Long, serverDateMillis: Long?): Long {
        val ttl = (expiresAt.toEpochMilli() - (serverDateMillis ?: receivedAtMillis)).coerceIn(0, MAX_ACCESS_TTL_MS)
        return receivedAtMillis + ttl
    }
}
