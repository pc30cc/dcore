package app.core.net.origins

import app.core.common.Clock

/**
 * Which API host a request goes to, and what the app has learnt about each.
 *
 *  1. The accepted list's `hosts.api` in its order, starting with the last one
 *     that answered (sticky until it fails; a newly accepted list starts again
 *     at its own first host).
 *  2. A host that gave no answer, or an edge failure, is skipped for
 *     [badForMillis] (five minutes).
 *  3. When every listed host is skipped: the build's own API host.
 *  4. When that is skipped too: the host whose mark runs out first, so there is
 *     always somewhere to send the request.
 *
 * Only the listed hosts and the build's are ever handed out or [trusted].
 * Thread-safe.
 */
class HostBook(
    compiledApi: String,
    private val clock: Clock,
    private val badForMillis: Long = BAD_FOR_MS,
) {
    /** The build's API base (`domains.api`, or the `-P<store>.apiBaseUrl` override). */
    val compiled: String = compiledApi.trimEnd('/')

    private var listed: List<String> = emptyList()
    private var sticky: String? = null
    private val badUntil = HashMap<String, Long>()

    /** A newly accepted (or restored) list: its hosts, in its order. */
    @Synchronized
    fun adopt(api: List<String>) {
        listed = api.toList()
        sticky = null
    }

    @Synchronized
    fun listed(): List<String> = listed

    /** The listed hosts, sticky one first, then the build's (not listed twice). */
    @Synchronized
    fun order(): List<String> = buildList {
        sticky?.let(::add)
        listed.filterTo(this) { it != sticky }
        if (compiled !in listed) add(compiled)
    }

    @Synchronized
    fun isBad(base: String): Boolean = (badUntil[base] ?: 0L) > clock.nowMillis()

    /** The hosts worth trying now, best first; never empty. */
    @Synchronized
    fun candidates(): List<String> {
        val now = clock.nowMillis()
        badUntil.entries.removeAll { it.value <= now }
        val order = order()
        val good = order.filter { it !in badUntil }
        if (good.isNotEmpty()) return good
        return listOf(order.minBy { badUntil[it] ?: 0L })
    }

    @Synchronized
    fun trusted(base: String): Boolean = base == compiled || base in listed

    @Synchronized
    fun reached(base: String) {
        badUntil.remove(base)
        if (base in listed) sticky = base
    }

    @Synchronized
    fun failed(base: String) {
        badUntil[base] = clock.nowMillis() + badForMillis
        if (sticky == base) sticky = null
    }

    companion object {
        const val BAD_FOR_MS = 5 * 60_000L
    }
}
