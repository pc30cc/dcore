package app.core.feature.match

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.card.ScreenTestData
import app.core.media.LocalRemoteImages
import app.core.model.Catalog
import app.core.model.Id
import app.core.model.ProfilePrompt
import app.core.model.PromptDef
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The match moment's openers, composer and layout, drawn on their own (text measured as on a phone). */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp")
class MatchMomentTest {

    @get:Rule val compose = createComposeRule()

    private val sent = mutableListOf<Pair<Id, String>>()
    private var opened = 0

    private fun show(conversationId: Id?, openers: List<String>, template: app.core.ui.theme.AppTemplate = Templates.White) {
        compose.setContent {
            AppTheme(template = template) {
                CompositionLocalProvider(
                    LocalRemoteImages provides false,
                    LocalMatchMessages provides MatchMessages { id, text -> sent += id to text },
                ) {
                    MatchMoment(ScreenTestData.negar, myPhoto = null, onSendMessage = { opened++ }, onDismiss = {}, conversationId = conversationId, openers = openers)
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun anOpenerFillsTheComposerAndIsSentAsWritten() {
        show("777", listOf("Damavand?", "Tea or coffee?"))
        val opener = compose.onNodeWithText("Damavand?")
        // 44 dp to see, 48 dp to touch.
        opener.assertHeightIsAtLeast(48.dp)
        opener.performClick()
        compose.onNode(hasSetTextAction() and hasText("Damavand?")).assertExists()
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf("777" to "Damavand?"), sent)
        assertEquals(1, opened)
    }

    @Test
    fun aLongMessageGrowsTheComposerInsteadOfHidingItsStart() {
        show("777", emptyList())
        val field = compose.onNode(hasSetTextAction())
        val oneLine = field.getBoundsInRoot().let { it.bottom - it.top }
        field.performTextInput("Hi! Your mountain photos are great, which peak was the one with the lake behind you?")
        val grown = field.getBoundsInRoot().let { it.bottom - it.top }
        assertTrue("one line is the 56 dp pill ($oneLine)", oneLine >= 56.dp)
        assertTrue("several lines make it taller ($grown)", grown > oneLine)
    }

    @Test
    fun withoutAConversationThereIsNothingToTypeIntoOrTap() {
        show(null, listOf("Tea or coffee?"))
        assertTrue(compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Tea or coffee?").assertDoesNotExist()
        compose.onNodeWithText("Later").assertExists()
    }

    @Test
    fun theCloseIsAtTheStartLikeTheProfilesClose() {
        show("777", emptyList(), Templates.Neon)
        val close = compose.onNodeWithContentDescription("Close").getBoundsInRoot()
        val root = compose.onRoot().getBoundsInRoot()
        assertTrue("in English the start is the left", close.right < root.right / 2)
    }

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun onAShortPhoneTheFramedTitleStaysUnderTheCards() {
        show("777", emptyList(), Templates.White)
        val cards = compose.onNodeWithTag(MATCH_PORTRAITS_TAG).getBoundsInRoot()
        val title = compose.onNodeWithText("It’s a match!").getBoundsInRoot()
        assertTrue("title top ${title.top} under the cards' bottom ${cards.bottom}", title.top >= cards.bottom)
    }

    @Test
    fun openersAreShortAnswersAsQuestionsThenOnePlainOpener() {
        val catalog = Catalog(
            prompts = listOf(
                PromptDef(1, "The best trip I took…"),
                PromptDef(2, "A perfect day is…"),
                PromptDef(3, "Hear it in my voice…", category = "voice"),
                PromptDef(4, "Best breakfast…"),
                PromptDef(5, "My unpopular opinion…"),
            ),
        )
        val card = ScreenTestData.negar.copy(
            prompts = listOf(
                ProfilePrompt(3, null, audioMs = 9_000, audioUrl = "https://media.test/a/1.m4a"),
                ProfilePrompt(1, "Damavand, last summer."),
                ProfilePrompt(2, "A very long answer about bookshops, tea, rain and a walk that never seems to end"),
                ProfilePrompt(4, "دماوند، تابستون پارسال"),
                ProfilePrompt(9, "A question the catalogue no longer has"),
            ),
        )
        var openers = emptyList<String>()
        compose.setContent { AppTheme(template = Templates.White) { openers = matchOpeners(card, catalog) } }
        compose.waitForIdle()
        // No template sentence and no quotes: the answer itself, its stop dropped, the question mark of its script;
        // a long answer is left out, not cut; the plain opener fills the third place.
        assertEquals(listOf("Damavand, last summer?", "دماوند، تابستون پارسال؟", "Tea or coffee?"), openers)
        assertTrue(openers.none { '“' in it || '«' in it })
    }

    @Test
    fun threeShortAnswersLeaveNoRoomForThePlainOpener() {
        val catalog = Catalog(prompts = (1..4).map { PromptDef(it, "Prompt $it…") })
        val card = ScreenTestData.negar.copy(
            prompts = listOf(ProfilePrompt(1, "Film photos"), ProfilePrompt(2, "Darband!"), ProfilePrompt(3, "Tea or coffee?"), ProfilePrompt(4, "Books")),
        )
        var openers = emptyList<String>()
        compose.setContent { AppTheme(template = Templates.White) { openers = matchOpeners(card, catalog) } }
        compose.waitForIdle()
        assertEquals(listOf("Film photos?", "Darband?", "Tea or coffee?"), openers)
    }
}
