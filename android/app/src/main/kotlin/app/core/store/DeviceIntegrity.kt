package app.core.store

/**
 * A store-signed statement that this is the genuine app on a genuine device,
 * for sign-up and other sensitive actions (on Play: Play Integrity).
 *
 * The token is opaque to the app: the server decodes and judges it. A missing
 * token is never a reason to block on the phone; the server decides what a
 * request without one may do.
 */
interface DeviceIntegrity {
    /**
     * A token bound to [requestHash], a hash (base64url SHA-256, at most 500
     * characters) of the request it protects, which the server checks.
     */
    suspend fun token(requestHash: String): IntegrityResult
}

sealed interface IntegrityResult {
    data class Token(val value: String) : IntegrityResult

    /** This store or build has no attestation (Cafe Bazaar; Play without a cloud project number). */
    data class Unsupported(val reason: String) : IntegrityResult

    data class Failed(val detail: String?) : IntegrityResult
}
