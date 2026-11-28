package app.core.feature.card

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import app.core.R
import app.core.i18n.brandString
import app.core.model.DistanceUnit
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * The unit the app shows distances in: the account's (`GET /v1/me`
 * `distanceUnit`, the panel's choice for its country), kilometres until the
 * first answer and everywhere nothing provides one.
 */
val LocalDistanceUnit = staticCompositionLocalOf { DistanceUnit.Km }

/**
 * Kilometres from the server (rounded from a fuzzed cell, or a radius) as
 * the number shown in a unit. Only the shown number changes: what is stored
 * and sent stays in kilometres.
 */
object Distances {
    private const val KM_PER_MILE = 1.609344

    /** Whether [unit] shows miles ([DistanceUnit.Unknown] shows kilometres). */
    fun miles(unit: DistanceUnit): Boolean = unit == DistanceUnit.Mi

    /** [km] in [unit]: whole miles, at least 1 for a distance of at least 1 km. */
    fun shown(km: Int, unit: DistanceUnit): Int =
        if (!miles(unit) || km <= 0) km else maxOf(1, (km / KM_PER_MILE).roundToInt())

    /** An upper bound ("under 2 km") in [unit]: rounded up, so the sentence stays true. */
    fun shownBound(km: Int, unit: DistanceUnit): Int =
        if (!miles(unit) || km <= 0) km else ceil(km / KM_PER_MILE).toInt()
}

/** The out-of-cards button: «تا ۴۰ کیلومتر بگرد», or in miles. [km] is the radius asked for. */
@Composable
fun widenDistanceLabel(km: Int, unit: DistanceUnit, number: (Int) -> String): String =
    if (Distances.miles(unit)) {
        brandString(R.string.deck_widen_distance_mi, number(Distances.shown(km, unit)))
    } else {
        brandString(R.string.deck_widen_distance, number(km))
    }

/** The filters' distance value: «تا ۵۰ کیلومتر», or in miles. [km] is the radius on the slider. */
@Composable
fun filterDistanceLabel(km: Int, unit: DistanceUnit, number: (Int) -> String): String =
    if (Distances.miles(unit)) {
        brandString(R.string.filters_distance_value_mi, number(Distances.shown(km, unit)))
    } else {
        brandString(R.string.filters_distance_value, number(km))
    }
