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
import androidx.compose.ui.test.performClick
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
    }

    private val actions = Recorder()

    private fun show(state: LikesUiState) {
        compose.setContent {
            AppTheme(dark = false) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    LikesScreen(state, ScreenTestData.catalog, mapOf("plus" to "Plus", "premium" to "Premium"), 300, actions)
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
    fun theFreePlanSeesBlursALockAndWhatWouldOpenThem() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike, hidden, hidden.copy(blurhash = "L6PZfSi_.AyE_3t7t7R**0o#DgR4")), total = 3, seeLikes = false))
        compose.onNodeWithText("3 people like you").assertIsDisplayed()
        compose.onNodeWithText("See who likes you").assertIsDisplayed()
        assertEquals(2, compose.onAllNodesWithContentDescription("Someone who likes you. Hidden on your plan.").fetchSemanticsNodes().size)
        compose.onAllNodesWithContentDescription("Someone who likes you. Hidden on your plan.")[0].performClick()
        assertEquals(listOf("open:hidden"), actions.calls)
    }

    @Test
    fun aSuperLikeIsOpenWithItsCommentAndThePartItLiked() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike, hidden), total = 2, seeLikes = false))
        compose.onNodeWithText("Super like", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Liked your photo", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("“\u2068Your map collection is great!\u2069”", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("\u2068Elif\u2069, 25").performClick()
        assertEquals(listOf("open:celif5ztr3wa2"), actions.calls)
    }

    @Test
    fun theDaysFreeLookIsMarked() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal, hidden), total = 2, seeLikes = false))
        compose.onNodeWithText("Today's free look", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun withSeeLikesEverythingIsOpenAndNothingIsCalledAFreeLook() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal, superlike), total = 2, seeLikes = true))
        compose.onNodeWithText("See who likes you").assertDoesNotExist()
        compose.onNodeWithText("Today's free look", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("\u2068Negar\u2069, 27").assertIsDisplayed()
    }

    @Test
    fun aFullBucketReadsNPlus() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(hidden), total = 99, totalPlus = true, seeLikes = false))
        compose.onNodeWithText("99+ people like you").assertIsDisplayed()
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
        compose.onNodeWithText("You're offline").assertIsDisplayed()
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
    fun aPageThatFailedOffersToTryAgain() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(superlike), total = 30, moreFailed = true, seeLikes = true))
        compose.onNodeWithText("More likes didn't load.").assertIsDisplayed()
    }

    @Test
    fun theOpenProfileLikesBackOrPasses() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(reveal), total = 1, seeLikes = true, details = ScreenTestData.negar))
        compose.onNode(hasContentDescription("Like back") and hasAnyAncestor(isDialog())).performClick()
        compose.onNode(hasContentDescription("Pass") and hasAnyAncestor(isDialog())).performClick()
        assertEquals(listOf("likeBack", "pass"), actions.calls)
    }

    @Test
    fun aHiddenLikeExplainsThePlans() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(hidden), total = 1, seeLikes = false, upsell = true))
        compose.onNodeWithText("Included with Plus / Premium.").assertIsDisplayed()
        compose.onNodeWithText("See plans").assertIsDisplayed()
        compose.onNodeWithText("Not now").performClick()
        assertEquals(listOf("dismissUpsell"), actions.calls)
    }

    @Test
    fun aMatchFromTheListLeadsToTheConversation() {
        show(LikesUiState(status = LikesStatus.Ready, items = emptyList(), match = MatchUi(ScreenTestData.negar, "42", null)))
        compose.onNodeWithText("Send a message").performClick()
        assertEquals(listOf("dismissMatch", "chat:42"), actions.calls)
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianCountsInPersianDigits() {
        show(LikesUiState(status = LikesStatus.Ready, items = listOf(hidden, hidden.copy(blurhash = "L6PZfSi_.AyE_3t7t7R**0o#DgR4")), total = 12, seeLikes = false))
        compose.onNodeWithText("۱۲ نفر شما را لایک کرده‌اند").assertIsDisplayed()
    }
}
