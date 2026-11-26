package app.core.feature.auth

import androidx.lifecycle.viewModelScope
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.AccountStatus
import app.core.model.AppealStatus
import app.core.model.ModerationKind
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.net.SampleApi
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** A restricted or deleting account sees why, may appeal or restore, and the gate follows. */
@OptIn(ExperimentalCoroutinesApi::class)
class AccountStateViewModelTest {

    private val clock = FakeClock()
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun aSuspensionShowsItsReasonAndTakesOneAppeal() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        assertEquals(Root.Main, gate.root.value)

        api.setAccountStatus(AccountStatus.Suspended, reason = "Repeated reports of harassment.")
        // Any refused request moves the app to the restricted screen, with the refusal at hand.
        try {
            api.deck()
            fail("a suspended account has no deck")
        } catch (e: ApiError.Http) {
            assertEquals(ProblemCodes.ACCOUNT_SUSPENDED, e.code)
        }
        runCurrent()
        assertEquals(Root.Restricted, gate.root.value)
        assertEquals("Repeated reports of harassment.", gate.accountProblem.value?.reasonText)

        val model = AccountStateViewModel(api, gate)
        runCurrent()
        val action = model.state.value.action
        assertEquals(ModerationKind.Suspension, action?.kind)
        assertEquals("Repeated reports of harassment.", action?.reasonText)
        model.appeal("It was a misunderstanding.")
        runCurrent()
        assertTrue(model.state.value.appealSent)
        assertEquals(AppealStatus.Open, model.state.value.action?.appeal?.status)
        model.viewModelScope.cancel()
    }

    @Test
    fun aLiftedActionTakesNoAppeal() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        api.setAccountStatus(AccountStatus.Suspended, reason = "Repeated reports of harassment.")
        try {
            api.deck()
            fail("a suspended account has no deck")
        } catch (e: ApiError.Http) {
            assertEquals(ProblemCodes.ACCOUNT_SUSPENDED, e.code)
        }
        runCurrent()
        assertEquals(Root.Restricted, gate.root.value)

        val model = AccountStateViewModel(api, gate)
        runCurrent()
        val action = model.state.value.action
        assertNotNull(action)
        assertNull(action!!.revokedAt)
        // Lifted by the team while the screen still offers the appeal.
        api.liftModeration(action.id)
        val before = api.requestLog.size
        model.appeal("It was a misunderstanding.")
        runCurrent()
        val state = model.state.value
        assertNull("no error for an appeal that is no longer needed", state.error)
        assertFalse(state.appealSent)
        assertFalse(state.busy)
        assertTrue("read again", api.requestLog.drop(before).containsAll(listOf("appeals", "me")))
        assertEquals("the gate followed the account", Root.Main, gate.root.value)
        model.viewModelScope.cancel()
    }

    /** A suspended account on the restricted screen, then its suspension lifted while the account still reads suspended. */
    private suspend fun TestScope.liftedButStillRestricted(): Triple<SampleApi, AuthGate, AccountStateViewModel> {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        api.setAccountStatus(AccountStatus.Suspended, reason = "Repeated reports of harassment.")
        try {
            api.deck()
            fail("a suspended account has no deck")
        } catch (e: ApiError.Http) {
            assertEquals(ProblemCodes.ACCOUNT_SUSPENDED, e.code)
        }
        runCurrent()
        val model = AccountStateViewModel(api, gate)
        runCurrent()
        val action = model.state.value.action!!
        api.liftModeration(action.id, accountCatchesUp = false)
        model.refresh()
        runCurrent()
        assertEquals(AccountStatus.Suspended, model.state.value.status)
        assertNotNull("the lifted one is shown", model.state.value.action?.revokedAt)
        assertEquals(Root.Restricted, gate.root.value)
        return Triple(api, gate, model)
    }

    private fun SampleApi.reads(): Int = requestLog.count { it == "me" }

    @Test
    fun aLiftTheAccountHasNotCaughtUpWithIsReadAgainAFewTimesThenOnlyOnATap() = runTest(dispatcher) {
        val (api, gate, model) = liftedButStillRestricted()
        var reads = api.reads()
        // Each wait in turn, one read after each.
        for (wait in LIFTED_RECHECK_MS) {
            advanceTimeBy(wait - 1)
            runCurrent()
            assertEquals("not before ${wait}ms", reads, api.reads())
            advanceTimeBy(1)
            runCurrent()
            assertEquals("one read after ${wait}ms", reads + 1, api.reads())
            reads = api.reads()
            assertNotNull(model.state.value.action?.revokedAt)
        }
        // Then no more on its own: each would read the moderation history again.
        advanceTimeBy(60 * 60_000L)
        runCurrent()
        assertEquals(reads, api.reads())
        // A tap still reads, and starts no new round.
        model.refresh()
        runCurrent()
        assertEquals(reads + 1, api.reads())
        advanceTimeBy(60 * 60_000L)
        runCurrent()
        assertEquals(reads + 1, api.reads())
        // Once the account catches up, the gate follows it.
        api.setAccountStatus(AccountStatus.Active)
        model.refresh()
        runCurrent()
        assertNull(model.state.value.action)
        assertEquals(Root.Main, gate.root.value)
        model.viewModelScope.cancel()
    }

    @Test
    fun theRereadsStopOnceTheAccountCatchesUp() = runTest(dispatcher) {
        val (api, gate, model) = liftedButStillRestricted()
        advanceTimeBy(LIFTED_RECHECK_MS[0])
        runCurrent()
        assertEquals(Root.Restricted, gate.root.value)
        api.setAccountStatus(AccountStatus.Active)
        advanceTimeBy(LIFTED_RECHECK_MS[1])
        runCurrent()
        assertEquals("the next read found it active", Root.Main, gate.root.value)
        assertEquals(AccountStatus.Active, model.state.value.status)
        assertNull(model.state.value.action)
        val reads = api.reads()
        advanceTimeBy(60 * 60_000L)
        runCurrent()
        assertEquals("nothing more to read", reads, api.reads())
        model.viewModelScope.cancel()
    }

    @Test
    fun aDeletedAccountCanBeRestoredInsideItsGracePeriod() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        api.deleteAccount()
        gate.start()
        runCurrent()
        assertEquals(Root.Restore, gate.root.value)
        val model = AccountStateViewModel(api, gate)
        runCurrent()
        assertTrue(model.state.value.purgeAt != null)
        model.restore()
        runCurrent()
        assertEquals(Root.Main, gate.root.value)
        model.viewModelScope.cancel()
    }
}
