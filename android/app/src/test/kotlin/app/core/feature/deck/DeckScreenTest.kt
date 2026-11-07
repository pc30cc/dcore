package app.core.feature.deck

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.card.LikeTarget
import app.core.feature.card.ScreenTestData
import app.core.media.LocalRemoteImages
import app.core.model.DeckSuggestion
import app.core.model.DiscoveryPreferences
import app.core.model.Entitlements
import app.core.model.Id
import app.core.model.ItemKind
import app.core.model.LikedItem
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.Quota
import app.core.model.Quotas
import app.core.model.SwipeAction
import app.core.model.Wallet
import app.core.sync.DeckBlock
import app.core.sync.DeckState
import app.core.sync.DeckStatus
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.Instant

/** Every state of the deck screen, drawn from a state alone (no server, no network), on a phone-sized screen. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class DeckScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Recorder : DeckActions {
        val calls = mutableListOf<String>()
        val swipes = mutableListOf<Pair<String, SwipeAction>>()
        override fun swiped(card: ProfileCard, action: SwipeAction) { swipes += card.id to action }
        override fun returnShown(id: String) { calls += "returnShown" }
        override fun openDetails(card: ProfileCard) { calls += "details:${card.id}" }
        override fun closeDetails() { calls += "closeDetails" }
        override fun fromDetails(action: SwipeAction) { calls += "fromDetails:$action" }
        override fun openItemLike(target: LikeTarget) { calls += "itemLike:${target.item.kind}:${target.item.ref}" }
        override fun sendItemLike(target: LikeTarget, comment: String) { calls += "send:$comment" }
        override fun rewind() { calls += "rewind" }
        override fun openFilters() { calls += "filters" }
        override fun applyFilters(patch: PreferencesPatch) { calls += "apply" }
        override fun widenDistance() { calls += "widenDistance" }
        override fun widenAge() { calls += "widenAge" }
        override fun boost() { calls += "boost" }
        override fun wakeUp() { calls += "wakeUp" }
        override fun retry() { calls += "retry" }
        override fun dismissSheet() { calls += "dismissSheet" }
        override fun dismissMatch() { calls += "dismissMatch" }
        override fun messageShown(id: Long) { calls += "messageShown" }
        override fun openChat(conversationId: Id?) { calls += "chat:$conversationId" }
        override fun openProfile() { calls += "profile" }
    }

    private val actions = Recorder()

    private fun show(state: DeckUiState) {
        compose.setContent { Screen(state) }
    }

    @Composable
    private fun Screen(state: DeckUiState) {
        AppTheme(dark = false) {
            CompositionLocalProvider(LocalRemoteImages provides false) {
                DeckScreen(state, ScreenTestData.catalog, mapOf("plus" to "Plus", "premium" to "Premium"), 300, actions)
            }
        }
    }

    private fun ready(vararg cards: ProfileCard) = DeckUiState(deck = DeckState(cards = cards.toList(), status = DeckStatus.Ready))

    @Test
    fun loadingIsACardShapedPlaceholderWithTheButtonsOff() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Loading)))
        compose.onNodeWithContentDescription("Finding people for you").assertIsDisplayed()
        compose.onNodeWithContentDescription("Like").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Pass").assertIsNotEnabled()
    }

    @Test
    fun theTopCardShowsNameAgeBadgeCityAndRoundedDistance() {
        show(ready(ScreenTestData.negar, ScreenTestData.elif))
        compose.onNodeWithText("\u2068Negar\u2069, 27", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("\u2068Tehran\u2069 · 4 km away", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Likes you", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Something serious · Architect", useUnmergedTree = true).assertIsDisplayed()
        // TalkBack reads the whole card as one sentence.
        compose.onNodeWithContentDescription("\u2068Negar\u2069, 27. Verified. Likes you. Something serious. Architect. \u2068Tehran\u2069 · 4 km away. Active recently").assertExists()
    }

    @Test
    fun aDistanceUnderTheFloorReadsLessThan() {
        show(ready(ScreenTestData.elif))
        compose.onNodeWithText("\u2068İstanbul\u2069 · Less than 2 km away", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun theButtonsThrowTheTopCard() {
        show(ready(ScreenTestData.negar, ScreenTestData.elif))
        compose.onNodeWithContentDescription("Like").performClick()
        compose.waitForIdle()
        assertEquals(listOf("bnegar2kq7xm4" to SwipeAction.Like), actions.swipes)
    }

    @Test
    fun passAndSuperLikeButtonsToo() {
        show(ready(ScreenTestData.negar))
        compose.onNodeWithContentDescription("Pass").performClick()
        compose.waitForIdle()
        assertEquals(SwipeAction.Pass, actions.swipes.single().second)
    }

    @Test
    fun rewindAsksTheModel() {
        show(ready(ScreenTestData.negar))
        compose.onNodeWithContentDescription("Rewind").performClick()
        assertTrue("rewind" in actions.calls)
    }

    @Test
    fun talkBackCanLikePassAndOpenWithoutSwiping() {
        show(ready(ScreenTestData.negar, ScreenTestData.elif))
        val card = compose.onNodeWithContentDescription("\u2068Negar\u2069, 27", substring = true)
        card.performCustomAccessibilityActionWithLabel("Open profile")
        assertTrue("details:bnegar2kq7xm4" in actions.calls)
        card.performCustomAccessibilityActionWithLabel("Pass")
        compose.waitForIdle()
        assertEquals(listOf("bnegar2kq7xm4" to SwipeAction.Pass), actions.swipes)
    }

    @Test
    fun theSuperLikeButtonSaysHowManyAreLeft() {
        val entitlements = Entitlements(quotas = Quotas(superlikes = Quota(limit = 1, used = 0)), wallet = Wallet(superlike = 2))
        show(ready(ScreenTestData.negar).copy(entitlements = entitlements))
        compose.onNodeWithContentDescription("Super like. 3 super likes left").assertExists()
    }

    @Test
    fun theEndOfTheDeckOffersConcreteWidening() {
        val prefs = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 50)
        show(
            DeckUiState(
                deck = DeckState(status = DeckStatus.Exhausted, suggestions = listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge, DeckSuggestion.Boost)),
                preferences = prefs,
            ),
        )
        compose.onNodeWithText("You've seen everyone for now").assertIsDisplayed()
        compose.onNodeWithText("Search up to 100 km").performScrollTo().performClick()
        compose.onNodeWithText("Widen ages to 20–37").performScrollTo().performClick()
        compose.onNodeWithText("Boost your profile").performScrollTo().performClick()
        compose.onNodeWithText("Change filters").performScrollTo().performClick()
        compose.onNodeWithText("Check again").performScrollTo().performClick()
        assertEquals(listOf("widenDistance", "widenAge", "boost", "filters", "retry"), actions.calls)
    }

    @Test
    fun widenedAsFarAsItGoesTheNextStepIsTheWholeCountry() {
        show(
            DeckUiState(
                deck = DeckState(status = DeckStatus.Exhausted, suggestions = listOf(DeckSuggestion.WidenDistance)),
                preferences = DiscoveryPreferences(maxDistanceKm = 300),
            ),
        )
        compose.onNodeWithText("Search the whole country").assertIsDisplayed()
    }

    @Test
    fun withoutTheFiltersYetTheButtonsStillSayWhatTheyDo() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Exhausted)))
        compose.onNodeWithText("Search further away").assertIsDisplayed()
        compose.onNodeWithText("Widen the age range").assertIsDisplayed()
    }

    @Test
    fun offlineSaysSoAndRetries() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Offline)))
        compose.onNodeWithText("You're offline").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), actions.calls)
    }

    @Test
    fun aServerFailureSaysSoAndRetries() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Failed)))
        compose.onNodeWithText("This didn't load").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), actions.calls)
    }

    @Test
    fun snoozedOffersToWakeUp() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Blocked(DeckBlock.Snoozed))))
        compose.onNodeWithText("You're snoozed").assertIsDisplayed()
        compose.onNodeWithText("Turn snooze off").performClick()
        assertEquals(listOf("wakeUp"), actions.calls)
    }

    @Test
    fun anUnfinishedProfileLeadsToTheProfile() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Blocked(DeckBlock.OnboardingIncomplete))))
        compose.onNodeWithText("Go to my profile").performClick()
        assertEquals(listOf("profile"), actions.calls)
    }

    @Test
    fun noLocationExplainsAndRetries() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Blocked(DeckBlock.LocationRequired))))
        compose.onNodeWithText("needs your location", substring = true).assertIsDisplayed()
    }

    @Test
    fun aNoticeIsShownOnceAndMarkedShown() {
        show(ready(ScreenTestData.negar).copy(message = DeckMessage(DeckNotice.LikeOffline, 1)))
        compose.onNodeWithText("Your like wasn't sent: you're offline.").assertIsDisplayed()
    }

    @Test
    fun theMatchMomentLeadsToTheConversation() {
        show(ready(ScreenTestData.elif).copy(match = MatchUi(ScreenTestData.negar, "777", myPhoto = null)))
        compose.onNodeWithText("It's a match!").assertIsDisplayed()
        compose.onNodeWithText("You and Negar like each other.").assertIsDisplayed()
        compose.onNodeWithText("Send a message").performClick()
        assertEquals(listOf("dismissMatch", "chat:777"), actions.calls)
    }

    @Test
    fun keepSwipingClosesTheMatchMoment() {
        show(ready(ScreenTestData.elif).copy(match = MatchUi(ScreenTestData.negar, "777", myPhoto = null)))
        compose.onNodeWithText("Keep swiping").performClick()
        assertEquals(listOf("dismissMatch"), actions.calls)
    }

    @Test
    fun theOpenProfileIsOneContinuousPageWithItsOwnLikes() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar))
        compose.onAllNodesWithContentDescription("Like this photo")[0].performClick()
        val page = compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog()))
        page.performScrollToNode(hasText("Mountains and bitter coffee."))
        page.performScrollToNode(hasText("A trip north with no plan"))
        compose.onNodeWithText("The best trip I took…").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Like this answer")[0].performClick()
        // The fields come after the second photo, then the second answer.
        page.performScrollToNode(hasText("168 cm"))
        page.performScrollToNode(hasText("A long Friday breakfast"))
        assertEquals(listOf("itemLike:Photo:9001", "itemLike:Prompt:1"), actions.calls)
    }

    @Test
    fun theOpenProfilesButtonsActOnThatPerson() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar))
        compose.onNode(hasContentDescription("Super like") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Close profile").performClick()
        assertEquals(listOf("fromDetails:Superlike", "closeDetails"), actions.calls)
    }

    @Test
    fun theItemLikeSheetShowsWhatIsLikedAndARefusedComment() {
        val target = LikeTarget(ScreenTestData.negar, LikedItem(ItemKind.Photo, "9002"), photoIndex = 1)
        show(
            ready(ScreenTestData.negar).copy(
                sheet = DeckSheet.LikeItem(target),
                itemLike = ItemLikeState(error = ItemLikeError.Refused),
            ),
        )
        compose.onNodeWithText("Like Negar's photo").assertIsDisplayed()
        compose.onNodeWithText("This comment can't be sent. Please keep it kind and respectful.").assertIsDisplayed()
        compose.onNodeWithText("Send like").performClick()
        assertEquals(listOf("send:"), actions.calls)
    }

    @Test
    fun outOfLikesSaysWhenTheyComeBack() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.OutOfQuota(SwipeAction.Like, Instant.parse("2026-11-07T00:00:00Z"))))
        compose.onNodeWithText("You're out of likes for now").assertIsDisplayed()
        compose.onNodeWithText("More arrive at", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Included with Plus / Premium.").assertIsDisplayed()
    }

    @Test
    fun rewindWithoutThePlanSaysWhichPlansHaveIt() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.RewindUpsell))
        compose.onNodeWithText("Changed your mind?").assertIsDisplayed()
        compose.onNodeWithText("Plans can't be bought in this version of the app yet.").assertIsDisplayed()
    }

    @Test
    fun theFiltersSheetShowsTheCurrentValues() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.Filters, preferences = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 50)))
        compose.onNodeWithText("50 km").assertIsDisplayed()
        compose.onNodeWithText("23–34").assertIsDisplayed()
        compose.onNodeWithText("Show people").performClick()
        assertEquals(listOf("apply"), actions.calls)
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianUsesItsOwnWordsAndDigits() {
        show(ready(ScreenTestData.negar))
        compose.onNodeWithText("\u2068Negar\u2069، ۲۷", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("\u2068Tehran\u2069 · ۴ کیلومتر فاصله", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("لایک").assertExists()
    }

    @Test
    @Config(qualifiers = "+tr")
    fun turkishToo() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Offline)))
        compose.onNodeWithText("Çevrimdışısın").assertIsDisplayed()
    }

    @Test
    fun darkThemeDrawsTheSameScreen() {
        compose.setContent {
            AppTheme(dark = true) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    DeckScreen(ready(ScreenTestData.negar), ScreenTestData.catalog, emptyMap(), 300, actions)
                }
            }
        }
        compose.onNodeWithText("\u2068Negar\u2069, 27", useUnmergedTree = true).assertIsDisplayed()
    }
}
