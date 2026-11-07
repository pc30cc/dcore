package app.core.push

import app.core.feature.call.http
import app.core.feature.call.offline
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** `rang` once per call per phone, tried three times on a network failure, never again after a final answer. */
@OptIn(ExperimentalCoroutinesApi::class)
class CallRangReporterTest {

    @Test
    fun oncePerCallHoweverOftenAsked() = runTest {
        val sent = mutableListOf<String>()
        val reporter = CallRangReporter(send = { sent += it }, scope = backgroundScope)
        reporter.report("1")
        reporter.report("1")
        reporter.report("2")
        runCurrent()
        assertEquals(listOf("1", "2"), sent)
    }

    @Test
    fun aNetworkFailureIsTriedTwiceMoreAndATooLateAnswerIsFinal() = runTest {
        var attempts = 0
        val reporter = CallRangReporter(send = { attempts++; throw offline() }, scope = backgroundScope)
        reporter.report("1")
        runCurrent()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(3, attempts)

        var late = 0
        val final = CallRangReporter(send = { late++; throw http(409, "not_ringing") }, scope = backgroundScope)
        final.report("2")
        runCurrent()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(1, late)
    }
}
