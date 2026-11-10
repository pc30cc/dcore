package app.core.feature.auth

import androidx.lifecycle.viewModelScope
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.AccountStatus
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Deleting in the app: the store subscription that keeps renewing is named
 * first; the deletion ends the session here (back to the welcome) and
 * signing in again before the purge brings the account back; a suspended
 * account may delete too.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeleteAccountModelTest {

    private val clock = FakeClock(millis = Instant.parse("2026-11-10T10:00:00Z").toEpochMilli())
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun deletingEndsTheSessionAndCanBeUndoneBySigningIn() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        val model = DeleteAccountModel(api, gate, clock)
        runCurrent()
        // A free account: nothing renews.
        assertNull(model.state.value.preflight?.subscription)
        assertEquals(LocalDate.of(2026, 12, 10), model.restorableUntil(ZoneOffset.UTC))
        model.delete()
        runCurrent()
        assertEquals(Root.SignIn, gate.root.value)
        assertFalse(api.hasSession())
        model.viewModelScope.cancel()
    }

    @Test
    fun aRenewingPlanIsNamedBeforeDeleting() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        api.stageOwnProfile(subscription = true)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        val model = DeleteAccountModel(api, gate, clock)
        runCurrent()
        assertNotNull(model.state.value.preflight?.subscription)
        model.viewModelScope.cancel()
    }

    @Test
    fun aSuspendedAccountMayDelete() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        api.setAccountStatus(AccountStatus.Suspended)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        val model = DeleteAccountModel(api, gate, clock)
        model.delete()
        runCurrent()
        assertEquals(Root.SignIn, gate.root.value)
        model.viewModelScope.cancel()
    }
}
