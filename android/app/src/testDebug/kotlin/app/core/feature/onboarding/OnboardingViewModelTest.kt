package app.core.feature.onboarding

import androidx.lifecycle.SavedStateHandle
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.feature.auth.AuthGate
import app.core.feature.auth.GateNotice
import app.core.feature.auth.Root
import app.core.feature.legal.LegalAcceptance
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.AccountStatus
import app.core.model.ConsentKind
import app.core.model.DeviceInfo
import app.core.model.Gender
import app.core.model.Intention
import app.core.model.LegalVersions
import app.core.model.OnboardingCodes
import app.core.model.OtpStartRequest
import app.core.model.PhotoStatus
import app.core.net.SampleApi
import app.core.net.SampleData
import app.core.storage.MemorySecretStore
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Sign-up against the sample backend: every step writes what it should, the
 * plan carries on from the server's account, and the finish moves the app.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class OnboardingViewModelTest {

    @get:Rule val folder = TemporaryFolder()

    private val clock = FakeClock()
    private val dispatcher = StandardTestDispatcher()
    private val config = SampleData.config("bazaar", "en", 1)

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

    private class Setup(val api: SampleApi, val gate: AuthGate, val legal: LegalAcceptance)

    /** A new account, signed up by phone, with the privacy notice accepted on this install. */
    private fun TestScope.newAccount(waitlist: Boolean = false): Setup {
        val api = SampleApi(clock = clock, signedIn = false, waitlist = waitlist)
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        val legal = LegalAcceptance(MemorySecretStore(), clock)
        kotlinx.coroutines.runBlocking {
            legal.accept(LegalVersions())
            val challenge = api.startOtp(OtpStartRequest("+989127654321", "en"))
            api.verifyOtp(challenge.challengeId, SampleData.CODE, DeviceInfo("Test", "16", "1.0", "en"))
        }
        gate.start()
        runCurrent()
        return Setup(api, gate, legal)
    }

    private fun TestScope.model(s: Setup, askable: Boolean = false): OnboardingViewModel {
        val model = OnboardingViewModel(
            api = s.api, gate = s.gate, legal = s.legal, clock = clock, diag = Diag.Silent,
            saved = SavedStateHandle(),
            config = { config },
            uploader = PhotoUploader(s.api, s.api, clock, Diag.Silent),
            photoCache = LocalPhotoCache(folder.newFolder()),
            notificationsAskable = { askable },
            zone = { ZoneOffset.UTC },
        )
        models += model
        runCurrent()
        return model
    }

    private fun TestScope.advance(ms: Long) {
        clock.advance(ms)
        testScheduler.advanceTimeBy(ms)
        runCurrent()
    }

    private fun bytes() = ByteArray(2_048) { (it % 251).toByte() }

    private suspend fun stored(api: SampleApi) = api.me().value

    /** Name, birth date and gender: the first three steps. */
    private fun TestScope.basics(model: OnboardingViewModel, birth: LocalDate = LocalDate.of(1995, 4, 2)) {
        model.nameChanged("  Sara  ")
        model.submitName()
        runCurrent()
        model.birthDateChanged(birth)
        model.submitBirthDate()
        model.genderChanged(Gender.Woman)
        model.submitBasics()
        runCurrent()
    }

    @Test
    fun `every step writes its answer and the step reached, and the finish lets the account in`() = vmTest {
        val s = newAccount()
        val model = model(s)
        assertEquals(Root.Onboarding, s.gate.root.value)
        assertEquals(OnboardingStep.Name, model.state.value.step)
        assertFalse("nothing to go back to", model.state.value.canGoBack)

        model.nameChanged("Sara2")
        assertFalse("digits are not a name", model.nameValid())
        basics(model)
        var me = stored(s.api)
        assertEquals("Sara", me.profile?.name)
        assertEquals(LocalDate.of(1995, 4, 2), me.profile?.birthDate)
        assertEquals(Gender.Woman, me.profile?.gender)
        assertEquals(OnboardingCodes.INTERESTED_IN, me.onboardingStep)
        assertTrue("the notice's versions went with the basics", ConsentKind.Terms !in me.consentsDue && ConsentKind.Privacy !in me.consentsDue)
        assertEquals(OnboardingStep.InterestedIn, model.state.value.step)
        // Back from here skips the basics, which are set for good.
        assertTrue(model.state.value.canGoBack)

        model.toggleInterest(Gender.Man)
        model.submitInterests()
        runCurrent()
        assertEquals(listOf(Gender.Man), stored(s.api).preferences?.interestedIn)
        assertTrue(s.api.consents().any { it.kind == ConsentKind.GenderMatching })

        model.intentionChanged(Intention.Serious)
        model.submitIntention()
        runCurrent()
        assertEquals(OnboardingStep.Photos, model.state.value.step)

        // Photos: not enough until two are up; uploads go to the presigned target, then processing.
        model.submitPhotos()
        runCurrent()
        assertEquals(OnboardingStep.Photos, model.state.value.step)
        assertTrue(model.photos.add(bytes()))
        assertTrue(model.photos.add(bytes()))
        runCurrent()
        assertTrue(model.photos.state.value.uploading)
        advance(1_000)
        val photos = model.photos.state.value
        assertFalse(photos.uploading)
        assertEquals(2, photos.uploaded.size)
        assertTrue(photos.uploaded.all { it.status == PhotoStatus.Processing })
        assertTrue(photos.enough)
        assertEquals(2, s.api.requestLog.count { it == "sample.upload" })
        // The server's pipeline approves them a few seconds later; the step asks again by itself.
        advance(6_000)
        advance(3_000)
        assertTrue(model.photos.state.value.uploaded.all { it.status == PhotoStatus.Approved })
        model.submitPhotos()
        runCurrent()
        assertEquals(OnboardingStep.Prompts, model.state.value.step)

        model.promptAdded(1)
        model.promptAnswered(1, "Hiking in the mountains at dawn")
        model.submitPrompts()
        runCurrent()
        assertEquals("Hiking in the mountains at dawn", stored(s.api).profile?.prompts?.single()?.answer)

        assertEquals(OnboardingStep.Fields, model.state.value.step)
        assertFalse("the sensitive field is not offered", model.offeredFields().any { it.sensitive })
        model.fieldChanged(1, FieldAnswer(number = 170))
        model.fieldChanged(2, FieldAnswer(option = 21))
        model.submitFields()
        runCurrent()
        assertEquals(setOf(1, 2), stored(s.api).profile?.fields?.map { it.fieldId }?.toSet())

        assertEquals(OnboardingStep.Location, model.state.value.step)
        model.cityQueryChanged("ته")
        advance(400)
        val tehran = model.state.value.cityResults.first()
        model.cityPicked(tehran)
        runCurrent()
        assertTrue(model.state.value.location is LocationPhase.Set)
        model.submitLocation()
        runCurrent()

        // No notification permission to ask for on this phone: straight to the guidelines.
        assertEquals(OnboardingStep.Guidelines, model.state.value.step)
        model.acceptGuidelines()
        runCurrent()
        me = stored(s.api)
        assertEquals(AccountStatus.Active, me.status)
        assertTrue(me.consentsDue.isEmpty())
        assertEquals(Root.Main, s.gate.root.value)
    }

    @Test
    fun `a sign-up stopped half-way carries on at the same step in a new session`() = vmTest {
        val s = newAccount()
        val first = model(s)
        basics(first)
        first.toggleInterest(Gender.Nonbinary)
        first.submitInterests()
        runCurrent()

        val again = model(s)
        assertEquals(OnboardingStep.Intention, again.state.value.step)
        assertEquals("Sara", again.state.value.name)
        assertEquals(setOf(Gender.Nonbinary), again.state.value.interestedIn)
    }

    @Test
    fun `under 18 closes the account and signs out`() = vmTest {
        val s = newAccount()
        val model = model(s)
        basics(model, birth = LocalDate.ofInstant(clock.now(), ZoneOffset.UTC).minusYears(15))
        runCurrent()
        assertEquals(Root.SignIn, s.gate.root.value)
        assertEquals(GateNotice.AccountClosed, s.gate.notice.value)
        assertFalse(s.api.hasSession())
    }

    @Test
    fun `a refused photo does not count, and can be removed`() = vmTest {
        val s = newAccount()
        val model = model(s)
        basics(model)
        model.toggleInterest(Gender.Man)
        model.submitInterests()
        runCurrent()
        model.intentionChanged(Intention.Friendship)
        model.submitIntention()
        runCurrent()
        repeat(4) { model.photos.add(bytes()) }
        advance(2_000)
        advance(6_000)
        advance(3_000)
        val tiles = model.photos.state.value
        val refused = tiles.uploaded.single { it.status == PhotoStatus.Rejected }
        assertEquals(3, tiles.usable)
        model.photos.remove("p:${refused.id}")
        runCurrent()
        assertTrue(model.photos.state.value.uploaded.none { it.id == refused.id })
        assertTrue(stored(s.api).profile!!.photos.none { it.id == refused.id })
    }

    @Test
    fun `photos reorder on the server, the first being the main one`() = vmTest {
        val s = newAccount()
        val model = model(s)
        basics(model)
        model.toggleInterest(Gender.Man)
        model.submitInterests()
        runCurrent()
        model.intentionChanged(Intention.Marriage)
        model.submitIntention()
        runCurrent()
        repeat(3) { model.photos.add(bytes()) }
        advance(2_000)
        val before = model.photos.state.value.uploaded.map { it.id }
        model.photos.move(2, 0)
        runCurrent()
        val expected = listOf(before[2], before[0], before[1])
        assertEquals(expected, model.photos.state.value.uploaded.map { it.id })
        assertEquals(expected, stored(s.api).profile!!.photos.sortedBy { it.position }.map { it.id })
    }

    @Test
    fun `with the review queue on, a finished sign-up waits for the review`() = vmTest {
        val s = newAccount(waitlist = true)
        val model = model(s)
        basics(model)
        model.toggleInterest(Gender.Man)
        model.submitInterests()
        runCurrent()
        model.intentionChanged(Intention.NotSure)
        model.submitIntention()
        runCurrent()
        repeat(2) { model.photos.add(bytes()) }
        advance(2_000)
        model.submitPhotos()
        runCurrent()
        model.submitPrompts(skip = true)
        runCurrent()
        model.submitFields(skip = true)
        runCurrent()
        model.cityPicked(SampleData.city(745044))
        runCurrent()
        model.submitLocation()
        runCurrent()
        model.acceptGuidelines()
        runCurrent()
        assertEquals(Root.Review, s.gate.root.value)
        assertEquals(AccountStatus.PendingReview, stored(s.api).status)
    }

    @Test
    fun `the last step with something missing on the server goes back to it`() = vmTest {
        val s = newAccount()
        val model = model(s)
        basics(model)
        model.toggleInterest(Gender.Man)
        model.submitInterests()
        runCurrent()
        model.intentionChanged(Intention.Serious)
        model.submitIntention()
        runCurrent()
        repeat(2) { model.photos.add(bytes()) }
        advance(2_000)
        model.submitPhotos()
        runCurrent()
        model.submitPrompts(skip = true)
        runCurrent()
        model.submitFields(skip = true)
        runCurrent()
        model.cityPicked(SampleData.city(112931))
        runCurrent()
        model.submitLocation()
        runCurrent()
        // Another phone removed a photo meanwhile.
        s.api.deletePhoto(stored(s.api).profile!!.photos.first().id)
        model.acceptGuidelines()
        runCurrent()
        assertEquals(Root.Onboarding, s.gate.root.value)
        assertEquals(OnboardingStep.Photos, model.state.value.step)
        assertEquals(StepError.Incomplete, model.state.value.error)
    }
}
