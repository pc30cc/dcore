package app.core.sync

import app.core.common.Diag
import app.core.model.EntitlementSource
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
import java.util.concurrent.atomic.AtomicLong

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

    /** Moves at every [clear]: a read that started before one belongs to the account that left. */
    private val cleared = AtomicLong(0)

    /** Moves at every [apply]: a view the server sent, never a [patch]. */
    private val applied = AtomicLong(0)

    /**
     * The [patch]es made while a read is in flight ([reading]), applied to its
     * answer too: the read may have begun before the change they show. Both
     * guarded by [patches] itself.
     */
    private val patches = mutableListOf<(Entitlements) -> Entitlements>()
    private var reading = false

    /** The known entitlements, read once if none are known yet. Null when that read failed. */
    suspend fun ensure(): Entitlements? = _entitlements.value ?: refresh()

    /** Reads them again (a purchase, a restore, the app coming back). Keeps the last copy on failure. */
    suspend fun refresh(): Entitlements? = lock.withLock {
        read(keepApplied = false)
        _entitlements.value
    }

    /**
     * [refresh] for a hint (another build's `entitlement` event). A view
     * [apply]ed while this read is in flight is kept: it was published after
     * the read began, so it is at least as new as what the read answers.
     *
     * True when the hint is settled: the server's answer is shown, or a view
     * at least as new is, or the account it was for has left. False when the
     * read failed: the hint still stands.
     */
    suspend fun reread(): Boolean = lock.withLock { read(keepApplied = true) }

    /** One read under [lock]; false when it failed. */
    private suspend fun read(keepApplied: Boolean): Boolean {
        val sinceCleared = cleared.get()
        val sinceApplied = applied.get()
        synchronized(patches) {
            patches.clear()
            reading = true
        }
        return try {
            val fetched = fetch().value
            synchronized(patches) {
                reading = false
                when {
                    cleared.get() != sinceCleared -> Unit
                    keepApplied && applied.get() != sinceApplied -> Unit
                    else -> _entitlements.value = patches.fold(fetched) { e, change -> change(e) }
                }
                patches.clear()
            }
            true
        } catch (e: CancellationException) {
            endRead()
            throw e
        } catch (e: ApiError) {
            endRead()
            diag.warn(AREA, "entitlements not read (${e.code ?: e.javaClass.simpleName})")
            false
        }
    }

    private fun endRead() = synchronized(patches) {
        reading = false
        patches.clear()
    }

    /** The quotas a swipe answer carried. Ignored until the entitlements themselves are known. */
    fun applyQuotas(quotas: Quotas) {
        _entitlements.update { it?.copy(quotas = quotas) }
    }

    /**
     * The server announced new entitlements (a purchase, renewal, refund,
     * grant or wallet change). The worker's `entitlement` events carry no
     * brand subscription link (it does not load the brand), so a value
     * without [Entitlements.manageUrl] keeps the one last read for the same
     * plan from the same store; [refresh] (`GET /v1/me/entitlements`) always
     * replaces it.
     */
    fun apply(entitlements: Entitlements) {
        applied.incrementAndGet()
        _entitlements.update { current -> entitlements.keepingManageUrlOf(current) }
    }

    /**
     * A change the app makes to the copy shown, from another answer of the
     * server (a boost's end). Not a view the server published, so a hint's
     * read in flight ([reread]) still takes the server's answer. Ignored until
     * the entitlements themselves are known.
     */
    fun patch(change: (Entitlements) -> Entitlements) = synchronized(patches) {
        if (reading) patches += change
        _entitlements.update { it?.let(change) }
    }

    /** Another account signed in, or nobody: a read still in flight is not kept. */
    fun clear() {
        cleared.incrementAndGet()
        _entitlements.value = null
    }

    private companion object {
        const val AREA = "Entitlements"
    }
}

/** This value, with [previous]'s subscription link when this one has none and both are the same plan from the same store. */
internal fun Entitlements.keepingManageUrlOf(previous: Entitlements?): Entitlements {
    if (manageUrl != null || previous?.manageUrl == null) return this
    val fromStore = source == EntitlementSource.Play || source == EntitlementSource.Bazaar
    return if (fromStore && source == previous.source && plan == previous.plan) copy(manageUrl = previous.manageUrl) else this
}
