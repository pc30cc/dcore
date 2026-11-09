package app.core.store

import android.app.Activity
import app.core.common.Clock
import app.core.storage.SecretStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * When the app may ask for a rating, by its own cap on top of each store's
 * rules: after a second match or a good call (three minutes or more), and at
 * most once every 120 days. The store's own way is used then: Play's review
 * sheet with no question before it (Play forbids "do you like the app?" and
 * may show nothing: its quota), Cafe Bazaar's rating screen behind a small
 * prompt, never opened by surprise.
 *
 * Plain values in the store, under fixed neutral names.
 */
class RatingPacing(private val store: SecretStore, private val clock: Clock) {
    private val lock = Mutex()

    suspend fun noteMatch() = lock.withLock {
        val matches = (store.read(MATCHES)?.toIntOrNull() ?: 0) + 1
        store.write(MATCHES, matches.coerceAtMost(MATCHES_CAP).toString())
    }

    suspend fun noteCall(seconds: Long) = lock.withLock {
        if (seconds >= GOOD_CALL_SECONDS) store.write(GOOD_CALL, "1")
    }

    /** Whether a rating may be asked for now. */
    suspend fun due(): Boolean = lock.withLock {
        val earned = (store.read(MATCHES)?.toIntOrNull() ?: 0) >= MATCHES_NEEDED || store.read(GOOD_CALL) == "1"
        if (!earned) return@withLock false
        val last = store.read(ASKED_AT)?.toLongOrNull() ?: return@withLock true
        clock.nowMillis() - last >= EVERY_MS
    }

    /** It was asked (whatever the person did): the next one waits 120 days and a new reason. */
    suspend fun asked() = lock.withLock {
        store.write(ASKED_AT, clock.nowMillis().toString())
        store.write(MATCHES, "0")
        store.remove(GOOD_CALL)
    }

    companion object {
        private const val MATCHES = "rating.matches"
        private const val GOOD_CALL = "rating.goodCall"
        private const val ASKED_AT = "rating.askedAt"
        const val MATCHES_NEEDED = 2
        private const val MATCHES_CAP = 100
        const val GOOD_CALL_SECONDS = 180L
        const val EVERY_MS = 120L * 24 * 3600 * 1000
    }
}

/**
 * How often a recommended (not required) update is suggested: at most once
 * every three days. A required one is the server's minimum and is not paced:
 * the app cannot be used below it.
 */
class UpdatePacing(private val store: SecretStore, private val clock: Clock) {
    suspend fun due(): Boolean {
        val last = store.read(ASKED_AT)?.toLongOrNull() ?: return true
        return clock.nowMillis() - last >= EVERY_MS
    }

    suspend fun asked() = store.write(ASKED_AT, clock.nowMillis().toString())

    companion object {
        private const val ASKED_AT = "update.suggestedAt"
        const val EVERY_MS = 3L * 24 * 3600 * 1000
    }
}

/**
 * The store's age signal, asked once per install where the store has one
 * (Play): only whether it said "under 18" and when it was asked are kept, on
 * the phone. A store without age signals costs nothing and stores nothing.
 */
class AgeSignalsCheck(private val signals: AgeSignals, private val store: SecretStore, private val clock: Clock) {
    private val lock = Mutex()

    /** True when the store says the person is under 18 (now or when it was asked on this install). */
    suspend fun minor(activity: Activity): Boolean = lock.withLock {
        store.read(MINOR)?.let { return@withLock it == "1" }
        when (val signal = signals.check(activity)) {
            AgeSignal.Minor, AgeSignal.Adult, AgeSignal.Unknown -> {
                val minor = signal == AgeSignal.Minor
                store.write(MINOR, if (minor) "1" else "0")
                store.write(CHECKED_AT, clock.nowMillis().toString())
                minor
            }
            // Asked again next time: nothing was learnt.
            AgeSignal.Unsupported, is AgeSignal.Failed -> false
        }
    }

    private companion object {
        const val MINOR = "age.signalMinor"
        const val CHECKED_AT = "age.signalCheckedAt"
    }
}
