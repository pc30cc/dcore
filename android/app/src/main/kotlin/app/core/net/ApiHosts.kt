package app.core.net

import java.io.IOException

/**
 * Where [ApiClient] sends requests: an ordered set of API bases (`https://host`
 * or `https://host:port`, no trailing slash) and what the funnel learns about
 * them as it goes.
 *
 * The real one follows the signed origins list ([app.core.net.origins.OriginsRepository]);
 * [fixed] is one base and nothing else (tests, and a build that lists no
 * origins keys behaves the same way).
 */
interface ApiHosts {
    /** The bases worth trying now, best first. Never empty. */
    suspend fun candidates(): List<String>

    /**
     * Whether the funnel may send anything to [base]: only a host the
     * accepted origins list or the build names. Nothing else ever carries a
     * session, a token or a request body.
     */
    fun trusted(base: String): Boolean

    /** [base] answered as the API does (any status that is not an edge failure). */
    fun reached(base: String)

    /** [base] gave no answer, or an edge answered for it (502, 503, 520-526 without a problem document). */
    fun failed(base: String)

    /**
     * Every candidate failed for one request: look for a newer origins list
     * (its published copies). True when the list changed, so the request can
     * start again on its hosts.
     */
    suspend fun recover(): Boolean

    companion object {
        /** One base, always trusted, never marked. */
        fun fixed(base: String): ApiHosts = Fixed(base.trimEnd('/'))
    }

    private class Fixed(private val base: String) : ApiHosts {
        private val only = listOf(base)

        override suspend fun candidates(): List<String> = only

        override fun trusted(base: String): Boolean = base == this.base

        override fun reached(base: String) = Unit

        override fun failed(base: String) = Unit

        override suspend fun recover(): Boolean = false
    }
}

/** A request the funnel refused to send: its host is in neither the origins list nor the build. Nothing left the phone. */
class UntrustedHostException : IOException("host is not in the origins list or the build")
