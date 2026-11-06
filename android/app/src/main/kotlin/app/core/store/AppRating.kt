package app.core.store

import android.app.Activity

/**
 * Asking for a rating, the way each store allows.
 *
 * Google Play: the in-app review sheet, which Play may decline to show (it
 * has a quota) and never says whether a review was left. Cafe Bazaar: its
 * own rating screen for this app, opened in the Bazaar app.
 *
 * Call it after a good moment (a match, a first conversation), never on a
 * button that promises a dialog, and never more than the server's pacing allows.
 */
interface AppRating {
    suspend fun requestRating(activity: Activity): RatingOutcome
}

sealed interface RatingOutcome {
    /** Play's review flow finished. Whether a sheet was shown or a review left is not reported. */
    data object FlowFinished : RatingOutcome

    /** The store's rating page was opened. */
    data object OpenedStore : RatingOutcome

    data class Unavailable(val detail: String?) : RatingOutcome
}
