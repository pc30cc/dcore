package app.core.feature.deck

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.card.LikeTarget
import app.core.feature.card.ScreenTestData
import app.core.feature.match.LocalMatchMessages
import app.core.feature.match.MatchMessages
import app.core.media.LocalRemoteImages
import app.core.model.Catalog
import app.core.model.DeckSuggestion
import app.core.model.FieldDef
import app.core.model.FieldOption
import app.core.model.Features
import app.core.model.DiscoveryPreferences
import app.core.model.Entitlements
import app.core.model.Id
import app.core.model.Intention
import app.core.model.ItemKind
import app.core.model.LikedItem
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.Quota
import app.core.model.Quotas
import app.core.model.ReportReason
import app.core.model.SwipeAction
import app.core.model.Wallet
import app.core.sync.DeckBlock
import app.core.sync.DeckState
import app.core.sync.DeckStatus
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

/**
 * Every state of the deck screen, drawn from a state alone (no server, no
 * network), on a phone-sized screen, in the white template (card) unless a
 * test asks for neon (bleed).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class DeckScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Recorder : DeckActions {
        val calls = mutableListOf<String>()
        val swipes = mutableListOf<Pair<String, SwipeAction>>()
        val applied = mutableListOf<PreferencesPatch>()
        override fun swiped(card: ProfileCard, action: SwipeAction) { swipes += card.id to action }
        override fun returnShown(id: String) { calls += "returnShown" }
        override fun openDetails(card: ProfileCard) { calls += "details:${card.id}" }
        override fun closeDetails() { calls += "closeDetails" }
        override fun fromDetails(action: SwipeAction) { calls += "fromDetails:$action" }
        override fun openItemLike(target: LikeTarget) { calls += "itemLike:${target.item.kind}:${target.item.ref}" }
        override fun sendItemLike(target: LikeTarget, comment: String) { calls += "send:$comment" }
        override fun sendItemSuperlike(target: LikeTarget, comment: String) { calls += "super:${target.item.ref}:$comment" }
        override fun rewind() { calls += "rewind" }
        override fun openFilters() { calls += "filters" }
        override fun applyFilters(patch: PreferencesPatch) {
            calls += "apply"
            applied += patch
        }
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
        override fun report(card: ProfileCard, reason: ReportReason, details: String?, block: Boolean) { calls += "report:${card.id}:$block" }
        override fun block(card: ProfileCard) { calls += "block:${card.id}" }
    }

    private val actions = Recorder()
    private val sent = mutableListOf<Pair<Id, String>>()

    // One composition per test (the rule allows one setContent): a test that draws both templates swaps these.
    private var shownState by mutableStateOf<DeckUiState?>(null)
    private var shownDark by mutableStateOf(false)
    private var shownCatalog by mutableStateOf(ScreenTestData.catalog)
    private var composed = false

    private fun show(state: DeckUiState, dark: Boolean = false) {
        // Off the screen first, so nothing (a typed message, a scroll) carries over from the last state.
        shownState = null
        compose.waitForIdle()
        shownDark = dark
        shownState = state
        if (!composed) {
            composed = true
            compose.setContent { shownState?.let { Screen(it, shownDark) } }
        }
        compose.waitForIdle()
    }

    @Composable
    private fun Screen(state: DeckUiState, dark: Boolean) {
        AppTheme(template = Templates.of(if (dark) Templates.NEON else Templates.WHITE)) {
            CompositionLocalProvider(
                LocalRemoteImages provides false,
                LocalMatchMessages provides MatchMessages { id, text -> sent += id to text },
            ) {
                DeckScreen(state, shownCatalog, 300, actions)
            }
        }
    }

    private fun ready(vararg cards: ProfileCard) = DeckUiState(deck = DeckState(cards = cards.toList(), status = DeckStatus.Ready))

    @Test
    fun loadingIsACardShapedPlaceholderWithTheButtonsOff() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Loading)))
        compose.onNodeWithContentDescription("Loading").assertIsDisplayed()
        compose.onNodeWithContentDescription("Like").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Pass").assertIsNotEnabled()
    }

    @Test
    fun theTopCardShowsNameAgeBadgeAndOneLineInBothTemplates() {
        for (dark in listOf(false, true)) {
            show(ready(ScreenTestData.negar, ScreenTestData.elif), dark)
            compose.onNodeWithText("\u2068Negar\u2069, ", useUnmergedTree = true).assertIsDisplayed()
            compose.onNodeWithText("27", useUnmergedTree = true).assertIsDisplayed()
            compose.onNodeWithText("⁨Tehran⁩, 4 km", useUnmergedTree = true).assertIsDisplayed()
            // The card is photo, name, age, badge, online and one line: no pills, intention or job.
            compose.onNodeWithText("Likes you", useUnmergedTree = true).assertDoesNotExist()
            compose.onNodeWithText("Architect", substring = true, useUnmergedTree = true).assertDoesNotExist()
            compose.onNodeWithText("Something serious", substring = true, useUnmergedTree = true).assertDoesNotExist()
            // TalkBack reads the whole card as one sentence, what it shows and that they like you.
            compose.onNodeWithContentDescription("⁨Negar⁩, 27. Verified. Online. Likes you. ⁨Tehran⁩, 4 km").assertExists()
        }
    }

    @Test
    fun aDistanceUnderTheFloorReadsUnder() {
        show(ready(ScreenTestData.elif))
        compose.onNodeWithText("⁨İstanbul⁩, Under 2 km", useUnmergedTree = true).assertIsDisplayed()
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
        show(ready(ScreenTestData.negar), dark = true)
        compose.onNodeWithContentDescription("Pass").performClick()
        compose.waitForIdle()
        assertEquals(SwipeAction.Pass, actions.swipes.single().second)
    }

    @Test
    fun rewindAndBoostAreInTheRow() {
        show(ready(ScreenTestData.negar))
        compose.onNodeWithContentDescription("Rewind").performClick()
        compose.onNodeWithContentDescription("Boost").performClick()
        assertEquals(listOf("rewind", "boost"), actions.calls)
    }

    @Test
    fun aRunningBoostSaysItsMinutes() {
        val endsAt = Instant.now().plusSeconds(10 * 60)
        show(ready(ScreenTestData.negar).copy(entitlements = Entitlements(boostEndsAt = endsAt)))
        compose.onNodeWithContentDescription("Boosted for", substring = true).assertExists()
    }

    @Test
    fun aTapOnTheNameLineUnderACardPhotoOpensTheProfile() {
        // White draws the card mode: the name and the place under the photo are one button.
        show(ready(ScreenTestData.negar, ScreenTestData.elif), dark = false)
        compose.onNode(hasContentDescription("Open profile") and hasClickAction()).performClick()
        assertTrue("details:bnegar2kq7xm4" in actions.calls)
    }

    @Test
    fun theNameLineOnABleedPhotoOpensTheProfile() {
        // Neon draws the name on the photo: the card's own node carries the click, named for TalkBack.
        show(ready(ScreenTestData.negar, ScreenTestData.elif), dark = true)
        val card = compose.onNodeWithContentDescription("⁨Negar⁩, 27", substring = true)
        card.assert(SemanticsMatcher("open labelled") { it.config.getOrElseNullable(SemanticsActions.OnClick) { null }?.label == "Open profile" })
        card.performSemanticsAction(SemanticsActions.OnClick)
        assertTrue("details:bnegar2kq7xm4" in actions.calls)
    }

    @Test
    fun talkBackCanLikePassAndOpenWithoutSwiping() {
        show(ready(ScreenTestData.negar, ScreenTestData.elif))
        val card = compose.onNodeWithContentDescription("⁨Negar⁩, 27", substring = true)
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
    fun theEndOfTheDeckOffersOneFixTheDistanceFirst() {
        val prefs = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 50)
        show(
            DeckUiState(
                deck = DeckState(status = DeckStatus.Exhausted, suggestions = listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge, DeckSuggestion.Boost)),
                preferences = prefs,
            ),
        )
        compose.onNodeWithText("You’ve seen everyone for now").assertIsDisplayed()
        compose.onNodeWithText("Search up to 100 km").performClick()
        // One fix at a time: the other widening waits its turn, the filters are the corner button.
        compose.onNodeWithText("Widen ages to 20–37").assertDoesNotExist()
        compose.onNodeWithContentDescription("Filters").performClick()
        // The deck can be asked again, and the boost the server suggests is there without widening anything.
        compose.onNodeWithText("Check again").performClick()
        compose.onNodeWithText("Boost your profile").performClick()
        assertEquals(listOf("widenDistance", "filters", "retry", "boost"), actions.calls)
    }

    @Test
    fun aRunningBoostSaysItsMinutesAtTheEndOfTheDeck() {
        show(
            DeckUiState(
                deck = DeckState(status = DeckStatus.Exhausted, suggestions = listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge, DeckSuggestion.Boost)),
                preferences = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 50),
                entitlements = Entitlements(boostEndsAt = Instant.now().plusSeconds(12 * 60 + 30)),
            ),
        )
        compose.onNodeWithText("Boosted for 13 more minutes").assertIsDisplayed()
        compose.onNodeWithText("Boost your profile").assertDoesNotExist()
    }

    @Test
    fun withoutABoostSuggestedTheEndOfTheDeckStillChecksAgain() {
        show(
            DeckUiState(
                deck = DeckState(status = DeckStatus.Exhausted, suggestions = listOf(DeckSuggestion.WidenAge)),
                preferences = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 50),
            ),
        )
        compose.onNodeWithText("Widen ages to 20–37").assertIsDisplayed()
        compose.onNodeWithText("Boost your profile").assertDoesNotExist()
        compose.onNodeWithText("Check again").performClick()
        assertEquals(listOf("retry"), actions.calls)
    }

    @Test
    fun theFixMovesOnToTheAgesThenABoostThenCheckingAgain() {
        val suggestions = listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge, DeckSuggestion.Boost)
        val country = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 300, wholeCountry = true)
        fun at(prefs: DiscoveryPreferences, list: List<DeckSuggestion> = suggestions) =
            outOfCardsFix(DeckUiState(deck = DeckState(status = DeckStatus.Exhausted, suggestions = list), preferences = prefs))
        assertEquals(OutOfCardsFix.Age, at(country))
        assertEquals(OutOfCardsFix.Boost, at(country.copy(ageMin = 18, ageMax = 99)))
        assertEquals(OutOfCardsFix.CheckAgain, at(country.copy(ageMin = 18, ageMax = 99), suggestions.dropLast(1)))

        show(DeckUiState(deck = DeckState(status = DeckStatus.Exhausted, suggestions = suggestions), preferences = country))
        compose.onNodeWithText("Widen ages to 20–37").performClick()
        assertEquals(listOf("widenAge"), actions.calls)
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
    fun withoutTheFiltersYetTheButtonStillSaysWhatItDoes() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Exhausted)))
        compose.onNodeWithText("Search further away").assertIsDisplayed()
    }

    @Test
    fun offlineSaysSoAndRetries() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Offline)), dark = true)
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), actions.calls)
    }

    @Test
    fun aServerFailureSaysSoAndRetries() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Failed)))
        compose.onNodeWithText("Something went wrong.").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), actions.calls)
    }

    @Test
    fun snoozedOffersToWakeUp() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Blocked(DeckBlock.Snoozed))))
        compose.onNodeWithText("Snooze is on").assertIsDisplayed()
        compose.onNodeWithText("Turn it off").performClick()
        assertEquals(listOf("wakeUp"), actions.calls)
    }

    @Test
    fun anUnfinishedProfileLeadsToTheProfile() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Blocked(DeckBlock.OnboardingIncomplete))))
        compose.onNodeWithText("Go to my profile").performClick()
        assertEquals(listOf("profile"), actions.calls)
    }

    @Test
    fun noLocationSaysWhatToDoAndRetries() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Blocked(DeckBlock.LocationRequired))))
        compose.onNodeWithText("Set your city first").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), actions.calls)
    }

    @Test
    fun aNoticeIsShownOnceAndMarkedShown() {
        show(ready(ScreenTestData.negar).copy(message = DeckMessage(DeckNotice.LikeOffline, 1)))
        compose.onNodeWithText("Like not sent. You’re offline.").assertIsDisplayed()
    }

    @Test
    fun aBlockSaysTheyCannotFindYouAnymore() {
        show(ready(ScreenTestData.elif).copy(message = DeckMessage(DeckNotice.Blocked, 1, name = "Negar")))
        compose.onNodeWithText("\u2068Negar\u2069 can’t find you anymore.").assertIsDisplayed()
    }

    @Test
    fun theMatchMomentSendsTheFirstMessageAndLeadsToTheConversation() {
        for (dark in listOf(false, true)) {
            actions.calls.clear()
            sent.clear()
            show(ready(ScreenTestData.elif).copy(match = MatchUi(ScreenTestData.negar, "777", myPhoto = null)), dark)
            compose.onNodeWithText("It’s a match!").assertIsDisplayed()
            // Nothing to send yet: the send does nothing.
            compose.onNodeWithContentDescription("Send").performClick()
            assertEquals(emptyList<String>(), actions.calls)
            compose.onNode(hasSetTextAction()).performTextInput("Hi Negar")
            compose.onNodeWithContentDescription("Send").performClick()
            assertEquals(listOf("777" to "Hi Negar"), sent)
            assertEquals(listOf("dismissMatch", "chat:777"), actions.calls)
        }
    }

    @Test
    fun laterClosesTheMatchMoment() {
        show(ready(ScreenTestData.elif).copy(match = MatchUi(ScreenTestData.negar, "777", myPhoto = null)))
        compose.onNodeWithText("Later").performClick()
        assertEquals(listOf("dismissMatch"), actions.calls)
        assertTrue(sent.isEmpty())
    }

    @Test
    fun theOpenProfileIsOneContinuousPageWithItsOwnLikes() {
        for (dark in listOf(false, true)) {
            actions.calls.clear()
            show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar), dark)
            // The first screen: the photos; the one shown can be liked on its own.
            compose.onNode(hasStateDescription("Photo 1 of 4") and hasAnyAncestor(isDialog())).performCustomAccessibilityActionWithLabel("Like this photo")
            val page = compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog()))
            page.performScrollToNode(hasText("Mountains and bitter coffee."))
            page.performScrollToNode(hasText("Looking for"))
            page.performScrollToNode(hasText("168 cm"))
            page.performScrollToNode(hasText("A trip north with no plan"))
            compose.onNodeWithText("The best trip I took…").assertIsDisplayed()
            compose.onAllNodesWithContentDescription("Like this answer")[0].performClick()
            // The second photo follows the first answer; tapping it likes it.
            page.performScrollToNode(hasContentDescription("Photo 2 of 4"))
            compose.onNodeWithContentDescription("Photo 2 of 4").performClick()
            page.performScrollToNode(hasText("A long Friday breakfast"))
            assertEquals(listOf("itemLike:Photo:9001", "itemLike:Prompt:1", "itemLike:Photo:9002"), actions.calls)
        }
    }

    @Test
    fun theOpenProfilesButtonsActOnThatPerson() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar))
        compose.onNode(hasContentDescription("Like") and hasAnyAncestor(isDialog())).performClick()
        compose.onNode(hasContentDescription("Pass") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Close").performClick()
        assertEquals(listOf("fromDetails:Like", "fromDetails:Pass", "closeDetails"), actions.calls)
    }

    @Test
    fun theProfileCanBeBlockedAfterAConfirmation() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar))
        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Block").performClick()
        compose.onNodeWithText("Block \u2068Negar\u2069?").assertIsDisplayed()
        // The confirming button of that question (the newest window).
        compose.onAllNodesWithText("Block").onLast().performClick()
        assertEquals(listOf("block:bnegar2kq7xm4"), actions.calls)
    }

    @Test
    fun theProfileEndsWithReportAndBlock() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar))
        val page = compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog()))
        page.performScrollToNode(hasText("Report \u2068Negar\u2069"))
        compose.onNodeWithText("Report \u2068Negar\u2069").assertIsDisplayed()
    }

    @Test
    fun aVoiceAnswerCanBeLikedLikeAWrittenOne() {
        val voiced = ScreenTestData.negar.copy(
            prompts = listOf(
                app.core.model.ProfilePrompt(1, "A trip north with no plan"),
                app.core.model.ProfilePrompt(3, audioMs = 12_000, audioUrl = "https://media.test/a/3.m4a"),
            ),
        )
        show(ready(voiced).copy(details = voiced))
        val page = compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog()))
        page.performScrollToNode(hasText("Hear it in my voice…"))
        compose.onNodeWithText("Hear it in my voice…").assertIsDisplayed()
        // The voice card's own heart, the first «like this answer» on the page (voice answers come first).
        compose.onAllNodesWithContentDescription("Like this answer")[0].performClick()
        assertEquals(listOf("itemLike:Prompt:3"), actions.calls)
    }

    @Test
    fun aReportFromTheProfileDoesNotSayMessagesGoWithIt() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar))
        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Report ⁨Negar⁩").performClick()
        // A profile report carries no conversation: the sheet says what the team looks at instead.
        compose.onNodeWithText("The team checks their profile with your report.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Their recent messages go with the report, so the team can check.").assertDoesNotExist()
        compose.onNodeWithText("Fake profile").performScrollTo().performClick()
        compose.onNodeWithText("Send report").performScrollTo().performClick()
        assertEquals(listOf("report:bnegar2kq7xm4:true"), actions.calls)
    }

    @Test
    fun theItemLikeSheetShowsWhatIsLikedAndARefusedNote() {
        val target = LikeTarget(ScreenTestData.negar, LikedItem(ItemKind.Photo, "9002"), photoIndex = 1)
        show(
            ready(ScreenTestData.negar).copy(
                sheet = DeckSheet.LikeItem(target),
                itemLike = ItemLikeState(error = ItemLikeError.Refused),
            ),
        )
        compose.onNodeWithText("Like \u2068Negar\u2069’s photo").assertIsDisplayed()
        compose.onNodeWithText("Note (optional)").assertIsDisplayed()
        compose.onNodeWithText("This note can’t be sent. Keep it kind.").assertIsDisplayed()
        compose.onNodeWithText("Send like").performClick()
        assertEquals(listOf("send:"), actions.calls)
    }

    @Test
    fun theItemLikeSheetSendsTheSameAsASuperLikeWhenSomeAreLeft() {
        val target = LikeTarget(ScreenTestData.negar, LikedItem(ItemKind.Photo, "9002"), photoIndex = 1)
        val entitlements = Entitlements(quotas = Quotas(superlikes = Quota(limit = 1, used = 0)), wallet = Wallet(superlike = 2))
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.LikeItem(target), entitlements = entitlements))
        compose.onNode(hasSetTextAction()).performTextInput("Nice light")
        compose.onNodeWithText("Send a super like, you have 3").performScrollTo().performClick()
        assertEquals(listOf("super:9002:Nice light"), actions.calls)
    }

    @Test
    fun withNoSuperLikesLeftTheSheetOffersOnlyTheLike() {
        val target = LikeTarget(ScreenTestData.negar, LikedItem(ItemKind.Photo, "9002"), photoIndex = 1)
        val entitlements = Entitlements(quotas = Quotas(superlikes = Quota(limit = 1, used = 1)))
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.LikeItem(target), entitlements = entitlements))
        compose.onNodeWithText("Send a super like", substring = true).assertDoesNotExist()
    }

    @Test
    fun outOfLikesSaysWhenTheyComeBack() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.OutOfQuota(SwipeAction.Like, Instant.parse("2026-11-07T00:00:00Z"))))
        compose.onNodeWithText("You’re out of likes for now").assertIsDisplayed()
        compose.onNodeWithText("More at", substring = true).assertIsDisplayed()
        // No plan names: the config names plans not on sale too.
        compose.onNodeWithText("Included with a paid plan.").assertIsDisplayed()
    }

    @Test
    fun withThePlanNotKnownYetTheSheetOffersNoSuperLike() {
        val target = LikeTarget(ScreenTestData.negar, LikedItem(ItemKind.Photo, "9002"), photoIndex = 1)
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.LikeItem(target), entitlements = null))
        compose.onNodeWithText("Send like").assertIsDisplayed()
        compose.onNodeWithText("Send a super like", substring = true).assertDoesNotExist()
        // An unlimited plan offers it without a count.
        val unlimited = Entitlements(quotas = Quotas(superlikes = Quota(limit = -1)))
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.LikeItem(target), entitlements = unlimited))
        compose.onNodeWithText("Send a super like").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun theHeaderMarkIsNamedForTalkBack() {
        show(ready(ScreenTestData.negar))
        compose.onNodeWithContentDescription("Logo").assertExists()
    }

    @Test
    fun theMatchMomentOffersOpenersBuiltFromAnswers() {
        show(ready(ScreenTestData.elif).copy(match = MatchUi(ScreenTestData.negar, "777", myPhoto = null)))
        val opener = "A trip north with no plan?"
        compose.onNodeWithText(opener).assertIsDisplayed()
        compose.onNodeWithText("A long Friday breakfast?").assertIsDisplayed()
        compose.onNodeWithText(opener).performClick()
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf("777" to opener), sent)
        assertEquals(listOf("dismissMatch", "chat:777"), actions.calls)
    }

    @Test
    fun aFailedBlockIsToldOverTheOpenProfile() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar, message = DeckMessage(DeckNotice.SafetyFailed, 7)))
        compose.onNode(hasText("Something went wrong. Try again.") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.waitUntil(10_000) { "messageShown" in actions.calls }
    }

    @Test
    fun theOpenProfileSaysWhoItIsOnItsFirstScreen() {
        show(ready(ScreenTestData.negar).copy(details = ScreenTestData.negar))
        compose.onNode(hasContentDescription("⁨Negar⁩, 27. Verified. Online. Likes you. ⁨Tehran⁩, 4 km") and hasAnyAncestor(isDialog()) and isHeading())
            .assertExists()
        // The pager says what it is once, and where it stands once.
        compose.onNode(hasContentDescription("⁨Negar⁩’s photos") and hasStateDescription("Photo 1 of 4")).assertExists()
    }

    @Test
    @Config(fontScale = 1.5f)
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun withLargeTextTheCardsLineIsWholeAboveTheActions() = lineIsWhole("⁨Tehran⁩, 4 km")

    @Test
    @Config(qualifiers = "+fa", fontScale = 1.3f)
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun withLargePersianTextTheCardsLineIsWholeToo() = lineIsWhole("⁨Tehran⁩، ۴ کیلومتر")

    /** Card mode (white): the meta line under the photo is laid out whole, above the action row. */
    private fun lineIsWhole(text: String) {
        show(ready(ScreenTestData.negar, ScreenTestData.elif))
        val line = compose.onNodeWithText(text, useUnmergedTree = true)
        line.assertIsDisplayed()
        val meta = line.getBoundsInRoot()
        val like = compose.onAllNodesWithContentDescription(if (text.contains('،')) "لایک" else "Like")[0].getBoundsInRoot()
        assertTrue("the line ends above the action row (${meta.bottom} vs ${like.top})", meta.bottom <= like.top)
        assertTrue("the line is a full line tall (${meta.bottom - meta.top})", meta.bottom - meta.top >= 24.dp)
    }

    @Test
    fun theFiltersOfferHeightAsARangeAfterTheChoices() {
        shownCatalog = ScreenTestData.catalog.copy(
            fields = ScreenTestData.catalog.fields.map { if (it.key == "height" || it.key == "smoking") it.copy(filterable = true) else it },
        )
        val prefs = DiscoveryPreferences(filters = mapOf("height" to listOf(160, 180)))
        val entitled = Entitlements(features = Features(advancedFilters = true))
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.Filters, preferences = prefs, entitlements = entitled))
        compose.onNode(hasText("Height") and hasText("160–180 cm")).performScrollTo().assertIsDisplayed()
        val smoking = compose.onNodeWithText("Smoking").getBoundsInRoot()
        val height = compose.onNodeWithText("Height").getBoundsInRoot()
        assertTrue("choices first, then the range", smoking.top < height.top)
        // Reset clears it, and «Show me» sends the cleared filters.
        compose.onNodeWithText("Reset").performClick()
        compose.onNode(hasText("Height") and hasText("Any")).assertExists()
        compose.onNodeWithText("Show me").performScrollTo().performClick()
        assertEquals(emptyMap<String, List<Int>>(), actions.applied.single().filters)
    }

    @Test
    fun aRangeFieldWithoutBoundsIsNoFilter() {
        val catalog = Catalog(
            fields = listOf(
                FieldDef(1, "height", "Height", "number", min = 120, max = 230, unit = "cm", filterable = true),
                FieldDef(2, "weight", "Weight", "number", filterable = true),
                FieldDef(3, "smoking", "Smoking", "single", options = listOf(FieldOption(21, "No")), filterable = true),
                FieldDef(4, "pets", "Pets", "single", options = listOf(FieldOption(41, "Cat"))),
            ),
        )
        assertEquals(listOf("smoking", "height"), advancedFilterFields(catalog).map { it.key })
    }

    @Test
    @Config(qualifiers = "+tr")
    fun turkishNamesTheCountryInTheGenitive() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.Filters, preferences = DiscoveryPreferences(), country = "IR"))
        compose.onNodeWithText("İran’ın her yeri").assertIsDisplayed()
        assertEquals(
            listOf("İran’ın", "Türkiye’nin", "Almanya’nın", "Irak’ın", "Mısır’ın", "Ürdün’ün", "Kosova’nın", "Rusya’nın", "Peru’nun"),
            listOf("İran", "Türkiye", "Almanya", "Irak", "Mısır", "Ürdün", "Kosova", "Rusya", "Peru").map(::turkishGenitive),
        )
    }

    @Test
    fun theFiltersSheetShowsTheCurrentValues() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.Filters, preferences = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 50)))
        compose.onNodeWithText("Up to 50 km").assertIsDisplayed()
        compose.onNodeWithText("23 to 34").assertIsDisplayed()
        compose.onNodeWithText("Anywhere in the country").assertIsDisplayed()
        compose.onNodeWithText("Show me").performScrollTo().performClick()
        assertEquals(listOf("apply"), actions.calls)
        assertEquals(PreferencesPatch(), actions.applied.single())
    }

    @Test
    fun theFiltersSlidersAreNamedForTalkBack() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.Filters, preferences = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 50)))
        // The distance slider says what it is and its value, not a bare percentage.
        compose.onNode(
            hasContentDescription("Distance") and hasStateDescription("Up to 50 km") and
                SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress),
            useUnmergedTree = false,
        ).assertExists()
        // Each end of the age range is named by its end.
        compose.onNode(hasContentDescription("Age, from 23", substring = true) and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress)).assertExists()
        compose.onNode(hasContentDescription("Age, up to 34", substring = true) and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress)).assertExists()
    }

    @Test
    fun resetPutsTheDefaultsBackAndShowMeSendsThem() {
        val prefs = DiscoveryPreferences(ageMin = 23, ageMax = 34, maxDistanceKm = 25, verifiedOnly = true)
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.Filters, preferences = prefs, country = "DE"))
        compose.onNodeWithText("Anywhere in Germany").assertIsDisplayed()
        compose.onNodeWithText("Reset").performClick()
        compose.onNodeWithText("Up to 50 km").assertIsDisplayed()
        compose.onNodeWithText("Show me").performScrollTo().performClick()
        val defaults = DiscoveryPreferences()
        assertEquals(
            PreferencesPatch(maxDistanceKm = defaults.maxDistanceKm, ageMin = defaults.ageMin, ageMax = defaults.ageMax, verifiedOnly = false),
            actions.applied.single(),
        )
    }

    @Test
    fun lookingForIsOpenToEveryPlanAndShowMeSendsIt() {
        show(ready(ScreenTestData.negar).copy(sheet = DeckSheet.Filters, preferences = DiscoveryPreferences()))
        compose.onNodeWithText("Looking for").performScrollTo().performClick()
        // The config's intentions only (the test catalogue has one).
        compose.onNodeWithText("Marriage").assertDoesNotExist()
        compose.onNodeWithText("Something serious").performClick()
        // Closing the picker leaves the filters sheet with it chosen.
        compose.onAllNodes(hasContentDescription("Close") and SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).onLast()
            .performSemanticsAction(SemanticsActions.Dismiss)
        compose.waitForIdle()
        compose.onNode(hasText("Looking for") and hasText("Something serious")).assertExists()
        compose.onNodeWithText("Show me").performScrollTo().performClick()
        assertEquals(listOf("apply"), actions.calls)
        assertEquals(PreferencesPatch(intents = listOf(Intention.Serious)), actions.applied.single())
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianUsesItsOwnWordsAndDigits() {
        show(ready(ScreenTestData.negar))
        compose.onNodeWithText("\u2068Negar\u2069، ", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("۲۷", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("⁨Tehran⁩، ۴ کیلومتر", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("لایک").assertExists()
    }

    @Test
    @Config(qualifiers = "+tr")
    fun turkishToo() {
        show(DeckUiState(deck = DeckState(status = DeckStatus.Offline)))
        compose.onNodeWithText("İnternet yok.").assertIsDisplayed()
    }
}
