package app.core.sync

import app.core.common.Diag
import app.core.model.Entitlements
import app.core.model.Quotas
import app.core.net.ApiError
import app.core.net.Fetched
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * What the account may use right now (`GET /v1/me/entitlements`), as last
 * known. The server is the only authority: this only shows it, and every
 * quota is counted there.
 *
 * Read lazily: the first screen that needs it asks [ensure] (one request, a
 * 304 when nothing changed since the stored copy), and swipe answers keep the
 * quotas current without another read ([applyQuotas]).
 */
class EntitlementRepository(
    private val fetch: suspend () -> Fetched<Entitlements>,
    private val diag: Diag = Diag.Silent,
) {
    private val lock = Mutex()
    private val _entitlements = MutableStateFlow<Entitlements?>(null)
    val entitlements: StateFlow<Entitlements?> = _entitlements.asStateFlow()

    /** The known entitlements, read once if none are known yet. Null when that read failed. */
    suspend fun ensure(): Entitlements? = _entitlements.value ?: refresh()

    /** Reads them again (a purchase, a restore, the app coming back). Keeps the last copy on failure. */
    suspend fun refresh(): Entitlements? = lock.withLock {
        try {
            fetch().value.also { _entitlements.value = it }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            diag.warn(AREA, "entitlements not read (${e.code ?: e.javaClass.simpleName})")
            _entitlements.value
        }
    }

    /** The quotas a swipe answer carried. Ignored until the entitlements themselves are known. */
    fun applyQuotas(quotas: Quotas) {
        _entitlements.update { it?.copy(quotas = quotas) }
    }

    /** Another account signed in. */
    fun clear() {
        _entitlements.value = null
    }

    private companion object {
        const val AREA = "Entitlements"
    }
}
