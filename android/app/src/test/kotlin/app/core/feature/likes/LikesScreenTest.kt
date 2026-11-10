package app.core.feature.likes

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.card.LikeTarget
import app.core.feature.card.ScreenTestData
import app.core.feature.deck.MatchUi
import app.core.media.LocalRemoteImages
import app.core.model.Id
import app.core.model.ItemKind
import app.core.model.LikeItem
import app.core.model.LikeKind
import app.core.model.LikedItem
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Every state of the likes list, blurred for the free plan and open with see-likes. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class LikesScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Recorder : LikesActions {
        val calls = mutableListOf<String>()
        override fun refresh() { calls += "refresh" }
        override fun loadMore() { calls += "more" }
        override fun open(item: LikeItem) { calls += "open:${item.liker?.id ?: "hidden"}" }
        override fun closeDetails() { calls += "close" }
        override fun likeBack() { calls += "likeBack" }
        override fun likeBack(item: LikeItem) { calls += "likeBack:${item.liker?.id}" }
        override fun pass() { calls += "pass" }
        override fun openItemLike(target: LikeTarget) { calls += "itemLike" }
        override fun sendItemLike(target: LikeTarget, comment: String) { calls += "send" }
        override fun dismissItemLike() { calls += "dismissItemLike" }
        override fun dismissUpsell() { calls += "dismissUpsell" }
        override fun dismissQuota() { calls += "dismissQuota" }
        override fun dismissMatch() { calls += "dismissMatch" }
        override fun messageShown(id: Long) { calls += "shown" }
        override fun openChat(conversationId: Id?) { calls += "chat:$conversationId" }
        override fun browse() { calls += "browse" }
        override fun report(card: app.core.model.ProfileCard, reason: app.core.model.ReportReason, details: String?, block: Boolean) {
            calls += "report:${card.id}:$reason:$block"
        }
        override fun block(card: app.core.model.ProfileCard) { calls += "block:${card.id}" }
    }

    private val actions = Recorder()
    private val sent = mutableListOf<Pair<String, String>>()

    private fun show(state: LikesUiState) {
        compose.setContent {
            AppTheme(template = Templates.of(Templates.WHITE)) {
                CompositionLocalProvider(
                    LocalRemoteImages provides false,
                    app.core.feature.match.LocalMatchMessages provides app.core.feature.match.MatchMessages { id, text -> sent += id to text },
                ) {
                    LikesScreen(state, ScreenTestData.catalog, 300, actions)
                }
            }
        }
    }

    private val hidden = LikeItem(blurhash = "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.", kind = LikeKind.Like)
    private val superlike = LikeItem(
        liker = ScreenTestData.elif,
        kind = LikeKind.Superlike,
        item = LikedItem(ItemKind.Photo, "9011"),
        comment = "Your map collection is great!",
    )
    private val reveal = LikeItem(liker = ScreenTestData.negar, kind = LikeKind.Like)

    @Test
    fun loadingIsASkeletonGrid() {
        show(LikesUiState(status = LikesStatus.Loading))
        compose.onNodeWithContentDescription("Finding people for you").assertIsDisplayed()
    }

    @Test
    fun theFreePlanSeesBlursAndOneButtonToThePlans() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike, hidden, hidden.copy(blurhash = "L6PZfSi_.AyE_3t7t7R**0o#DgR4")), total = 3, seeLikes = false))
        // The filters with their counts: all three, one super like, one with a note.
        compose.onNode(hasText("All") and hasText("3"), useUnmergedTree = false).assertIsDisplayed()
        compose.onNode(hasText("Super likes") and hasText("1")).assertIsDisplayed()
        compose.onNode(hasText("With a note") and hasText("1")).assertIsDisplayed()
        compose.onNodeWithText("See who likes you").assertIsDisplayed()
        assertEquals(2, compose.onAllNodesWithContentDescription("Someone who likes you. Hidden on your plan.").fetchSemanticsNodes().size)
        compose.onAllNodesWithContentDescription("Someone who likes you. Hidden on your plan.")[0].performClick()
        compose.onNodeWithText("See who likes you").performScrollTo().performClick()
        assertEquals(listOf("open:hidden", "open:hidden"), actions.calls)
    }

    @Test
    fun theLockedGridIsTwoRowsOverTheButtonAndAsksForNoMorePages() {
        val many = (1..9).map { hidden.copy(blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMd$it") }
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike) + many, total = 12, nextCursor = "c10", seeLikes = false))
        // The open super like and three blurred ones: four tiles, then the button.
        assertEquals(3, compose.onAllNodesWithContentDescription("Someone who likes you. Hidden on your plan.").fetchSemanticsNodes().size)
        compose.onNodeWithText("See who likes you").assertIsDisplayed()
        compose.waitForIdle()
        assertTrue("no further blurred pages: ${actions.calls}", "more" !in actions.calls)
        // Every open like stays, however many blurred ones came first.
        assertEquals(listOf(superlike) + many.take(3), lockedPreview(listOf(superlike) + many))
        assertEquals(many.take(3) + superlike, lockedPreview(many.take(5) + superlike))
    }

    @Test
    fun aNoteTakesItsQuotesAndDirectionFromItsOwnScript() {
        assertTrue(startsRightToLeft("منم عاشق ماسوله‌ام! اون مسیر رو رفتی؟"))
        assertTrue(startsRightToLeft("«سلام» Hi"))
        assertTrue(!startsRightToLeft("Hi «سلام»"))
        assertTrue(!startsRightToLeft("12345"))
        val persian = superlike.copy(comment = "منم عاشق ماسوله‌ام!")
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(persian), total = 1, seeLikes = true))
        compose.onNodeWithText("«منم عاشق ماسوله‌ام!»", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun theAllCountIsGroupedAsTheLanguageWritesIt() {
        val open = (1..3).map { superlike.copy(liker = superlike.liker!!.copy(id = "open$it"), kind = app.core.model.LikeKind.Superlike) }
        show(LikesUiState(status = LikesStatus.Ready, items = open, total = 1245, seeLikes = true))
        compose.onNodeWithText("1,245", substring = true, useUnmergedTree = true).assertExists()
    }

    @Test
    fun aSuperLikeIsOpenWithItsTagAndItsNote() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike, hidden), total = 2, seeLikes = false))
        compose.onNodeWithText("Super like", useUnmergedTree = true).assertIsDisplayed()
        // An English note in English quotes, laid out left to right.
        compose.onNodeWithText("“Your map collection is great!”", useUnmergedTree = true).assertIsDisplayed()
        // The part they liked is no caption on the tile any more (the profile shows it).
        compose.onNodeWithText("Liked your photo", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("\u2068Elif\u2069, 25").performClick()
        assertEquals(listOf("open:celif5ztr3wa2"), actions.calls)
    }

    @Test
    fun anOpenTileLikesBackFromItsOwnButton() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal), total = 1, seeLikes = true))
        compose.onNodeWithContentDescription("Like").performClick()
        assertEquals(listOf("likeBack:${ScreenTestData.negar.id}"), actions.calls)
    }

    @Test
    fun aFilterKeepsOnlyItsLikes() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal, superlike), total = 2, seeLikes = true))
        compose.onNodeWithContentDescription("\u2068Negar\u2069, 27").assertIsDisplayed()
        compose.onNode(hasText("Super likes") and hasText("1")).performClick()
        compose.onNodeWithContentDescription("\u2068Negar\u2069, 27").assertDoesNotExist()
        compose.onNodeWithContentDescription("\u2068Elif\u2069, 25").assertIsDisplayed()
        compose.onNode(hasText("All") and hasText("2")).performClick()
        compose.onNodeWithContentDescription("\u2068Negar\u2069, 27").assertIsDisplayed()
    }

    @Test
    fun theDaysFreeLookIsMarked() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal, hidden), total = 2, seeLikes = false))
        compose.onNodeWithText("Free today", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun withSeeLikesEverythingIsOpenAndNothingIsCalledAFreeLook() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal, superlike), total = 2, seeLikes = true))
        compose.onNodeWithText("See who likes you").assertDoesNotExist()
        compose.onNodeWithText("Free today", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("\u2068Negar\u2069, 27").assertIsDisplayed()
    }

    @Test
    fun aFullBucketReadsNPlus() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike, hidden), total = 99, totalPlus = true, seeLikes = false))
        compose.onNode(hasText("All") and hasText("99+")).assertIsDisplayed()
    }

    @Test
    fun emptyLeadsToTheDeck() {
        show(LikesUiState(status = LikesStatus.Ready, items = emptyList()))
        compose.onNodeWithText("No likes yet").assertIsDisplayed()
        compose.onNodeWithText("Discover people").performClick()
        assertEquals(listOf("browse"), actions.calls)
    }

    @Test
    fun offlineAndFailedRetry() {
        show(LikesUiState(status = LikesStatus.Offline))
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("refresh"), actions.calls)
    }

    @Test
    fun theNextPageIsAskedForAtTheEnd() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike), total = 30, nextCursor = "c20", seeLikes = true))
        compose.waitForIdle()
        assertTrue("more" in actions.calls)
    }

    @Test
    fun underAFilterTheNextPageWaitsToBeAskedFor() {
        val note = reveal.copy(liker = reveal.liker!!.copy(id = "bnote0000000a"), comment = "Hi")
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike, reveal, note), total = 30, nextCursor = "c20", seeLikes = true))
        compose.waitForIdle()
        actions.calls.clear()
        // Super likes chosen: one tile, the end of the list in view, and no page is read on its own.
        compose.onNode(hasText("Super likes") and hasClickAction()).performClick()
        compose.waitForIdle()
        assertTrue("no automatic page: ${actions.calls}", "more" !in actions.calls)
        compose.onNodeWithText("Show more").performScrollTo().performClick()
        assertEquals(listOf("more"), actions.calls)
    }

    @Test
    fun aPageThatFailedOffersToTryAgain() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike), total = 30, moreFailed = true, seeLikes = true))
        compose.onNodeWithText("More likes didn’t load.").assertIsDisplayed()
    }

    @Test
    fun theOpenProfileLikesBackOrPasses() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal), total = 1, seeLikes = true, details = ScreenTestData.negar))
        compose.onNode(hasContentDescription("Like back") and hasAnyAncestor(isDialog())).performClick()
        compose.onNode(hasContentDescription("Pass") and hasAnyAncestor(isDialog())).performClick()
        assertEquals(listOf("likeBack", "pass"), actions.calls)
    }

    @Test
    fun theOpenProfileCanBeBlockedAfterAConfirmation() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal), total = 1, seeLikes = true, details = ScreenTestData.negar))
        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Block").performClick()
        compose.onNodeWithText("Block \u2068Negar\u2069?").assertIsDisplayed()
        compose.onAllNodesWithText("Block").onLast().performClick()
        assertEquals(listOf("block:${ScreenTestData.negar.id}"), actions.calls)
    }

    @Test
    fun theOpenProfileCanBeReportedAndTheSheetSaysWhatGoesWithIt() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal), total = 1, seeLikes = true, details = ScreenTestData.negar))
        val page = compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog()))
        page.performScrollToNode(hasText("Report \u2068Negar\u2069"))
        compose.onNodeWithText("Report \u2068Negar\u2069").performClick()
        // No conversation goes with a profile report: the sheet does not say their messages do.
        compose.onNodeWithText("The team checks their profile with your report.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Their recent messages go with the report, so the team can check.").assertDoesNotExist()
        compose.onNodeWithText("Spam").performScrollTo().performClick()
        compose.onNodeWithText("Send report").performScrollTo().performClick()
        assertEquals(listOf("report:${ScreenTestData.negar.id}:${app.core.model.ReportReason.Spam}:true"), actions.calls)
    }

    @Test
    fun aFailedBlockIsToldOverTheOpenProfile() {
        show(
            LikesUiState(
                status = LikesStatus.Ready,
                items = listOf(reveal),
                total = 1,
                seeLikes = true,
                details = ScreenTestData.negar,
                message = LikesMessage(LikesNotice.SafetyFailed, 7),
            ),
        )
        compose.onNode(hasText("Something went wrong. Try again.") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.waitUntil(10_000) { "shown" in actions.calls }
    }

    @Test
    fun aHiddenLikeGoesStraightToThePlans() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(hidden), total = 1, seeLikes = false, upsell = true))
        compose.waitForIdle()
        // No sheet in between: the paywall opens (GateEntryTest) and the request is taken.
        compose.onNodeWithText("See plans").assertDoesNotExist()
        assertEquals(listOf("dismissUpsell"), actions.calls)
    }

    @Test
    fun aMatchFromTheListLeadsToTheConversation() {
        show(LikesUiState(status = LikesStatus.Ready, items = emptyList(), match = MatchUi(ScreenTestData.negar, "42", null)))
        compose.onNode(androidx.compose.ui.test.hasSetTextAction()).performTextInput("Hi")
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf("42" to "Hi"), sent)
        assertEquals(listOf("dismissMatch", "chat:42"), actions.calls)
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianCountsInPersianDigits() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike, hidden), total = 12, seeLikes = false))
        compose.onNode(hasText("همه") and hasText("۱۲")).assertIsDisplayed()
        compose.onNodeWithText("ببین کیا لایکت کردن").assertIsDisplayed()
    }
}
