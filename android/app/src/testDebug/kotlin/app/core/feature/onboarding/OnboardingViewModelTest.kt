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
import app.core.model.Me
import app.core.model.OnboardingCodes
import app.core.model.OtpStartRequest
import app.core.model.PhotoStatus
import app.core.net.ApiError
import app.core.net.Fetched
import app.core.net.SampleApi
import app.core.net.ServerApi
import app.core.net.SampleData
import app.core.storage.MemorySecretStore
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
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

    /**
     * [sample] whose GET /v1/me is counted and, while held, answered only at
     * release (read first, as an answer still in transit) or lost at [fail];
     * while [failing], every read is lost at once.
     */
    private class HeldMe(private val sample: SampleApi) : ServerApi by sample {
        var sent = 0
            private set
        var failing = false
        private var gate: CompletableDeferred<Unit>? = null

        fun hold() {
            gate = CompletableDeferred()
        }

        fun release() {
            gate?.complete(Unit)
            gate = null
        }

        fun fail() {
            gate?.completeExceptionally(ApiError.Network(IOException("lost")))
            gate = null
        }

        override suspend fun me(): Fetched<Me> {
            sent++
            if (failing) throw ApiError.Network(IOException("offline"))
            val answer = sample.me()
            gate?.await()
            return answer
        }
    }

    private fun TestScope.model(s: Setup, askable: Boolean = false, api: ServerApi = s.api): OnboardingViewModel {
        val model = OnboardingViewModel(
            api = api, gate = s.gate, legal = s.legal, clock = clock, diag = Diag.Silent,
            saved = SavedStateHandle(),
            config = { config },
            uploader = PhotoUploader(api, s.api, clock, Diag.Silent),
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

    /** From a new account to the location step: the basics, who to meet, the intention, two photos, prompts and fields skipped. */
    private fun TestScope.reachLocation(model: OnboardingViewModel) {
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
    }

    /** Every step, to the done screen. */
    private fun TestScope.finishSignUp(model: OnboardingViewModel) {
        reachLocation(model)
        model.cityPicked(SampleData.city(112931))
        runCurrent()
        model.acceptGuidelines()
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
        // The area kept is the whole step: it is passed at once.
        assertTrue(model.state.value.location is LocationPhase.Set)
        assertEquals(OnboardingCodes.NOTIFICATIONS, stored(s.api).onboardingStep)

        // No notification permission to ask for on this phone: straight to the guidelines.
        assertEquals(OnboardingStep.Guidelines, model.state.value.step)
        model.acceptGuidelines()
        runCurrent()
        me = stored(s.api)
        assertEquals(AccountStatus.Active, me.status)
        assertTrue(me.consentsDue.isEmpty())
        // Finished: the done screen holds until the person moves on, then the app opens on its deck.
        assertEquals(AccountStatus.Active, model.state.value.done?.status)
        assertEquals(Root.Onboarding, s.gate.root.value)
        var profileAsked = false
        model.leave { profileAsked = true }
        assertFalse("«بریم» goes to the deck", profileAsked)
        assertEquals(Root.Main, s.gate.root.value)
    }

    @Test
    fun `from the done screen the profile can be asked for, not while the profile waits for a review`() = vmTest {
        for (waitlist in listOf(false, true)) {
            val s = newAccount(waitlist = waitlist)
            val model = model(s)
            finishSignUp(model)
            assertEquals(Root.Onboarding, s.gate.root.value)
            var profileAsked = false
            model.leave(profile = true) { profileAsked = true }
            assertEquals(!waitlist, profileAsked)
            assertEquals(if (waitlist) Root.Review else Root.Main, s.gate.root.value)
        }
    }

    @Test
    fun `the done screen stays while a photo still in review is decided`() = vmTest {
        val s = newAccount()
        val model = model(s)
        // The second photo stays in review past the finish, so the processing poll is still running then.
        SampleData.photosHeldInReview = setOf(1)
        try {
            finishSignUp(model)
            assertTrue("a photo is still in review", model.photos.state.value.processing)
            val done = checkNotNull(model.state.value.done)
            assertEquals(Root.Main, Root.of(done))
            // The moderator lets it through; the poll's next turns would read an account out of sign-up.
            SampleData.photosHeldInReview = emptySet()
            repeat(6) { advance(15_000) }
            assertEquals("nothing moves the app under the done screen", Root.Onboarding, s.gate.root.value)
            assertEquals(done, model.state.value.done)
            model.leave()
            assertEquals(Root.Main, s.gate.root.value)
        } finally {
            SampleData.photosHeldInReview = emptySet()
        }
    }

    @Test
    fun `notifications switched off are kept on the account before the phone is asked`() = vmTest {
        val s = newAccount()
        val model = model(s, askable = true)
        reachLocation(model)
        model.cityPicked(SampleData.city(112931))
        runCurrent()
        assertEquals(OnboardingStep.Notifications, model.state.value.step)
        var asked = false
        model.turnOnNotifications(matches = true, messages = false) { asked = true }
        runCurrent()
        assertTrue(asked)
        val prefs = checkNotNull(stored(s.api).notifications)
        assertTrue(prefs.matches && prefs.likes)
        assertFalse(prefs.messages || prefs.calls)
        model.submitNotifications()
        runCurrent()
        assertEquals(OnboardingStep.Guidelines, model.state.value.step)
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
        model.acceptGuidelines()
        runCurrent()
        assertEquals(AccountStatus.PendingReview, stored(s.api).status)
        model.leave()
        assertEquals(Root.Review, s.gate.root.value)
    }

    @Test
    fun `sign-up closed in the person's country says so at the location step and again at the finish`() = vmTest {
        val s = newAccount()
        val model = model(s)
        reachLocation(model)
        s.api.closeSignUp("TR")
        model.cityPicked(SampleData.city(745044))
        runCurrent()
        assertEquals(OnboardingStep.Location, model.state.value.step)
        assertEquals(StepError.CountryClosed, model.state.value.error)
        assertTrue("nothing kept", model.state.value.location !is LocationPhase.Set)
        assertNull(stored(s.api).location?.city)

        // Open where the person is: the step passes. Closed there afterwards: the finish says so too.
        model.cityPicked(SampleData.city(112931))
        runCurrent()
        assertNull(model.state.value.error)
        s.api.closeSignUp("IR")
        model.acceptGuidelines()
        runCurrent()
        assertEquals(StepError.CountryClosed, model.state.value.error)
        assertEquals(AccountStatus.Onboarding, stored(s.api).status)
        assertEquals(Root.Onboarding, s.gate.root.value)
        assertNull(model.state.value.done)
    }

    @Test
    fun `a phone fix in a closed country says so on the step and opens no city list`() = vmTest {
        val s = newAccount()
        val model = model(s)
        reachLocation(model)
        s.api.closeSignUp("TR")
        val (lat, lng) = SampleData.cityCentres.getValue(745044)
        model.locating()
        model.located(lat, lng, accuracyM = 3_000, fromGps = true)
        runCurrent()
        assertEquals(OnboardingStep.Location, model.state.value.step)
        assertEquals(StepError.CountryClosed, model.state.value.error)
        // Not "we couldn't find you": the step is back to its button, with the country line on it.
        assertEquals(LocationPhase.Idle, model.state.value.location)
        assertNull(stored(s.api).location?.city)
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
        // Another phone removed a photo meanwhile.
        s.api.deletePhoto(stored(s.api).profile!!.photos.first().id)
        model.acceptGuidelines()
        runCurrent()
        assertEquals(Root.Onboarding, s.gate.root.value)
        assertEquals(OnboardingStep.Photos, model.state.value.step)
        assertEquals(StepError.Incomplete, model.state.value.error)
    }

    // MARK: - One account read at a time

    @Test
    fun `the resume on the first frame takes the opening read's answer`() = vmTest {
        val s = newAccount()
        val held = HeldMe(s.api)
        held.hold()
        val model = model(s, api = held)
        // The screen's first ON_RESUME comes while the opening load is out.
        model.refresh(quiet = true)
        runCurrent()
        assertEquals(1, held.sent)
        held.release()
        runCurrent()
        assertEquals(1, held.sent)
        assertEquals(OnboardingStep.Name, model.state.value.step)
        // A later resume still reads.
        model.refresh(quiet = true)
        runCurrent()
        assertEquals(2, held.sent)
    }

    @Test
    fun `two resumes close together send one read`() = vmTest {
        val s = newAccount()
        val held = HeldMe(s.api)
        val model = model(s, api = held)
        val before = held.sent
        held.hold()
        model.refresh(quiet = true)
        runCurrent()
        model.refresh(quiet = true)
        runCurrent()
        assertEquals(before + 1, held.sent)
        held.release()
        runCurrent()
        assertEquals(before + 1, held.sent)
        model.refresh(quiet = true)
        model.refresh(quiet = true)
        runCurrent()
        assertEquals(before + 2, held.sent)
    }

    @Test
    fun `the photo poll takes the answer of a read already out`() = vmTest {
        SampleData.photosHeldInReview = setOf(0, 1)
        try {
            val s = newAccount()
            val held = HeldMe(s.api)
            val model = model(s, api = held)
            basics(model)
            model.toggleInterest(Gender.Man)
            model.submitInterests()
            runCurrent()
            model.intentionChanged(Intention.Serious)
            model.submitIntention()
            runCurrent()
            repeat(2) { model.photos.add(bytes()) }
            advance(2_000)
            assertTrue(model.photos.state.value.processing)
            val before = held.sent
            held.hold()
            model.refresh(quiet = true)
            runCurrent()
            repeat(4) { advance(5_000) }
            assertEquals("the poll's turns wait for the read already out", before + 1, held.sent)
            held.release()
            runCurrent()
            assertEquals(before + 1, held.sent)
            advance(15_000)
            assertTrue("the poll still asks on its own", held.sent > before + 1)
        } finally {
            SampleData.photosHeldInReview = emptySet()
        }
    }

    @Test
    fun `an upload that finishes while a read is out is read once more`() = vmTest {
        val s = newAccount()
        val held = HeldMe(s.api)
        val model = model(s, api = held)
        basics(model)
        model.toggleInterest(Gender.Man)
        model.submitInterests()
        runCurrent()
        model.intentionChanged(Intention.Serious)
        model.submitIntention()
        runCurrent()
        assertEquals(OnboardingStep.Photos, model.state.value.step)
        val before = held.sent
        held.hold()
        model.refresh(quiet = true)
        runCurrent()
        assertTrue(model.photos.add(bytes()))
        advance(1_000)
        assertFalse(model.photos.state.value.uploading)
        held.release()
        runCurrent()
        // The read out was sent before the upload: one more follows it, and the new photo stays.
        assertEquals(before + 2, held.sent)
        assertEquals(1, model.photos.state.value.uploaded.size)
    }

    @Test
    fun `a locate cut short by leaving the step gives the button back`() = vmTest {
        val s = newAccount()
        val model = model(s)
        reachLocation(model)
        assertEquals(OnboardingStep.Location, model.state.value.step)
        val looking = launch { model.locate { awaitCancellation() } }
        runCurrent()
        assertEquals(LocationPhase.Locating, model.state.value.location)
        // Back while the phone looks (busy is not set for it): the step leaves the screen, and its scope with it.
        assertTrue(model.back())
        looking.cancel()
        runCurrent()
        assertEquals(LocationPhase.Idle, model.state.value.location)
        // On again: the step's button works, and a fix it finds is kept.
        model.submitFields(skip = true)
        runCurrent()
        assertEquals(OnboardingStep.Location, model.state.value.step)
        launch { model.locate { CoarseFix(35.71, 51.4, 2_000, fromGps = false) } }
        runCurrent()
        assertTrue(model.state.value.location is LocationPhase.Set)
        assertEquals(OnboardingCodes.NOTIFICATIONS, stored(s.api).onboardingStep)
    }

    @Test
    fun `a locate that finds nothing leaves the city list as the way`() = vmTest {
        val s = newAccount()
        val model = model(s)
        reachLocation(model)
        launch { model.locate { null } }
        runCurrent()
        assertEquals(LocationPhase.Unavailable, model.state.value.location)
    }

    /** From a new account to the photos step, with nothing uploaded yet. */
    private fun TestScope.reachPhotos(model: OnboardingViewModel) {
        basics(model)
        model.toggleInterest(Gender.Man)
        model.submitInterests()
        runCurrent()
        model.intentionChanged(Intention.Serious)
        model.submitIntention()
        runCurrent()
        assertEquals(OnboardingStep.Photos, model.state.value.step)
    }

    @Test
    fun `an upload that finishes while a read is out still gets its read when that one fails`() = vmTest {
        val s = newAccount()
        val held = HeldMe(s.api)
        val model = model(s, api = held)
        reachPhotos(model)
        val before = held.sent
        // Back from the photo picker: the resume's read goes out on a link that then drops it.
        held.hold()
        model.refresh(quiet = true)
        runCurrent()
        assertTrue(model.photos.add(bytes()))
        advance(1_000)
        assertFalse(model.photos.state.value.uploading)
        held.fail()
        runCurrent()
        assertEquals("the upload's own read follows the one lost", before + 2, held.sent)
        // That read brought the account: the photo is the server's, and the server's pipeline is followed to its answer.
        assertEquals(1, model.photos.state.value.uploaded.size)
        repeat(4) { advance(3_000) }
        assertTrue(model.photos.state.value.uploaded.single().status == PhotoStatus.Approved)
    }

    @Test
    fun `a photo uploaded while every read fails is still watched until the server answers`() = vmTest {
        val s = newAccount()
        val held = HeldMe(s.api)
        val model = model(s, api = held)
        reachPhotos(model)
        held.failing = true
        val before = held.sent
        assertTrue(model.photos.add(bytes()))
        advance(1_000)
        assertFalse(model.photos.state.value.uploading)
        assertEquals("the upload's read was sent and lost", before + 1, held.sent)
        assertTrue(model.photos.state.value.processing)
        // The link comes back: the photo poll, started by the upload itself, asks again.
        held.failing = false
        repeat(5) { advance(3_000) }
        assertTrue(held.sent > before + 1)
        assertEquals(PhotoStatus.Approved, model.photos.state.value.uploaded.single().status)
        assertFalse(model.photos.state.value.processing)
    }
}
