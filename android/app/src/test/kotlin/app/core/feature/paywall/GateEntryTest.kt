package app.core.feature.paywall

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.deck.FiltersSheet
import app.core.feature.deck.QuotaSheet
import app.core.feature.card.LikeTarget
import app.core.feature.likes.LikesActions
import app.core.feature.likes.LikesScreen
import app.core.feature.likes.LikesStatus
import app.core.feature.likes.LikesUiState
import app.core.model.Catalog
import app.core.model.Id
import app.core.model.LikeItem
import app.core.model.LikeKind
import app.core.model.DiscoveryPreferences
import app.core.model.FieldDef
import app.core.model.FieldOption
import app.core.model.PreferencesPatch
import app.core.model.SwipeAction
import app.core.model.WalletItem
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Every gate opens the paywall (or the packs) for what it gates, through [LocalPaywall]. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class GateEntryTest {

    @get:Rule val compose = createComposeRule()

    private val opened = mutableListOf<PaywallRequest>()
    private val dismissed = mutableListOf<String>()
    private val launcher = PaywallLauncher { opened += it }

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.setContent { AppTheme(template = Templates.of(Templates.WHITE)) { CompositionLocalProvider(LocalPaywall provides launcher) { content() } } }
    }

    @Test
    fun aHiddenLikeOpensThePlansThatShowItWithNoSheetBetween() {
        val actions = object : LikesActions {
            override fun refresh() {}
            override fun loadMore() {}
            override fun open(item: LikeItem) {}
            override fun closeDetails() {}
            override fun likeBack() {}
            override fun likeBack(item: LikeItem) {}
            override fun pass() {}
            override fun openItemLike(target: LikeTarget) {}
            override fun sendItemLike(target: LikeTarget, comment: String) {}
            override fun dismissItemLike() {}
            override fun dismissUpsell() { dismissed += "upsell" }
            override fun dismissQuota() {}
            override fun dismissMatch() {}
            override fun messageShown(id: Long) {}
            override fun openChat(conversationId: Id?) {}
            override fun browse() {}
        }
        val hidden = LikeItem(blurhash = "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.", kind = LikeKind.Like)
        show { LikesScreen(LikesUiState(status = LikesStatus.Ready, items = listOf(hidden), total = 1, seeLikes = false, upsell = true), Catalog(), 300, actions) }
        compose.waitForIdle()
        // The title says how many like the person: the server's total goes with the request.
        assertEquals(listOf(PaywallRequest.Plans(PaywallEntry.SEE_LIKES, likes = 1)), opened)
        assertEquals(listOf("upsell"), dismissed)
        compose.onNodeWithText("See plans").assertDoesNotExist()
    }

    @Test
    fun outOfLikesOpensThePlans() {
        show { QuotaSheet(SwipeAction.Like, null) { dismissed += "quota" } }
        compose.onNodeWithText("Get more likes").performClick()
        assertEquals(listOf(PaywallRequest.Plans(PaywallEntry.OUT_OF_LIKES)), opened)
    }

    @Test
    fun outOfSuperLikesOffersThePacksAndThePlans() {
        show { QuotaSheet(SwipeAction.Superlike, null) { dismissed += "quota" } }
        compose.onNodeWithText("Buy super likes").performClick()
        assertEquals(listOf(PaywallRequest.Packs(WalletItem.Superlike, PaywallEntry.OUT_OF_SUPERLIKES)), opened)
    }

    @Test
    fun advancedFiltersWithoutThePlanOpenThePaywall() {
        val fields = listOf(FieldDef(id = 7, key = "smoking", label = "Smoking", kind = "single", options = listOf(FieldOption(1, "Never"), FieldOption(2, "Sometimes")), filterable = true))
        show { FiltersSheet(DiscoveryPreferences(), saving = false, onApply = {}, onDismiss = { dismissed += "filters" }, advanced = false, advancedFields = fields) }
        // The paid section says so with its pill; each of its rows opens the paywall.
        compose.onNodeWithText("Subscription").performScrollTo().assertExists()
        compose.onNodeWithText("Smoking").performScrollTo().performClick()
        assertEquals(listOf(PaywallRequest.Plans(PaywallEntry.ADVANCED_FILTERS)), opened)
    }

    @Test
    fun advancedFiltersWithThePlanAreRowsWhoseChoicesGoInTheSamePatch() {
        val fields = listOf(FieldDef(id = 7, key = "smoking", label = "Smoking", kind = "single", options = listOf(FieldOption(1, "Never"), FieldOption(2, "Sometimes")), filterable = true))
        val applied = mutableListOf<PreferencesPatch>()
        show { FiltersSheet(DiscoveryPreferences(), saving = false, onApply = { applied += it }, onDismiss = {}, advanced = true, advancedFields = fields) }
        // A row with its value; its options open over the filters.
        compose.onNode(hasText("Smoking") and hasText("Any")).performScrollTo().assertExists()
        compose.onNodeWithText("Smoking").performScrollTo().performClick()
        compose.onNodeWithText("Never").performClick()
        compose.onNodeWithText("Show me").performScrollTo().performClick()
        assertEquals(mapOf("smoking" to listOf(1)), applied.single().filters)
        assertEquals(emptyList<PaywallRequest>(), opened)
    }
}
