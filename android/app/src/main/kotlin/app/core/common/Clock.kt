package app.core.common

import java.time.Instant

/**
 * The wall clock, behind an interface so time-driven rules (token refresh,
 * ring expiry, backoff) are tested with a clock the test moves.
 */
fun interface Clock {
    /** Milliseconds since the epoch. */
    fun nowMillis(): Long

    fun now(): Instant = Instant.ofEpochMilli(nowMillis())

    object System : Clock {
        override fun nowMillis(): Long = java.lang.System.currentTimeMillis()
    }
}

/** A clock a test sets and advances. */
class FakeClock(var millis: Long = 1_762_420_443_120L) : Clock {
    override fun nowMillis(): Long = millis

    fun advance(byMillis: Long) {
        millis += byMillis
    }
}
