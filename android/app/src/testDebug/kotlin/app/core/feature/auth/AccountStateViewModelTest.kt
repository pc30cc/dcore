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
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
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
