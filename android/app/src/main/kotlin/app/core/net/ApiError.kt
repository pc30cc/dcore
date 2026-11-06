package app.core.net

import app.core.model.Problem
import app.core.model.ProblemCodes

/**
 * Every way a request can fail, in the terms a screen needs to react.
 *
 * The distinction that matters most is [Unauthorized] against [Network]: the
 * first means the session is over and the person must sign in again; the
 * second means the app could not ask. Treating a dropped connection as a
 * sign-out would throw away a good session every time somebody walks into a
 * lift.
 */
sealed class ApiError(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** The server's machine-readable reason, when it sent one. */
    abstract val code: String?

    /** No answer: no connection, DNS, TLS, a timeout. */
    class Network(cause: Throwable) : ApiError("network: ${cause.javaClass.simpleName}", cause) {
        override val code: String? get() = null
    }

    /**
     * The session is over: no session to send, or the server refused it and
     * a refresh could not renew it (revoked, reused, expired). The app signs
     * out.
     */
    class Unauthorized(val problem: Problem?) : ApiError("unauthorized${problem?.code?.let { ": $it" } ?: ""}") {
        override val code: String? get() = problem?.code
    }

    /** Any other failure status, with the server's problem document. */
    class Http(val status: Int, val problem: Problem) : ApiError("http $status${problem.code?.let { ": $it" } ?: ""}") {
        override val code: String? get() = problem.code

        /** Banned, suspended or deleted: the session works, the account may not do this. */
        val isAccountState: Boolean get() = status == 403 && code in ProblemCodes.ACCOUNT_STATE

        val isUpgradeRequired: Boolean get() = status == 426
        val isMaintenance: Boolean get() = status == 503 && code == ProblemCodes.MAINTENANCE
    }

    /** The server answered, but not in a shape this build understands. */
    class Decoding(cause: Throwable) : ApiError("decoding: ${cause.javaClass.simpleName}", cause) {
        override val code: String? get() = null
    }
}
