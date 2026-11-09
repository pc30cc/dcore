package app.core.store

import android.app.Activity

/**
 * The store's own signal of the person's age band, where the store has one
 * (Google Play's Age Signals, a beta API). It never replaces the app's own
 * date-of-birth gate: it can only add a refusal.
 *
 * Its terms allow it only for age-appropriate experiences required by law,
 * never for profiling: the app keeps one boolean and the date it was asked,
 * nothing else ([AgeSignalsCheck]).
 */
interface AgeSignals {
    suspend fun check(activity: Activity): AgeSignal

    object None : AgeSignals {
        override suspend fun check(activity: Activity): AgeSignal = AgeSignal.Unsupported
    }
}

sealed interface AgeSignal {
    /** The store says the person is 18 or older. */
    data object Adult : AgeSignal

    /** The store says the person is under 18. */
    data object Minor : AgeSignal

    /** The store has no age for this person (outside the regions it covers, not shared). */
    data object Unknown : AgeSignal

    /** This store or build has no age signals (Cafe Bazaar). */
    data object Unsupported : AgeSignal

    data class Failed(val detail: String?) : AgeSignal
}
