package app.core.feature.auth

import androidx.lifecycle.SavedStateHandle
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.feature.legal.LegalAcceptance
import app.core.model.AuthMethod
import app.core.model.AuthOptions
import app.core.model.Config
import app.core.model.DeviceInfo
import app.core.model.LegalLinks
import app.core.model.LegalVersions
import app.core.model.OtpChannel
import app.core.net.SampleApi
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import app.core.storage.MemorySecretStore
import kotlinx.coroutines.CoroutineScope
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
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
import org.junit.Before
import org.junit.Test

/**
 * Sign-in against the sample backend, end to end through the view model:
 * the notice, the number, the code with the server's length, the refusals,
 * and where the gate sends each kind of account.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AuthViewModelTest {

    private val clock = FakeClock()
    private val dispatcher = StandardTestDispatcher()
    private val homeIr = PhoneNumbers.country("IR")!!

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    /** View models made in a test; their scopes (timers, polling) are cancelled before the test ends. */
    private val models = mutableListOf<androidx.lifecycle.ViewModel>()

    private fun vmTest(body: suspend TestScope.() -> Unit) = runTest(dispatcher) {
        try {
            body()
        } finally {
            models.forEach { it.viewModelScope.cancel() }
            models.clear()
        }
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private class Setup(val api: SampleApi, val gate: AuthGate, val legal: LegalAcceptance, val model: AuthViewModel, val saved: SavedStateHandle)

    private fun TestScope.setup(
        store: String = "bazaar",
        saved: SavedStateHandle = SavedStateHandle(),
        api: SampleApi = SampleApi(store = store, clock = clock, signedIn = false),
        legal: LegalAcceptance = LegalAcceptance(MemorySecretStore(), clock),
        config: Config? = Config(legal = LegalLinks(versions = LegalVersions(terms = 2, privacy = 3)), auth = AuthOptions(methods = listOf(AuthMethod.Phone, AuthMethod.Google))),
        scope: CoroutineScope = backgroundScope,
        privacyAccepted: Boolean = true,
    ): Setup {
        if (privacyAccepted) kotlinx.coroutines.runBlocking { legal.accept(config?.legal?.versions ?: LegalVersions()) }
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, scope, Diag.Silent)
        gate.start()
        val model = AuthViewModel(
            api = api, gate = gate, legal = legal, clock = clock, saved = saved,
            config = { config },
            device = { DeviceInfo("Test", "16", "1.0", "fa") },
            locale = { "fa" },
            appHash = { null },
            integrity = { null },
            defaultCountry = homeIr,
            googleBuild = store == "play",
        )
        models += model
        runCurrent()
        return Setup(api, gate, legal, model, saved)
    }

    /** Moves both clocks: the sample's and the coroutines'. */
    private fun TestScope.advance(ms: Long) {
        clock.advance(ms)
        testScheduler.advanceTimeBy(ms)
        runCurrent()
    }

    @Test
    fun `the privacy notice comes first, once per install, and its versions are kept for the basics`() = vmTest {
        val s = setup(privacyAccepted = false)
        assertEquals(AuthStage.Welcome, s.model.state.value.stage)
        assertFalse(s.model.state.value.privacyAccepted)
        s.model.continueWithPhone()
        assertEquals(AuthStage.Privacy, s.model.state.value.stage)
        s.model.acceptPrivacy()
        runCurrent()
        assertEquals(AuthStage.Phone, s.model.state.value.stage)
        assertEquals(2, s.legal.accepted()?.terms)
        assertEquals(3, s.legal.accepted()?.privacy)

        // The same install, another launch: straight to the number.
        val again = setup(legal = s.legal, privacyAccepted = false)
        again.model.continueWithPhone()
        assertEquals(AuthStage.Phone, again.model.state.value.stage)
    }

    @Test
    fun `a new number signs up with code boxes from the server, a wrong code, then in to onboarding`() = vmTest {
        val s = setup()
        s.model.continueWithPhone()
        runCurrent()
        s.model.phoneChanged("0912 345 6789")
        s.model.sendCode()
        runCurrent()
        val otp = s.model.state.value.otp
        assertEquals(AuthStage.Code, s.model.state.value.stage)
        assertEquals("+989123456789", otp.challenge?.e164)
        assertEquals(6, otp.codeLength)
        assertTrue(otp.resendInSeconds in 59..60)
        assertEquals(listOf("auth.otp.start"), s.api.requestLog)

        s.model.codeChanged("000000")
        runCurrent()
        val wrong = s.model.state.value.otp.codeError
        assertEquals(CodeError.Wrong(4), wrong)
        assertEquals("", s.model.state.value.otp.code)

        s.model.codeChanged("123456")
        runCurrent()
        assertTrue(s.model.state.value.success)
        advance(500)
        assertEquals(Root.Onboarding, s.gate.root.value)
        assertTrue(s.api.hasSession())
        assertEquals(listOf("auth.otp.start", "auth.otp.verify", "auth.otp.verify"), s.api.requestLog)
    }

    @Test
    fun `a known number signs in to the app`() = vmTest {
        val s = setup()
        s.model.continueWithPhone()
        runCurrent()
        s.model.phoneChanged("+98 912 000 0000")
        s.model.sendCode()
        runCurrent()
        s.model.codeReceived("123456")
        runCurrent()
        advance(500)
        assertEquals(Root.Main, s.gate.root.value)
    }

    @Test
    fun `send again opens after the server's interval and earlier the server refuses with its wait`() = vmTest {
        val s = setup()
        s.model.continueWithPhone()
        runCurrent()
        s.model.phoneChanged("09123456789")
        s.model.sendCode()
        runCurrent()
        assertFalse(s.model.state.value.otp.canResend)
        s.model.resend()
        runCurrent()
        assertEquals("nothing sent before the wait is over", 1, s.api.requestLog.count { it == "auth.otp.start" })

        // Back to the number and send again at once: the sample, like the server, refuses for the rest of the minute.
        s.model.back()
        s.model.sendCode()
        runCurrent()
        val refused = s.model.state.value.otp.sendError
        assertTrue(refused is SendError.RateLimited)
        assertTrue(s.model.state.value.otp.sendBlocked)

        advance(61_000)
        assertFalse(s.model.state.value.otp.sendBlocked)
        s.model.sendCode()
        runCurrent()
        assertEquals(AuthStage.Code, s.model.state.value.stage)
        advance(60_000)
        assertTrue(s.model.state.value.otp.canResend)
        s.model.resend(OtpChannel.Call)
        runCurrent()
        assertEquals(OtpChannel.Call, s.model.state.value.otp.challenge?.channel)
    }

    @Test
    fun `five wrong codes lock the code and ask for a new one`() = vmTest {
        val s = setup()
        s.model.continueWithPhone()
        runCurrent()
        s.model.phoneChanged("09123456789")
        s.model.sendCode()
        runCurrent()
        repeat(5) { i ->
            s.model.codeChanged("00000$i")
            runCurrent()
        }
        val otp = s.model.state.value.otp
        assertEquals(CodeError.Locked, otp.codeError)
        assertTrue(otp.expired)
        assertTrue(otp.canResend)
    }

    @Test
    fun `an expired code is said, and a new one replaces it`() = vmTest {
        val s = setup()
        s.model.continueWithPhone()
        runCurrent()
        s.model.phoneChanged("09123456789")
        s.model.sendCode()
        runCurrent()
        val first = s.model.state.value.otp.challenge?.id
        advance(301_000)
        assertEquals(CodeError.Expired, s.model.state.value.otp.codeError)
        s.model.resend()
        runCurrent()
        assertNull(s.model.state.value.otp.codeError)
        assertNotNull(s.model.state.value.otp.challenge)
        assertFalse(first == s.model.state.value.otp.challenge?.id)
    }

    @Test
    fun `an invalid or unsupported number says why`() = vmTest {
        val s = setup()
        s.model.continueWithPhone()
        runCurrent()
        // Germany is not among the sample's allowed countries.
        s.model.phoneChanged("+49 1512 3456789")
        s.model.sendCode()
        runCurrent()
        assertEquals(SendError.NotAllowed, s.model.state.value.otp.sendError)
        assertEquals(AuthStage.Phone, s.model.state.value.stage)
    }

    @Test
    fun `the code step survives the process being killed`() = vmTest {
        val saved = SavedStateHandle()
        val api = SampleApi(clock = clock, signedIn = false)
        val legal = LegalAcceptance(MemorySecretStore(), clock)
        val first = setup(saved = saved, api = api, legal = legal)
        first.model.continueWithPhone()
        runCurrent()
        first.model.phoneChanged("09123456789")
        first.model.sendCode()
        runCurrent()
        val id = first.model.state.value.otp.challenge?.id

        val restored = setup(saved = saved, api = api, legal = legal)
        assertEquals(AuthStage.Code, restored.model.state.value.stage)
        assertEquals(id, restored.model.state.value.otp.challenge?.id)
        restored.model.codeChanged("123456")
        runCurrent()
        advance(500)
        assertEquals(Root.Onboarding, restored.gate.root.value)
    }

    @Test
    fun `Google is offered only in the play build, and signs up through the sample`() = vmTest {
        val bazaar = setup(store = "bazaar")
        assertFalse(bazaar.model.state.value.googleOffered)

        val play = setup(store = "play")
        assertTrue(play.model.state.value.googleOffered)
        play.model.continueWithGoogle()
        runCurrent()
        // Accepted already on this install: the screen is asked to open the sheet.
        assertTrue(play.model.state.value.privacyAccepted)
        assertTrue(play.model.state.value.launchGoogle)
    }

    @Test
    fun `the server can take Google away`() = vmTest {
        val s = setup(store = "play", config = Config(auth = AuthOptions(methods = listOf(AuthMethod.Phone))))
        assertFalse(s.model.state.value.googleOffered)
    }

    @Test
    fun `the integrity token is bound to the number`() {
        val a = AuthViewModel.requestHash("+989121234567")
        assertEquals(43, a.length)
        assertFalse(a.contains('=') || a.contains('+') || a.contains('/'))
        assertFalse(a == AuthViewModel.requestHash("+989121234568"))
        assertEquals("AQID", AuthViewModel.base64Url(byteArrayOf(1, 2, 3)))
        assertEquals("-_8", AuthViewModel.base64Url(byteArrayOf(0xFB.toByte(), 0xFF.toByte())))
    }
}
