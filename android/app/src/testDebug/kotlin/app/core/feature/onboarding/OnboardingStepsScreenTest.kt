package app.core.feature.onboarding

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDates
import org.junit.Assert.assertNotEquals
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
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
import app.core.ui.theme.Templates
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.util.Locale

/**
 * Sign-up screens drawn and driven like a person would, on the sample
 * backend: the name step's rules and the move on; the birth date on the
 * Solar Hijri wheels, right to left, chosen only once a wheel moves, kept as
 * the wheel shows it after a drag and after the screen is made again in
 * another language; the location step with an area kept; the height in
 * centimetres, and nothing while it is not set.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class OnboardingStepsScreenTest {

    @get:Rule val compose = createComposeRule()
    @get:Rule val folder = TemporaryFolder()

    /** The sample backend of the last [model]. */
    private lateinit var api: SampleApi

    private fun model(locale: String = "en"): OnboardingViewModel {
        val api = SampleApi(clock = Clock.System, signedIn = false).also { this.api = it }
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
            config = { SampleData.config("bazaar", locale, 1) },
            uploader = PhotoUploader(api, api, Clock.System, Diag.Silent),
            photoCache = LocalPhotoCache(folder.newFolder()),
            notificationsAskable = { false },
        )
    }

    private val chrome = StepChrome(position = 1, count = 10, onBack = {})

    /** [content] in Persian, right to left, in the white template. */
    private fun persian(content: @Composable () -> Unit) {
        compose.setContent { InLanguage("fa") { content() } }
    }

    /** [content] in the language [tag] (Persian right to left), in the white template. */
    @Composable
    private fun InLanguage(tag: String, content: @Composable () -> Unit) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val configuration = Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) }
        CompositionLocalProvider(
            LocalContext provides context.createConfigurationContext(configuration),
            LocalConfiguration provides configuration,
            LocalLayoutDirection provides if (tag == "fa") LayoutDirection.Rtl else LayoutDirection.Ltr,
        ) {
            AppTheme(template = Templates.of(Templates.WHITE)) { content() }
        }
    }

    @Test
    fun theNameStepWaitsForAValidNameThenMovesOn() {
        val model = model()
        compose.setContent {
            AppTheme(template = Templates.of(Templates.NEON)) {
                val state by model.state.collectAsStateWithLifecycle()
                NameStep(state, model, chrome)
            }
        }
        compose.waitUntil(5_000) { model.state.value.step == OnboardingStep.Name }
        compose.onNodeWithText("Continue").assertIsNotEnabled()
        compose.onNode(hasSetTextAction() and hasContentDescription("What’s your name?")).performTextInput("Sara 2")
        compose.onNodeWithText("Letters only, no numbers or links.").assertExists()
        compose.onNodeWithText("Continue").assertIsNotEnabled()
        // The count reads the name as typed («6/20»), against the 20 a first name may have.
        compose.onNodeWithText("6/20").assertExists()
        model.nameChanged("Sara")
        compose.onNodeWithText("Continue").assertIsEnabled().performClick()
        compose.waitUntil(5_000) { model.state.value.step == OnboardingStep.BirthDate }
        assertEquals("Sara", model.state.value.name)
    }

    @Test
    fun persianBirthDatesAreSolarHijriWheelsRightToLeft() {
        val model = model()
        persian {
            val state by model.state.collectAsStateWithLifecycle()
            BirthDateStep(state, model, chrome)
        }
        val month = wheel("ماه")
        assertEquals("فروردین", month.config[SemanticsProperties.StateDescription])
        compose.onNode(hasContentDescription("ماه") and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it(11f) }
        compose.waitForIdle()
        assertEquals("اسفند", wheel("ماه").config[SemanticsProperties.StateDescription])
        // Day, month, year from the start: the day on the right, the year on the left.
        val day = wheel("روز").boundsInRoot
        val year = wheel("سال").boundsInRoot
        assertTrue("the day wheel is right of the year wheel: $day / $year", day.left > year.left)
    }

    @Test
    fun aBirthDateIsKeptOnlyOnceAWheelMovesThenTheAgeAndThatItStaysShow() {
        val model = model()
        persian {
            val state by model.state.collectAsStateWithLifecycle()
            BirthDateStep(state, model, chrome)
        }
        // The wheels rest on a date nobody chose: none is kept, no age, «ادامه» off.
        compose.waitForIdle()
        assertNull(model.state.value.birthDate)
        compose.onNodeWithText("ادامه").assertIsNotEnabled()
        assertTrue(compose.onAllNodes(hasText("سالته", substring = true)).fetchSemanticsNodes().isEmpty())
        // The day moved to 14: the date is the wheels' (25 years back) and the line says the age, once.
        compose.onNode(hasContentDescription("روز") and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it(13f) }
        compose.waitForIdle()
        val born = checkNotNull(model.state.value.birthDate)
        val age = java.time.Period.between(born, model.today()).years
        assertTrue("about 25: $age", age in 24..25)
        val digits = age.toString().map { '۰' + (it - '0') }.joinToString("")
        compose.onNodeWithText("$digits سالته. بعداً عوض نمی‌شه.").assertExists()
        compose.onNodeWithText("ادامه").assertIsEnabled()
    }

    @Test
    fun theBirthDateIsAskedAboutOnceMoreBeforeItIsKept() {
        val model = model()
        persian {
            val state by model.state.collectAsStateWithLifecycle()
            BirthDateStep(state, model, chrome)
        }
        compose.waitUntil(5_000) { model.state.value.step != null }
        val before = model.state.value.step
        compose.onNode(hasContentDescription("روز") and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it(13f) }
        compose.waitForIdle()
        val born = checkNotNull(model.state.value.birthDate)
        val age = java.time.Period.between(born, model.today()).years
        val digits = age.toString().map { '۰' + (it - '0') }.joinToString("")
        // «ادامه» asks first: the age and the date, and nothing moves on while it is open.
        compose.onNodeWithText("ادامه").performClick()
        compose.onNodeWithText("$digits سالته؟").assertExists()
        compose.onNodeWithText("متولد ${formatDate(born, AppLanguage.FA)}. بعداً عوض نمی‌شه.").assertExists()
        assertEquals(before, model.state.value.step)
        // «ویرایش» goes back to the wheels with nothing kept on the server.
        compose.onNodeWithText("ویرایش").performClick()
        compose.waitForIdle()
        assertTrue(compose.onAllNodes(hasText("سالته؟", substring = true)).fetchSemanticsNodes().isEmpty())
        assertEquals(before, model.state.value.step)
        // Asked again and confirmed: the step moves on to the gender.
        compose.onNodeWithText("ادامه").performClick()
        compose.onNodeWithText("درسته").performClick()
        compose.waitUntil(5_000) { model.state.value.step == OnboardingStep.Gender }
        assertEquals(born, model.state.value.birthDate)
    }

    @Test
    fun aWheelDraggedToAnotherYearKeepsTheYearShownInTheBand() {
        val model = model()
        persian {
            val state by model.state.collectAsStateWithLifecycle()
            BirthDateStep(state, model, chrome)
        }
        compose.waitForIdle()
        val before = wheel("سال").config[SemanticsProperties.StateDescription]
        // A finger drag and fling, not TalkBack's set-progress: the year kept is the one the wheel comes to rest on.
        compose.onNode(hasContentDescription("سال") and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress)).performTouchInput { swipeUp() }
        compose.waitForIdle()
        val shown = wheel("سال").config[SemanticsProperties.StateDescription]
        assertNotEquals("the drag moved the wheel", before, shown)
        val born = checkNotNull(model.state.value.birthDate) { "a drag chooses a date" }
        assertEquals(shown, Digits.localize(JalaliDates.toJalali(born).year.toString(), AppLanguage.FA))
    }

    @Test
    fun wheelsBroughtBackInAnotherLanguageShowTheSameDate() {
        val model = model()
        var tag by mutableStateOf("fa")
        val restore = StateRestorationTester(compose)
        restore.setContent {
            InLanguage(tag) {
                val state by model.state.collectAsStateWithLifecycle()
                BirthDateStep(state, model, chrome)
            }
        }
        compose.onNode(hasContentDescription("روز") and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it(13f) }
        compose.waitForIdle()
        val born = checkNotNull(model.state.value.birthDate)
        // The screen is made again in English (a per-app language change): the wheels show the same day in the
        // Gregorian calendar, not the Solar Hijri year read as a Gregorian one.
        tag = "en"
        restore.emulateSavedInstanceStateRestore()
        compose.waitForIdle()
        assertEquals(born.year.toString(), wheel("Year").config[SemanticsProperties.StateDescription])
        compose.onNode(hasContentDescription("Day") and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it((born.dayOfMonth - 1).toFloat()) }
        compose.waitForIdle()
        assertEquals(born, model.state.value.birthDate)
    }

    @Test
    fun withAnAreaKeptTheLocationStepGoesOnWithoutAskingForItAgain() {
        val model = model()
        compose.waitUntil(5_000) { model.state.value.step != null }
        model.cityPicked(SampleData.city(112931))
        compose.waitUntil(5_000) { model.state.value.location is LocationPhase.Set && !model.state.value.busy }
        val located = api.requestLog.count { it == "me.location" }
        val written = api.requestLog.count { it == "me.profile" }
        compose.setContent {
            AppTheme(template = Templates.of(Templates.NEON)) {
                val state by model.state.collectAsStateWithLifecycle()
                LocationStep(state, model, chrome)
            }
        }
        // Back on the step with the area kept: «ادامه» passes it, no new fix or city.
        compose.onNodeWithText("Use my location").assertDoesNotExist()
        compose.onNodeWithText("Continue").assertIsEnabled().performClick()
        compose.waitUntil(5_000) { api.requestLog.count { it == "me.profile" } == written + 1 && !model.state.value.busy }
        assertEquals(located, api.requestLog.count { it == "me.location" })
    }

    @Test @Config(qualifiers = "w360dp-h640dp", fontScale = 1.5f)
    fun theDoneTitleIsWholeOnASmallPhoneWithLargeTextInEnglish() = doneTitleIsWhole("en", "Alexandria-Margarita")

    @Test @Config(qualifiers = "w360dp-h640dp", fontScale = 1.5f)
    fun theDoneTitleIsWholeOnASmallPhoneWithLargeTextInTurkish() = doneTitleIsWhole("tr", "Alexandria-Margarita")

    @Test @Config(qualifiers = "w360dp-h640dp", fontScale = 1.5f)
    fun theDoneTitleIsWholeOnASmallPhoneWithLargeTextInPersian() = doneTitleIsWhole("fa", "اسکندر عبدالرحمانیان")

    /** The done screen with a 20-letter [name]: the title keeps every line (the card gives way, then the page scrolls). */
    private fun doneTitleIsWhole(tag: String, name: String) {
        val model = model()
        compose.waitUntil(5_000) { model.state.value.step != null }
        val done = model.state.value.copy(name = name, done = app.core.model.AuthUser("u", app.core.model.AccountStatus.Active, 0))
        compose.setContent { InLanguage(tag) { DoneStep(done, model, onLeave = {}) } }
        compose.waitForIdle()
        val title = compose.onNode(hasText(name, substring = true) and SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
        val layout = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        title.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
        assertTrue("the title is cut off ($tag)", layout.isNotEmpty() && !layout.first().hasVisualOverflow)
        title.performScrollTo().assertIsDisplayed()
    }

    @Test
    fun theHeightReadsInCentimetresAndShowsNothingWhileNotSet() {
        val model = model(locale = "fa")
        persian {
            val state by model.state.collectAsStateWithLifecycle()
            FieldsStep(state, model, chrome)
        }
        compose.waitUntil(5_000) { model.state.value.config != null }
        compose.waitForIdle()
        // Not set: no value beside «قد», not «cm», not «انتخاب نشده».
        assertTrue(compose.onAllNodes(hasText("سانتی‌متر", substring = true)).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasText("cm", substring = true)).fetchSemanticsNodes().isEmpty())
        model.fieldChanged(1, FieldAnswer(number = 178))
        compose.waitForIdle()
        compose.onNodeWithText("۱۷۸ سانتی‌متر").assertExists()
    }

    @Test
    fun aHeightMovedByMistakeCanBeClearedAlone() {
        val model = model(locale = "fa")
        persian {
            val state by model.state.collectAsStateWithLifecycle()
            FieldsStep(state, model, chrome)
        }
        compose.waitUntil(5_000) { model.state.value.config != null }
        compose.waitForIdle()
        // Nothing set: nothing to clear.
        assertTrue(compose.onAllNodes(hasContentDescription("پاک کردن قد")).fetchSemanticsNodes().isEmpty())
        model.fieldChanged(1, FieldAnswer(number = 178))
        model.fieldChanged(2, FieldAnswer(option = 21))
        compose.waitForIdle()
        compose.onNode(hasContentDescription("پاک کردن قد")).performClick()
        compose.waitForIdle()
        assertNull(model.state.value.fields[1]?.number)
        // The other answers on the step stay.
        assertEquals(21, model.state.value.fields[2]?.option)
        assertTrue(compose.onAllNodes(hasText("۱۷۸ سانتی‌متر")).fetchSemanticsNodes().isEmpty())
    }

    private fun wheel(label: String) =
        compose.onNode(hasContentDescription(label) and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress)).fetchSemanticsNode()
}
