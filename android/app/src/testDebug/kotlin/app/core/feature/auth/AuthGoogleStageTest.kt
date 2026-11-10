package app.core.feature.auth

import android.app.Activity
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.feature.legal.LegalAcceptance
import app.core.model.AuthMethod
import app.core.model.AuthOptions
import app.core.model.Config
import app.core.model.DeviceInfo
import app.core.model.LegalLinks
import app.core.model.LegalVersions
import app.core.net.SampleApi
import app.core.storage.MemorySecretStore
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric

/**
 * Google lives on the number's page: its error is never carried back to the
 * welcome, and a Google sign-in that waited for the privacy summary resumes
 * on the number's page.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class AuthGoogleStageTest {

    private val clock = FakeClock()
    private val dispatcher = StandardTestDispatcher()
    private var model: AuthViewModel? = null

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() {
        model?.viewModelScope?.cancel()
        Dispatchers.resetMain()
    }

    private fun TestScope.model(store: String, privacyAccepted: Boolean): AuthViewModel {
        val api = SampleApi(store = store, clock = clock, signedIn = false)
        val legal = LegalAcceptance(MemorySecretStore(), clock)
        val config = Config(legal = LegalLinks(versions = LegalVersions(terms = 2, privacy = 3)), auth = AuthOptions(methods = listOf(AuthMethod.Phone, AuthMethod.Google)))
        if (privacyAccepted) kotlinx.coroutines.runBlocking { legal.accept(config.legal.versions) }
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        return AuthViewModel(
            api = api, gate = gate, legal = legal, clock = clock, saved = SavedStateHandle(),
            config = { config },
            device = { DeviceInfo("Test", "16", "1.0", "fa") },
            locale = { "fa" },
            appHash = { null },
            integrity = { null },
            defaultCountry = PhoneNumbers.country("IR")!!,
            googleBuild = store == "play",
        ).also {
            model = it
            runCurrent()
        }
    }

    @Test
    fun googlesErrorStaysOnTheNumbersPageAndIsGoneBackOnTheWelcome() = runTest(dispatcher) {
        // The bazaar sample refuses Google: an error to show.
        val m = model(store = "bazaar", privacyAccepted = true)
        m.continueWithPhone()
        assertEquals(AuthStage.Phone, m.state.value.stage)
        m.signInWithGoogle(Robolectric.buildActivity(Activity::class.java).get())
        clock.advance(10_000)
        testScheduler.advanceTimeBy(10_000)
        runCurrent()
        assertNotNull(m.state.value.googleError)

        m.back()
        assertEquals(AuthStage.Welcome, m.state.value.stage)
        assertNull("the welcome has no Google button, so no Google error", m.state.value.googleError)
    }

    @Test
    fun aGoogleSignInHeldByThePrivacySummaryResumesOnTheNumbersPage() = runTest(dispatcher) {
        val m = model(store = "play", privacyAccepted = false)
        m.continueWithGoogle()
        assertEquals(AuthStage.Privacy, m.state.value.stage)
        m.acceptPrivacy()
        runCurrent()
        assertEquals(AuthStage.Phone, m.state.value.stage)
        assertTrue(m.state.value.launchGoogle)
    }
}
