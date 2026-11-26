package app.core.feature.onboarding

import android.location.LocationManager
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.resume

/**
 * One tap on «use my location» asks every provider a coarse caller may use at
 * once and takes the first real answer: satellites answer where network
 * location is off, every other request is withdrawn, an answer that is not a
 * position is skipped, and nothing to ask (or nothing answering) sends the
 * person to the city list without the 15 s wait.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CoarseLocationTest {

    private val fused = LocationManager.FUSED_PROVIDER
    private val network = LocationManager.NETWORK_PROVIDER
    private val gps = LocationManager.GPS_PROVIDER
    private val passive = LocationManager.PASSIVE_PROVIDER

    private class FakePlatform(
        private val on: Set<String>,
        private val last: Map<String, LocationReading> = emptyMap(),
        private val fails: Set<String> = emptySet(),
    ) : LocationPlatform {
        val asked = mutableListOf<String>()
        val withdrawn = mutableSetOf<String>()
        val open = mutableMapOf<String, CancellableContinuation<LocationReading?>>()

        override fun enabled(provider: String) = provider in on
        override fun lastKnown(provider: String) = last[provider]
        override suspend fun fresh(provider: String): LocationReading? {
            asked += provider
            if (provider in fails) throw SecurityException("not for this caller")
            return suspendCancellableCoroutine { c ->
                open[provider] = c
                c.invokeOnCancellation {
                    withdrawn += provider
                    open.remove(provider)
                }
            }
        }

        fun answer(provider: String, reading: LocationReading?) {
            open.remove(provider)!!.resume(reading)
        }
    }

    private fun reading(provider: String, lat: Double = 35.712, lng: Double = 51.398, accuracy: Float? = 2000f, ageMs: Long = 0) =
        LocationReading(provider, lat, lng, accuracy, ageMs)

    private fun TestScope.locating(fake: FakePlatform, sdk: Int = 31) = async { CoarseLocation.locate(fake, sdk, 15_000) }

    @Test
    fun fromAndroid12EveryProviderButPassiveIsAskedAtOnce() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps, passive))
        val result = locating(fake)
        runCurrent()
        assertEquals(setOf(fused, network, gps), fake.asked.toSet())
        assertFalse(passive in fake.asked)
        fake.answer(network, reading(network))
        runCurrent()
        assertTrue(result.isCompleted)
    }

    @Test
    fun satellitesAnswerWhenTheOthersStaySilentAndTheOthersAreWithdrawn() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        fake.answer(gps, reading(gps, 35.712, 51.398, 2000f))
        runCurrent()
        assertEquals(CoarseFix(35.71, 51.40, 2000, fromGps = true), result.await())
        assertTrue(fake.open.isEmpty())
        assertEquals(setOf(fused, network), fake.withdrawn)
    }

    @Test
    fun aNetworkFixFirstIsNotFromSatellites() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        fake.answer(network, reading(network))
        runCurrent()
        assertFalse(result.await()!!.fromGps)
        assertEquals(setOf(fused, gps), fake.withdrawn)
    }

    @Test
    fun aProviderGivingUpLeavesTheOthersToAnswer() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        fake.answer(fused, null)
        runCurrent()
        fake.answer(network, null)
        runCurrent()
        assertFalse(result.isCompleted)
        fake.answer(gps, reading(gps))
        runCurrent()
        assertTrue(result.await()!!.fromGps)
    }

    @Test
    fun answersThatAreNotPositionsAreSkipped() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        fake.answer(fused, reading(fused, 0.0, 0.0))
        fake.answer(network, reading(network, Double.NaN, 51.4))
        runCurrent()
        assertFalse(result.isCompleted)
        fake.answer(gps, reading(gps, accuracy = 200_000f))
        runCurrent()
        assertNull(result.await())
    }

    @Test
    fun aValidAnswerAfterAnUnusableOneWins() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        fake.answer(fused, reading(fused, accuracy = 200_000f))
        runCurrent()
        fake.answer(network, reading(network, 51.507, -0.127, 1200f))
        runCurrent()
        assertEquals(CoarseFix(51.51, -0.13, 1200, fromGps = false), result.await())
    }

    @Test
    fun whenEveryProviderAnswersWithNothingTheCityListComesAtOnce() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        fake.answer(fused, null)
        fake.answer(network, null)
        fake.answer(gps, null)
        runCurrent()
        assertNull(result.await())
        assertEquals(0L, testScheduler.currentTime)
    }

    @Test
    fun noAnswerWithinTheTimeoutWithdrawsEveryRequest() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        advanceTimeBy(15_001)
        runCurrent()
        assertNull(result.await())
        assertEquals(setOf(fused, network, gps), fake.withdrawn)
        assertTrue(fake.open.isEmpty())
    }

    @Test
    fun cancellingTheCallerWithdrawsEveryRequest() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps))
        val result = locating(fake)
        runCurrent()
        result.cancel()
        runCurrent()
        assertEquals(setOf(fused, network, gps), fake.withdrawn)
        assertTrue(fake.open.isEmpty())
    }

    @Test
    fun aFreshLastKnownFixIsUsedWithoutAskingAndAStaleOneIsNot() = runTest {
        val fresh = FakePlatform(on = setOf(network), last = mapOf(network to reading(network, ageMs = 60_000)))
        assertEquals(CoarseFix(35.71, 51.40, 2000, fromGps = false), CoarseLocation.locate(fresh, 31, 15_000))
        assertTrue(fresh.asked.isEmpty())

        val stale = FakePlatform(on = setOf(network), last = mapOf(network to reading(network, ageMs = 31L * 60 * 1000)))
        val result = locating(stale)
        runCurrent()
        assertEquals(listOf(network), stale.asked)
        result.cancel()
    }

    @Test
    fun theMostAccurateFreshLastKnownFixWins() = runTest {
        val fake = FakePlatform(
            on = setOf(network, gps, passive),
            last = mapOf(
                network to reading(network, 35.70, 51.40, 3000f),
                gps to reading(gps, 35.71, 51.41, 900f),
                passive to reading(passive, 35.72, 51.42, 1500f),
            ),
        )
        assertEquals(CoarseFix(35.71, 51.41, 900, fromGps = true), CoarseLocation.locate(fake, 31, 15_000))
    }

    @Test
    fun beforeAndroid12OnlyNetworkIsAsked() = runTest {
        val fake = FakePlatform(on = setOf(network, gps, passive))
        val result = locating(fake, sdk = 30)
        runCurrent()
        assertEquals(listOf(network), fake.asked)
        fake.answer(network, reading(network))
        runCurrent()
        assertFalse(result.await()!!.fromGps)
    }

    @Test
    fun withOnlyPassiveOnNothingIsAskedAndTheCityListComesAtOnce() = runTest {
        val fake = FakePlatform(on = setOf(passive))
        assertNull(CoarseLocation.locate(fake, 31, 15_000))
        assertTrue(fake.asked.isEmpty())
        assertEquals(0L, testScheduler.currentTime)
    }

    @Test
    fun withNetworkLocationOffSatellitesAloneAreAsked() = runTest {
        val fake = FakePlatform(on = setOf(gps))
        val result = locating(fake)
        runCurrent()
        assertEquals(listOf(gps), fake.asked)
        fake.answer(gps, reading(gps))
        runCurrent()
        assertTrue(result.await()!!.fromGps)
    }

    @Test
    fun aProviderThatThrowsLeavesTheOthersToAnswer() = runTest {
        val fake = FakePlatform(on = setOf(fused, network, gps), fails = setOf(fused))
        val result = locating(fake)
        runCurrent()
        fake.answer(network, reading(network))
        runCurrent()
        assertFalse(result.await()!!.fromGps)
    }

    @Test
    fun positionsAreRoundedToTwoDecimalPlaces() {
        assertEquals(35.71, CoarseLocation.coarsen(35.71234), 0.0)
        assertEquals(-0.12, CoarseLocation.coarsen(-0.1249), 0.0)
        assertEquals(180.0, CoarseLocation.coarsen(179.996), 0.0)
    }
}
