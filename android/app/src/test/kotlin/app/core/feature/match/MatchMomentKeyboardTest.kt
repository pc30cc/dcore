package app.core.feature.match

import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.feature.card.ScreenTestData
import app.core.media.LocalRemoteImages
import app.core.ui.theme.AppTemplate
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The match moment with the keyboard up, drawn edge to edge as its dialog
 * is (the window keeps its full height; the keyboard comes as an inset):
 * the composer and its send sit just above the keyboard, the title and the
 * openers above the composer, «بعداً» under the keyboard; with the keyboard
 * down again everything is where it was. At rest on a short phone the board
 * is drawn small enough that nothing has scrolled: the photos are whole. A
 * long message never grows the composer under the close.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp")
class MatchMomentKeyboardTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private var view: View? = null
    private var openers = listOf("Damavand?", "Tea or coffee?")

    private fun show(template: AppTemplate) {
        compose.runOnUiThread { WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false) }
        compose.setContent {
            view = LocalView.current
            AppTheme(template = template) {
                CompositionLocalProvider(
                    LocalRemoteImages provides false,
                    LocalMatchMessages provides MatchMessages { _, _ -> },
                ) {
                    MatchMoment(ScreenTestData.negar, myPhoto = null, onSendMessage = {}, onDismiss = {}, conversationId = "777", openers = openers)
                }
            }
        }
        compose.waitForIdle()
    }

    private fun px(dp: Int): Float = dp * compose.density.density

    /** The window's insets as a phone reports them: a [navigation] dp navigation bar, and the keyboard [keyboard] px tall (0: down). */
    private fun insets(keyboard: Int, navigation: Int = NAVIGATION_DP) {
        compose.runOnUiThread {
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, px(navigation).roundToInt()))
                .setVisible(WindowInsetsCompat.Type.navigationBars(), true)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, keyboard))
                .setVisible(WindowInsetsCompat.Type.ime(), keyboard > 0)
                .build()
            ViewCompat.dispatchApplyWindowInsets(view!!, insets)
        }
        compose.waitForIdle()
    }

    private fun string(id: Int) = compose.activity.getString(id)
    private fun root(): Rect = compose.onNode(isRoot()).fetchSemanticsNode().boundsInRoot
    private fun field(): Rect = compose.onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot
    private fun send(): Rect = compose.onNodeWithContentDescription(string(R.string.match_send)).fetchSemanticsNode().boundsInRoot
    private fun title(): Rect = compose.onNode(isHeading()).fetchSemanticsNode().boundsInRoot
    private fun opener(): Rect = compose.onNodeWithText(openers.first()).fetchSemanticsNode().boundsInRoot
    private fun later(): Rect = compose.onNodeWithText(string(R.string.match_later)).fetchSemanticsNode().boundsInRoot
    private fun close(): Rect = compose.onNodeWithContentDescription(string(R.string.action_close)).fetchSemanticsNode().boundsInRoot
    private fun portraits(): Rect = compose.onNodeWithTag(MATCH_PORTRAITS_TAG).fetchSemanticsNode().boundsInRoot

    /** How far the page above the composer can scroll; 0 when everything fits. */
    private fun scrollRange(): Float = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
        .fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue()

    /**
     * At rest on a short phone with a 48 dp navigation bar and three openers (two rows of chips): nothing has
     * scrolled, the photos start at their place on the board, the title is under them and the last opener above
     * the composer.
     */
    private fun atRest(template: AppTemplate) {
        openers = THREE_OPENERS
        show(template)
        insets(0, navigation = 48)
        val chips = openers.map { compose.onNodeWithText(it).fetchSemanticsNode().boundsInRoot }
        assertTrue("the openers take two rows: $chips", chips.map { it.top }.distinct().size >= 2)
        assertEquals("the page has scrolled at rest", 0f, scrollRange(), 0.5f)
        val photos = portraits()
        assertTrue("the photos $photos start above the window", photos.top >= -0.5f)
        if (template == Templates.Neon) assertEquals("the split starts at the top", 0f, photos.top, 0.5f)
        if (template == Templates.White) assertTrue("title ${title()} under the cards $photos", title().top >= photos.bottom)
        val lastChip = chips.maxOf { it.bottom }
        assertTrue("the openers ($lastChip) run under the composer ${field()}", lastChip <= field().top)
    }

    /** A message of four lines and more with the keyboard up, on a phone on its side: the composer stays under the close. */
    private fun longMessageOnItsSide(keyboardDp: Int) {
        show(Templates.Neon)
        insets(px(keyboardDp).roundToInt())
        compose.onNode(hasSetTextAction()).performTextInput(
            "Hi! Your mountain photos are great.\nWhich peak was the one with the lake behind you?\nI have been meaning to go.\nAnd the tea?\nOne more line.",
        )
        val close = close()
        val up = field()
        assertTrue("the composer $up runs under the close $close", up.top >= close.bottom - 0.5f)
        val top = root().bottom - px(keyboardDp).roundToInt()
        assertTrue("the send ${send()} is under the keyboard (top $top)", send().bottom <= top + 0.5f)
    }

    /** Shows the moment, raises a keyboard [keyboardDp] tall and checks the layout over it; then lowers it again. */
    private fun keyboardUp(template: AppTemplate, keyboardDp: Int, alsoChecks: () -> Unit = {}) {
        show(template)
        insets(0)
        val downField = field()
        val downTitle = title()
        val downLater = later()
        // Keyboard down: the composer is 18 dp over «بعداً», which is 34 dp above the navigation bar.
        val expected = root().bottom - px(NAVIGATION_DP) - px(OVER_LATER_DP)
        assertTrue("composer foot ${downField.bottom}, expected $expected", abs(downField.bottom - expected) <= 1f)

        val keyboard = px(keyboardDp).roundToInt()
        insets(keyboard)
        val top = root().bottom - keyboard
        val up = field()
        assertTrue("the composer $up is under the keyboard (top $top)", up.bottom <= top + 0.5f)
        assertTrue("the send ${send()} is under the keyboard (top $top)", send().bottom <= top + 0.5f)
        assertTrue("the composer $up is far above the keyboard (top $top)", top - up.bottom <= px(16))
        assertTrue("the composer $up is off the top", up.top >= 0f)
        assertTrue("the title ${title()} runs under the composer $up", title().bottom <= up.top)
        assertTrue("the opener ${opener()} runs under the composer $up", opener().bottom <= up.top)
        assertTrue("the title gives way upwards: ${title()} from $downTitle", title().top < downTitle.top)
        assertTrue("«بعداً» ${later()} stays under the keyboard (top $top)", later().top >= top - 0.5f)
        alsoChecks()

        insets(0)
        assertEquals(downField, field())
        assertEquals(downTitle, title())
        assertEquals(downLater, later())
    }

    @Test
    fun onTheSplitTheComposerSitsAboveTheKeyboard() = keyboardUp(Templates.Neon, keyboardDp = 335)

    @Test
    fun onTheFramedCardsTheComposerSitsAboveTheKeyboard() = keyboardUp(Templates.White, keyboardDp = 335)

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun inPersianTooWithTheSendAtTheStartOfTheLine() = keyboardUp(Templates.Neon, keyboardDp = 335) {
        assertTrue("send ${send()} is at the left of the field ${field()}", send().center.x < field().center.x)
    }

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun onAShortPhoneThePhotosGiveWayAndTheTitleStaysUnderTheCards() = keyboardUp(Templates.White, keyboardDp = 300) {
        val cards = compose.onNodeWithTag(MATCH_PORTRAITS_TAG).fetchSemanticsNode().boundsInRoot
        assertTrue("title ${title()} under the cards $cards", title().top >= cards.bottom)
    }

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun onAShortPhoneTheSplitGivesWayToo() = keyboardUp(Templates.Neon, keyboardDp = 300)

    @Test
    @Config(qualifiers = "w891dp-h411dp")
    fun onAPhoneOnItsSideTheComposerStillSitsAboveTheKeyboard() = keyboardUp(Templates.Neon, keyboardDp = 190)

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun onAShortPhoneAtRestTheSplitIsWhole() = atRest(Templates.Neon)

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun onAShortPhoneAtRestTheCardsAreWhole() = atRest(Templates.White)

    @Test
    @Config(qualifiers = "w360dp-h640dp", fontScale = 1.3f)
    fun onAShortPhoneWithLargeTextAtRestTheSplitIsWhole() = atRest(Templates.Neon)

    @Test
    @Config(qualifiers = "w360dp-h640dp", fontScale = 1.3f)
    fun onAShortPhoneWithLargeTextAtRestTheCardsAreWhole() = atRest(Templates.White)

    @Test
    @Config(qualifiers = "w640dp-h360dp")
    fun onASmallPhoneOnItsSideALongMessageStaysUnderTheClose() = longMessageOnItsSide(keyboardDp = 200)

    @Test
    @Config(qualifiers = "w891dp-h411dp", fontScale = 1.3f)
    fun onAPhoneOnItsSideWithLargeTextALongMessageStaysUnderTheClose() = longMessageOnItsSide(keyboardDp = 190)

    @Test
    fun aLongMessageGrowsTheComposerUpwardsAboveTheKeyboard() {
        show(Templates.Neon)
        val keyboard = px(335).roundToInt()
        insets(keyboard)
        val top = root().bottom - keyboard
        val oneLine = field()
        compose.onNode(hasSetTextAction()).performTextInput("Hi! Your mountain photos are great, which peak was the one with the lake behind you? I have been meaning to go.")
        val grown = field()
        assertTrue("grown $grown, one line $oneLine", grown.height > oneLine.height)
        assertTrue("it grows upwards: $grown from $oneLine", grown.top < oneLine.top && abs(grown.bottom - oneLine.bottom) <= 1f)
        assertTrue("the send ${send()} is under the keyboard (top $top)", send().bottom <= top + 0.5f)
    }

    private companion object {
        const val NAVIGATION_DP = 24

        /** 18 dp to «بعداً», its 48 dp, and 34 dp under it. */
        const val OVER_LATER_DP = 100

        /** What [matchOpeners] gives for the test profile: two answers as questions, then the plain one. */
        val THREE_OPENERS = listOf("A trip north with no plan?", "A long Friday breakfast?", "Tea or coffee?")
    }
}
