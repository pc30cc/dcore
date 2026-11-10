package app.core.feature.profile

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.geometry.Offset
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Clock
import app.core.common.Diag
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.OwnProfile
import app.core.model.ProfilePatch
import app.core.net.ApiError
import app.core.net.SampleApi
import app.core.net.SampleData
import app.core.net.ServerApi
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * A sheet of the profile editor whose save is on its way cannot be closed
 * (not from the scrim, not from the grabber), so a failure is said under
 * what was written, which stays; the answer never closes a sheet it did not
 * come from.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class EditSheetsTest {

    @get:Rule val compose = createComposeRule()
    @get:Rule val folder = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var made: EditProfileModel

    @After fun tearDown() {
        if (::made.isInitialized) made.viewModelScope.cancel()
        scope.cancel()
    }

    /** The sample backend, with each profile save held until [answer] completes and failing offline when it does. */
    private fun editor(answer: CompletableDeferred<Unit>): EditProfileModel {
        val sample = SampleApi(clock = Clock.System)
        val api = object : ServerApi by sample {
            override suspend fun updateProfile(patch: ProfilePatch): OwnProfile {
                answer.await()
                throw ApiError.Network(java.io.IOException("offline"))
            }
        }
        val photos = OwnPhotos(api, PhotoUploader(api, sample, Clock.System, Diag.Silent), LocalPhotoCache(folder.newFolder()), scope, Diag.Silent)
        val config = SampleData.config("bazaar", "en", 1)
        return EditProfileModel(api, photos, Clock.System) { config }.also { made = it }
    }

    @Test
    fun aSheetSavingCannotBeClosedAndAFailureKeepsWhatWasWritten() {
        val answer = CompletableDeferred<Unit>()
        val model = editor(answer)
        var sheet by mutableStateOf<EditSheet?>(EditSheet.About)
        compose.setContent {
            AppTheme(template = Templates.of(Templates.WHITE)) {
                val state by model.state.collectAsState()
                state.profile?.let { profile ->
                    EditSheets(sheet, model, profile, SampleData.config("bazaar", "en", 1).catalog, state.saving) { sheet = it }
                }
            }
        }
        compose.waitUntil(5_000) { model.state.value.profile != null }
        compose.waitForIdle()
        val bio = "Weekends in the mountains, weekdays in a kitchen that smells of cardamom."
        compose.onNode(hasSetTextAction()).performTextClearance()
        compose.onNode(hasSetTextAction()).performTextInput(bio)
        compose.onNodeWithText("Save").performClick()
        compose.waitUntil(5_000) { model.state.value.saving }
        compose.waitForIdle()

        // While it saves, the grabber offers no "close" and a tap on the scrim leaves the sheet.
        compose.onNode(hasContentDescription("Close") and SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).assertDoesNotExist()
        compose.onNode(isRoot() and hasAnyDescendant(hasSetTextAction())).performTouchInput { click(Offset(width / 2f, 8f)) }
        compose.waitForIdle()
        assertEquals(EditSheet.About, sheet)

        // The save fails: said under the text, which is still there.
        answer.complete(Unit)
        compose.waitUntil(5_000) { !model.state.value.saving }
        compose.waitForIdle()
        assertEquals(EditSheet.About, sheet)
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        assertTrue(compose.onAllNodes(hasSetTextAction() and hasText(bio)).fetchSemanticsNodes().isNotEmpty())
        // Not saving any more: the sheet closes again.
        compose.onNode(hasContentDescription("Close") and SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).assertExists()
    }
}
