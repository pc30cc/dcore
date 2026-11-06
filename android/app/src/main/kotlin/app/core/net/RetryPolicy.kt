package app.core.net

import kotlin.random.Random

/**
 * Whether sending a request twice can do something twice.
 *
 * The funnel retries only what cannot: a lost answer to a non-idempotent call
 * (a swipe, an OTP start that sends an SMS, a refresh that rotates the token,
 * a wallet spend) is reported, never resent, because the first one may well
 * have worked. Whoever called decides what to do next, with the whole picture.
 */
enum class Idempotency {
    /** A read. */
    SAFE,

    /** PUT, DELETE and PATCH with absolute values: the second has the first's effect. */
    IDEMPOTENT,

    /** A POST the server de-duplicates by a key in the body (a message's client id, a purchase token). */
    KEYED,

    /** Anything else. Never retried. */
    NONE,
    ;

    val retryable: Boolean get() = this != NONE
}

/**
 * How the funnel retries a retryable request that got no answer, or a gateway
 * failure (502, 503 without a reason the server chose, 504).
 *
 * Few and short: a request is tried [maxAttempts] times in all, the waits grow
 * from [baseDelayMs] and are jittered so phones that lost the same edge do not
 * come back in step. A 4xx, a 500, a 503 the server explained (maintenance,
 * an SMS or store outage) and a 429 are never retried here: retrying them
 * adds load and changes nothing. A `Retry-After` longer than
 * [maxRetryAfterMs] is the server asking for a pause this request will not
 * wait out.
 */
data class RetryPolicy(
    val maxAttempts: Int = 3,
    val baseDelayMs: Long = 400,
    val maxDelayMs: Long = 4_000,
    val maxRetryAfterMs: Long = 10_000,
) {
    init {
        require(maxAttempts >= 1) { "maxAttempts must be at least 1" }
    }

    /**
     * The wait before attempt [failedAttempts] + 1, or null when the request
     * should not be tried again.
     */
    fun delayBefore(failedAttempts: Int, retryAfterSeconds: Long?, random: Random): Long? {
        if (failedAttempts >= maxAttempts) return null
        if (retryAfterSeconds != null) {
            val asked = retryAfterSeconds * 1_000
            return if (asked in 0..maxRetryAfterMs) asked else null
        }
        val exponential = (baseDelayMs shl (failedAttempts - 1).coerceIn(0, 10)).coerceAtMost(maxDelayMs)
        return (exponential * (0.8 + random.nextDouble() * 0.4)).toLong()
    }

    companion object {
        /** No retries at all, for tests that count requests. */
        val NONE = RetryPolicy(maxAttempts = 1)
    }
}
