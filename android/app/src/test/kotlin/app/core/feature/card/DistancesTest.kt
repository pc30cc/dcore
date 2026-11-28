package app.core.feature.card

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.model.Distance
import app.core.model.DistanceUnit
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Distances in the unit the account's country shows (`GET /v1/me`
 * `distanceUnit`): the server's kilometres stay what is stored and sent, only
 * the number and the word on screen change.
 */
@RunWith(AndroidJUnit4::class)
class DistancesTest {

    @get:Rule val compose = createComposeRule()

    @Test
    fun milesAreRoundedAndAnUpperBoundIsRoundedUp() {
        assertEquals(31, Distances.shown(50, DistanceUnit.Mi))
        assertEquals(1, Distances.shown(1, DistanceUnit.Mi))
        assertEquals(186, Distances.shown(300, DistanceUnit.Mi))
        // "Under 2 km" is under 1.24 miles: "under 2 mi" stays true, "under 1 mi" would not.
        assertEquals(2, Distances.shownBound(2, DistanceUnit.Mi))
        assertEquals(1, Distances.shownBound(1, DistanceUnit.Mi))
        // Kilometres, and a unit this build does not know, show the server's number.
        for (unit in listOf(DistanceUnit.Km, DistanceUnit.Unknown)) {
            assertEquals(unit.name, 50, Distances.shown(50, unit))
            assertEquals(unit.name, 2, Distances.shownBound(2, unit))
        }
        assertEquals(0, Distances.shown(0, DistanceUnit.Mi))
    }

    /** What each place shows under each unit (null: nothing provides one), in one composition. */
    private fun texts(vararg units: DistanceUnit?): List<List<String?>> {
        val out = MutableList<List<String?>>(units.size) { emptyList() }
        compose.setContent {
            units.forEachIndexed { index, unit ->
                val read: @Composable () -> Unit = {
                    val number = rememberNumbers()
                    out[index] = listOf(
                        distanceText(Distance(km = 8, lessThan = false), number),
                        distanceText(Distance(km = 2, lessThan = true), number),
                        widenDistanceLabel(80, LocalDistanceUnit.current, number),
                        filterDistanceLabel(50, LocalDistanceUnit.current, number),
                    )
                }
                if (unit == null) read() else CompositionLocalProvider(LocalDistanceUnit provides unit, content = read)
            }
        }
        compose.waitForIdle()
        return out
    }

    @Test
    @Config(qualifiers = "en")
    fun theCardTheEndOfTheDeckAndTheFiltersFollowTheUnit() {
        val (none, miles, unknown) = texts(null, DistanceUnit.Mi, DistanceUnit.Unknown)
        assertEquals(listOf("8 km", "Under 2 km", "Search up to 80 km", "Up to 50 km"), none)
        assertEquals(listOf("5 mi", "Under 2 mi", "Search up to 50 mi", "Up to 31 mi"), miles)
        assertEquals(none, unknown)
    }

    @Test
    @Config(qualifiers = "fa")
    fun persianNamesMilesInItsOwnWords() {
        assertEquals(listOf("۵ مایل", "کمتر از ۲ مایل", "تا ۵۰ مایل بگرد", "تا ۳۱ مایل"), texts(DistanceUnit.Mi).single())
    }

    @Test
    @Config(qualifiers = "tr")
    fun turkishTakesTheSuffixesOfMil() {
        assertEquals(listOf("5 mil", "2 milden az", "50 mile kadar ara", "31 mile kadar"), texts(DistanceUnit.Mi).single())
    }
}
