package app.core.feature.profile

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.R
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.feature.onboarding.FieldAnswer
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.OwnProfile
import app.core.model.ProfilePatch
import app.core.net.SampleApi
import app.core.net.ServerApi
import app.core.net.SampleData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The profile editor saves each part on its own through `PATCH /v1/me/profile`
 * (questions in their positions, fields, the job, the about text) and keeps
 * the profile as the server answers it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EditProfileModelTest {

    @get:Rule val folder = TemporaryFolder()

    private val clock = FakeClock()
    private val dispatcher = StandardTestDispatcher()
    private val config = SampleData.config("bazaar", "en", 1)

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.ownPhotos(api: SampleApi) =
        OwnPhotos(api, PhotoUploader(api, api, clock, Diag.Silent), LocalPhotoCache(folder.newFolder()), backgroundScope, Diag.Silent)

    private fun TestScope.model(api: SampleApi = SampleApi(clock = clock), photos: OwnPhotos = ownPhotos(api)): EditProfileModel {
        val model = EditProfileModel(api, photos, clock) { config }
        runCurrent()
        return model
    }

    @Test
    fun theEditorReadsTheAccountsOwnProfile() = runTest(dispatcher) {
        val model = model()
        val profile = model.state.value.profile
        assertEquals("Sam", profile?.name)
        assertEquals(listOf(1, 4), model.prompts().map { it.promptId })
        // The photos come from the same answer.
        assertEquals(profile?.photos?.size, model.photos.state.value.uploaded.size)
        // Sensitive fields are not offered here (they need a consent this screen does not ask for).
        assertEquals(listOf(1, 5, 2, 3), model.fields().map { it.id })
        model.viewModelScope.cancel()
    }

    @Test
    fun aNewAnswerTakesTheFirstFreePosition() = runTest(dispatcher) {
        val model = model()
        assertEquals(SaveOutcome.Saved, model.savePrompt(5, "  Pineapple belongs on pizza  "))
        val prompts = model.prompts()
        assertEquals(listOf(1, 4, 5), prompts.map { it.promptId })
        assertEquals(2, prompts.last().position)
        assertEquals("Pineapple belongs on pizza", prompts.last().answer)
        model.viewModelScope.cancel()
    }

    @Test
    fun anAnswerIsEditedInPlaceChangedAndRemoved() = runTest(dispatcher) {
        val model = model()
        val first = model.prompts().first()
        model.savePrompt(first.promptId, "A sleeper train to the sea", replacing = first)
        assertEquals("A sleeper train to the sea", model.prompts().first().answer)
        assertEquals(0, model.prompts().first().position)

        // Another question in the second place.
        val second = model.prompts()[1]
        model.savePrompt(6, "My laugh", replacing = second)
        assertEquals(listOf(1, 6), model.prompts().map { it.promptId })
        assertEquals(1, model.prompts()[1].position)

        model.removePrompt(model.prompts()[1])
        assertEquals(listOf(1), model.prompts().map { it.promptId })
        model.viewModelScope.cancel()
    }

    @Test
    fun noMoreQuestionsThanTheCataloguesLimit() = runTest(dispatcher) {
        val model = model()
        model.savePrompt(5, "One")
        assertEquals(SaveOutcome.Failed(R.string.settings_save_failed), model.savePrompt(6, "Two"))
        assertEquals(3, model.prompts().size)
        model.viewModelScope.cancel()
    }

    @Test
    fun fieldsTheJobAndTheAboutTextAreSavedOneByOne() = runTest(dispatcher) {
        val model = model()
        val height = model.fields().first { it.id == 1 }
        val smoking = model.fields().first { it.id == 2 }
        model.saveField(height, FieldAnswer(number = 180))
        assertEquals(180, model.state.value.profile?.fields?.first { it.fieldId == 1 }?.number)
        // An empty answer removes the field.
        model.saveField(smoking, FieldAnswer())
        assertNull(model.state.value.profile?.fields?.firstOrNull { it.fieldId == 2 })
        model.saveJob(" Architect ")
        assertEquals("Architect", model.state.value.profile?.job)
        model.saveAbout(" Maps and coffee. ")
        assertEquals("Maps and coffee.", model.state.value.profile?.about)
        model.viewModelScope.cancel()
    }

    @Test
    fun aRefusedTextSaysWhyAndKeepsTheProfile() = runTest(dispatcher) {
        val model = model()
        val before = model.state.value.profile?.about
        // The sheet stays open with what was written and this line under it.
        assertEquals(SaveOutcome.Failed(R.string.onboarding_error_text_refused), model.saveAbout("a refusedword here"))
        assertEquals(before, model.state.value.profile?.about)
        assertFalse(model.state.value.saving)
        model.viewModelScope.cancel()
    }

    @Test
    fun aSecondSaveWhileTheFirstIsOutIsNotSent() = runTest(dispatcher) {
        val sample = SampleApi(clock = clock)
        // A server that takes a moment to answer.
        val slow = object : ServerApi by sample {
            override suspend fun updateProfile(patch: ProfilePatch): OwnProfile {
                delay(1_000)
                return sample.updateProfile(patch)
            }
        }
        val model = EditProfileModel(slow, ownPhotos(sample), clock) { config }
        runCurrent()
        val first = async { model.saveJob("Architect") }
        runCurrent()
        // The first is on its way (the sheet's button waits): a second tap sends nothing.
        assertTrue(model.state.value.saving)
        assertEquals(SaveOutcome.NotSent, model.saveJob("Builder"))
        assertEquals(SaveOutcome.Saved, first.await())
        assertEquals("Architect", model.state.value.profile?.job)
        assertFalse(model.state.value.saving)
        model.viewModelScope.cancel()
    }

    @Test
    fun anAnswerOlderThanTheProfileHeldIsIgnored() = runTest(dispatcher) {
        val model = model()
        model.saveJob("Architect")
        val held = model.state.value.profile!!
        // A slower answer that left the server before the last one.
        model.adopt(held.copy(v = held.v - 1, job = "Old job"))
        assertEquals("Architect", model.state.value.profile?.job)
        model.adopt(held.copy(v = held.v + 1, job = "Newer job"))
        assertEquals("Newer job", model.state.value.profile?.job)
        model.viewModelScope.cancel()
    }

    @Test
    fun aSpokenAnswerHoldsItsPositionAndCounts() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        // Written answers at 0 and 1 (the sample's), a spoken one at 2.
        api.stageVoiceAnswer(promptId = 9, position = 2)
        val model = model(api)
        assertEquals(2, model.prompts().size)
        assertEquals(3, model.answered().size)
        // No free position is left: the spoken answer is not written over.
        assertEquals(SaveOutcome.Failed(R.string.settings_save_failed), model.savePrompt(5, "One more"))
        assertTrue(api.me().value.profile!!.prompts.any { it.position == 2 && it.audioMs != null })
        model.viewModelScope.cancel()
    }

    @Test
    fun anUploadStartedInTheEditorFinishesAfterTheEditorCloses() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val photos = ownPhotos(api)
        val store = ViewModelStore()
        val model = ViewModelProvider.create(store, viewModelFactory { initializer { EditProfileModel(api, photos, clock) { config } } })[EditProfileModel::class]
        runCurrent()
        val before = api.me().value.profile!!.photos.size
        // A picture framed and on its way, then back (or a notification opening a thread) closes the editor.
        assertTrue(model.photos.add(ByteArray(2_048) { (it % 251).toByte() }))
        store.clear()
        // The sample's uplink takes a few steps of virtual time (the app scope's work is not "idle" work to wait for).
        advanceTimeBy(UPLOAD_MS)
        runCurrent()
        assertEquals(before + 1, api.me().value.profile!!.photos.size)
        // The next editor shows it from the server.
        val again = model(api, photos)
        assertEquals(before + 1, again.photos.state.value.uploaded.size)
        again.viewModelScope.cancel()
    }

    @Test
    fun framingThatOutlivesTheEditorStillAddsThePhoto() = runTest(dispatcher) {
        val api = SampleApi(clock = clock)
        val photos = ownPhotos(api)
        val model = model(api, photos)
        val before = api.me().value.profile!!.photos.size
        // The screen's own scope asks; the screen goes while the picture is being prepared.
        val screen = launch { model.addPhoto { delay(1_000); ByteArray(2_048) { (it % 251).toByte() } } }
        runCurrent()
        screen.cancel()
        model.viewModelScope.cancel()
        advanceTimeBy(UPLOAD_MS)
        runCurrent()
        assertEquals(before + 1, api.me().value.profile!!.photos.size)
    }

    private companion object {
        /** Long enough for the framing (1 s here) and the sample's uplink. */
        const val UPLOAD_MS = 5_000L
    }
}
