package app.core.store

import android.app.Activity
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.runner.RunWith
import app.core.common.FakeClock
import app.core.storage.MemorySecretStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The caps on asking for a rating and suggesting an update, and the age signal kept to one boolean. */
@RunWith(AndroidJUnit4::class)
class StorePromptsTest {

    private val day = 24L * 3600 * 1000

    @Test
    fun aRatingIsAskedAfterASecondMatchOrAGoodCallAtMostEvery120Days() = runTest {
        val clock = FakeClock()
        val pacing = RatingPacing(MemorySecretStore(), clock)
        assertFalse(pacing.due())
        pacing.noteMatch()
        assertFalse("one match is not enough", pacing.due())
        pacing.noteMatch()
        assertTrue(pacing.due())
        pacing.asked()
        assertFalse(pacing.due())

        pacing.noteCall(seconds = 60)
        pacing.noteMatch()
        assertFalse("a short call and one match: not yet", pacing.due())
        pacing.noteCall(seconds = 240)
        assertFalse("earned, but 120 days have not passed", pacing.due())
        clock.advance(120 * day)
        assertTrue(pacing.due())
    }

    @Test
    fun aRecommendedUpdateIsSuggestedAtMostEveryThreeDays() = runTest {
        val clock = FakeClock()
        val pacing = UpdatePacing(MemorySecretStore(), clock)
        assertTrue(pacing.due())
        pacing.asked()
        clock.advance(2 * day)
        assertFalse(pacing.due())
        clock.advance(day)
        assertTrue(pacing.due())
    }

    private class Signals(var answer: AgeSignal) : AgeSignals {
        var asked = 0
        override suspend fun check(activity: Activity): AgeSignal {
            asked++
            return answer
        }
    }

    @Test
    fun theAgeSignalIsAskedOnceAndKeptAsOneBoolean() = runTest {
        val store = MemorySecretStore()
        val signals = Signals(AgeSignal.Minor)
        val check = AgeSignalsCheck(signals, store, FakeClock())
        assertTrue(check.minor(stub()))
        assertTrue(check.minor(stub()))
        assertEquals("asked once per install", 1, signals.asked)
        assertTrue(store.storedSecrets.isEmpty())
    }

    @Test
    fun noSignalOrAFailureIsAskedAgainAndBlocksNothing() = runTest {
        val signals = Signals(AgeSignal.Failed("offline"))
        val check = AgeSignalsCheck(signals, MemorySecretStore(), FakeClock())
        assertFalse(check.minor(stub()))
        signals.answer = AgeSignal.Unsupported
        assertFalse(check.minor(stub()))
        signals.answer = AgeSignal.Adult
        assertFalse(check.minor(stub()))
        assertFalse(check.minor(stub()))
        assertEquals(3, signals.asked)
    }

    /** The fakes never touch the activity. */
    private fun stub(): Activity = org.robolectric.Robolectric.buildActivity(Activity::class.java).get()
}
