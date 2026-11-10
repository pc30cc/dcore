package app.core.feature.deck

import app.core.model.DiscoveryPreferences
import app.core.model.PreferencesPatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The end of the deck widens one step at a time, within bounds, and sends only what changes. */
class WideningTest {

    @Test
    fun distanceDoublesWithAtLeastTwentyMoreUpToTheMaximumThenTheWholeCountry() {
        assertEquals(22, Widening.nextDistance(2))
        assertEquals(100, Widening.nextDistance(50))
        assertEquals(300, Widening.nextDistance(200))
        assertEquals(PreferencesPatch(maxDistanceKm = 100), Widening.distance(DiscoveryPreferences(maxDistanceKm = 50)))
        assertEquals(PreferencesPatch(wholeCountry = true), Widening.distance(DiscoveryPreferences(maxDistanceKm = 300)))
        assertTrue(Widening.widensToCountry(DiscoveryPreferences(maxDistanceKm = 300)))
    }

    @Test
    fun agesWidenByThreeEachWayWithinEighteenToNinetyNine() {
        assertEquals(20 to 37, Widening.nextAges(DiscoveryPreferences(ageMin = 23, ageMax = 34)))
        assertEquals(18 to 99, Widening.nextAges(DiscoveryPreferences(ageMin = 19, ageMax = 98)))
        assertEquals(PreferencesPatch(ageMin = 20, ageMax = 37), Widening.age(DiscoveryPreferences(ageMin = 23, ageMax = 34)))
        assertTrue(Widening.ageIsWidest(DiscoveryPreferences(ageMin = 18, ageMax = 99)))
        assertFalse(Widening.ageIsWidest(DiscoveryPreferences(ageMin = 18, ageMax = 60)))
    }
}
