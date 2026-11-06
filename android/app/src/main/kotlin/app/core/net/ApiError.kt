package app.core.net

/**
 * Why a request did not produce its answer.
 *
 * Screens show [Network] as "offline, try again", [Http] by its [Http.code]
 * (the server's machine-readable reason, when it sent one), and treat
 * [Unauthorized] as the end of the session.
 */
sealed class ApiError(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** No answer: no connection, DNS, TLS, a timeout. */
    class Network(cause: Throwable) : ApiError("network: ${cause.javaClass.simpleName}", cause)

    /** 401: the access token is missing, expired or revoked. */
    class Unauthorized(val code: String?) : ApiError("unauthorized${code?.let { ": $it" } ?: ""}")

    /** Any other non-success status. [code] is the server's error code from the body, if it sent one. */
    class Http(val status: Int, val code: String?) : ApiError("http $status${code?.let { ": $it" } ?: ""}")

    /** The server answered, but not in the shape this build expects. */
    class Decoding(cause: Throwable) : ApiError("decoding: ${cause.javaClass.simpleName}", cause)
}
