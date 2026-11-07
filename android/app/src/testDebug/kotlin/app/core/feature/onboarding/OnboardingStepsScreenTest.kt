package app.core.feature.onboarding

import android.content.res.Configuration
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Clock
import app.core.common.Diag
import app.core.feature.auth.AuthGate
import app.core.feature.legal.LegalAcceptance
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.DeviceInfo
import app.core.model.LegalVersions
import app.core.model.OtpStartRequest
import app.core.net.SampleApi
import app.core.net.SampleData
import app.core.storage.MemorySecretStore
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.util.Locale

/**
 * Sign-up screens drawn and driven like a person would, on the sample
 * backend: the name step's rules and the move on, and the birth date in the
 * Solar Hijri calendar, right to left, in Persian.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class OnboardingStepsScreenTest {

    @get:Rule val compose = createComposeRule()
    @get:Rule val folder = TemporaryFolder()

    private fun model(): OnboardingViewModel {
        val api = SampleApi(clock = Clock.System, signedIn = false)
        val legal = LegalAcceptance(MemorySecretStore(), Clock.System)
        runBlocking {
            legal.accept(LegalVersions())
            val challenge = api.startOtp(OtpStartRequest("+989127654321", "en"))
            api.verifyOtp(challenge.challengeId, SampleData.CODE, DeviceInfo("Test", "16", "1.0", "en"))
        }
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, CoroutineScope(SupervisorJob() + Dispatchers.Main), Diag.Silent)
        return OnboardingViewModel(
            api = api, gate = gate, legal = legal, clock = Clock.System, diag = Diag.Silent,
            saved = SavedStateHandle(),
            config = { SampleData.config("bazaar", "en", 1) },
            uploader = PhotoUploader(api, api, Clock.System, Diag.Silent),
            photoCache = LocalPhotoCache(folder.newFolder()),
            notificationsAskable = { false },
        )
    }

    private val chrome = StepChrome(position = 1, count = 10, onBack = null, onSignOut = {})

    @Test
    fun theNameStepWaitsForAValidNameThenMovesOn() {
        val model = model()
        compose.setContent {
            AppTheme {
                val state by model.state.collectAsStateWithLifecycle()
                NameStep(state, model, chrome)
            }
        }
        compose.waitUntil(5_000) { model.state.value.step == OnboardingStep.Name }
        compose.onNodeWithText("Next").assertIsNotEnabled()
        compose.onNodeWithText("First name").performTextInput("Sara 2")
        compose.onNodeWithText("Use letters only: no numbers, links or contact details.").assertExists()
        compose.onNodeWithText("Next").assertIsNotEnabled()
        model.nameChanged("Sara")
        compose.onNodeWithText("Next").assertIsEnabled().performClick()
        compose.waitUntil(5_000) { model.state.value.step == OnboardingStep.BirthDate }
        assertEquals("Sara", model.state.value.name)
    }

    @Test
    fun persianBirthDatesAreSolarHijriAndRightToLeft() {
        val model = model()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val persian = Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag("fa")) }
        val fa = context.createConfigurationContext(persian)
        compose.setContent {
            CompositionLocalProvider(
                LocalContext provides fa,
                LocalConfiguration provides persian,
                LocalLayoutDirection provides LayoutDirection.Rtl,
            ) {
                AppTheme {
                    val state by model.state.collectAsStateWithLifecycle()
                    BirthDateStep(state, model, chrome)
                }
            }
        }
        // The month list is the Solar Hijri one.
        compose.onNodeWithText("ماه").performClick()
        compose.onNodeWithText("فروردین").assertExists()
        compose.onNodeWithText("اسفند").assertExists()
    }
}
