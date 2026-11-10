package app.core.feature.settings

import androidx.lifecycle.viewModelScope
import app.core.R
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.feature.auth.AuthGate
import app.core.feature.auth.Root
import app.core.model.SettingsPatch
import app.core.i18n.AppLanguage
import app.core.model.Me
import app.core.net.ApiError
import app.core.net.Fetched
import app.core.net.SampleApi
import app.core.net.ServerApi
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Settings' switches go to the server and back; incognito needs the plan; the export and signing out everywhere. */
@OptIn(ExperimentalCoroutinesApi::class)
class SettingsModelTest {

    private val clock = FakeClock()
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun theNotificationGroupsAreSavedTogether() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        val model = SettingsModel(api, gate, clock)
        runCurrent()
        model.setNotifications(matches = false)
        runCurrent()
        val prefs = model.state.value.notifications!!
        assertFalse(prefs.matches)
        assertFalse(prefs.likes)
        assertTrue(prefs.messages)
        assertFalse(api.me().value.notifications!!.likes)
        model.viewModelScope.cancel()
    }

    @Test
    fun incognitoWithoutThePlanOpensThePlansAndGoesBack() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        val model = SettingsModel(api, gate, clock)
        runCurrent()
        model.setPrivacy(SettingsPatch(incognito = true))
        runCurrent()
        assertEquals(SettingsEvent.NeedsPlan, model.events.first())
        assertFalse(model.state.value.settings!!.incognito)
        // A switch the plan does not gate is saved.
        model.setPrivacy(SettingsPatch(hideAge = true))
        runCurrent()
        assertTrue(model.state.value.settings!!.hideAge)
        assertTrue(api.me().value.profile!!.settings.hideAge)
        model.viewModelScope.cancel()
    }

    @Test
    fun theExportIsAskedForThenOpenedOnceReady() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        val model = SettingsModel(api, gate, clock)
        runCurrent()
        model.export()
        runCurrent()
        assertEquals(SettingsEvent.Notice(R.string.settings_export_started), model.events.first())
        // Built a while later: the next ask opens its link.
        clock.millis += 10 * 60_000L
        advanceTimeBy(10 * 60_000L)
        model.export()
        runCurrent()
        val opened = model.events.first()
        assertTrue("$opened", opened is SettingsEvent.Open)
        model.viewModelScope.cancel()
    }

    @Test
    fun signingOutEverywhereEndsTheSession() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        assertEquals(Root.Main, gate.root.value)
        val model = SettingsModel(api, gate, clock)
        model.signOut(everywhere = true)
        runCurrent()
        assertEquals(Root.SignIn, gate.root.value)
        assertFalse(api.hasSession())
        model.viewModelScope.cancel()
    }

    @Test
    fun signingOutEverywhereThatTheServerCannotTakeKeepsThisPhoneSignedInAndSaysSo() = runTest(dispatcher) {
        val sample = SampleApi(clock = clock)
        var down = true
        val api = object : ServerApi by sample {
            override suspend fun logout(allSessions: Boolean) {
                if (down) throw ApiError.Network(java.io.IOException("down")) else sample.logout(allSessions)
            }
        }
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        assertEquals(Root.Main, gate.root.value)
        val model = SettingsModel(api, gate, clock)
        model.signOut(everywhere = true)
        runCurrent()
        // The other devices are still signed in: nothing here pretends otherwise.
        assertEquals(Root.Main, gate.root.value)
        assertTrue(api.hasSession())
        assertEquals(SettingsEvent.Notice(R.string.error_offline), model.events.first())
        // Online again: the same tap ends every session.
        down = false
        model.signOut(everywhere = true)
        runCurrent()
        assertEquals(Root.SignIn, gate.root.value)
        assertFalse(api.hasSession())
        model.viewModelScope.cancel()
    }

    @Test
    fun signingOutHereOfflineStillForgetsTheSessionOnThePhone() = runTest(dispatcher) {
        val sample = SampleApi(clock = clock)
        val api = object : ServerApi by sample {
            override suspend fun logout(allSessions: Boolean) = throw ApiError.Network(java.io.IOException("down"))
        }
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        val model = SettingsModel(api, gate, clock)
        model.signOut(everywhere = false)
        runCurrent()
        assertEquals(Root.SignIn, gate.root.value)
        assertFalse(api.hasSession())
        model.viewModelScope.cancel()
    }

    @Test
    fun theSwitchesWaitForTheAccountAndAFailedReadIsTriedAgain() = runTest(dispatcher) {
        val sample = SampleApi(clock = clock)
        var down = true
        val api = object : ServerApi by sample {
            override suspend fun me(): Fetched<Me> = if (down) throw ApiError.Network(java.io.IOException("down")) else sample.me()
        }
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        val model = SettingsModel(api, gate, clock)
        runCurrent()
        // Nothing read: the sheets draw the switches, but they cannot be moved.
        assertFalse(model.state.value.loaded)
        down = false
        // Opening a sheet with switches reads again.
        model.ensureLoaded()
        runCurrent()
        assertTrue(model.state.value.loaded)
        assertEquals(sample.me().value.notifications, model.state.value.notifications)
        model.viewModelScope.cancel()
    }

    @Test
    fun theAccountRowNamesWhatThisPhoneSignedInWith() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        val model = SettingsModel(api, gate, clock, signedInAs = { "+989123456789" })
        runCurrent()
        assertEquals("+989123456789", model.state.value.signedInAs)
        // As its holder writes it at home, in the screen's digits, kept left to right.
        assertEquals("\u2066۰۹۱۲ ۳۴۵ ۶۷۸۹\u2069", signInLabel("+989123456789", AppLanguage.FA))
        assertEquals("\u20660912 345 6789\u2069", signInLabel("+989123456789", AppLanguage.EN))
        assertEquals("\u2066sam@example.com\u2069", signInLabel("sam@example.com", AppLanguage.FA))
        model.viewModelScope.cancel()
    }
}
