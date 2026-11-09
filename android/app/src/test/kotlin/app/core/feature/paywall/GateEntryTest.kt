package app.core.feature.paywall

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.deck.FiltersSheet
import app.core.feature.deck.QuotaSheet
import app.core.feature.deck.UpsellSheet
import app.core.model.DiscoveryPreferences
import app.core.model.FieldDef
import app.core.model.FieldOption
import app.core.model.PreferencesPatch
import app.core.model.SwipeAction
import app.core.model.WalletItem
import app.core.ui.theme.AppTheme
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
    private val planNames = mapOf("plus" to "Plus", "premium" to "Premium")

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.setContent { AppTheme(dark = false) { CompositionLocalProvider(LocalPaywall provides launcher) { content() } } }
    }

    @Test
    fun aFeatureUpsellOpensThePlansForThatFeature() {
        show { UpsellSheet("See who likes you", "body", planNames, onDismiss = { dismissed += "upsell" }, entry = PaywallEntry.SEE_LIKES) }
        compose.onNodeWithText("See plans").performClick()
        assertEquals(listOf(PaywallRequest.Plans(PaywallEntry.SEE_LIKES)), opened)
        assertEquals(listOf("upsell"), dismissed)
    }

    @Test
    fun outOfLikesOpensThePlans() {
        show { QuotaSheet(SwipeAction.Like, null, planNames) { dismissed += "quota" } }
        compose.onNodeWithText("Get more likes").performClick()
        assertEquals(listOf(PaywallRequest.Plans(PaywallEntry.OUT_OF_LIKES)), opened)
    }

    @Test
    fun outOfSuperLikesOffersThePacksAndThePlans() {
        show { QuotaSheet(SwipeAction.Superlike, null, planNames) { dismissed += "quota" } }
        compose.onNodeWithText("Buy super likes").performClick()
        assertEquals(listOf(PaywallRequest.Packs(WalletItem.Superlike, PaywallEntry.OUT_OF_SUPERLIKES)), opened)
    }

    @Test
    fun advancedFiltersWithoutThePlanOpenThePaywall() {
        val fields = listOf(FieldDef(id = 7, key = "smoking", label = "Smoking", kind = "single", options = listOf(FieldOption(1, "Never"), FieldOption(2, "Sometimes")), filterable = true))
        show { FiltersSheet(DiscoveryPreferences(), saving = false, onApply = {}, onDismiss = { dismissed += "filters" }, advanced = false, advancedFields = fields) }
        compose.onNodeWithText("Included with a paid plan").performScrollTo().performClick()
        assertEquals(listOf(PaywallRequest.Plans(PaywallEntry.ADVANCED_FILTERS)), opened)
    }

    @Test
    fun advancedFiltersWithThePlanAreChipsThatGoInTheSamePatch() {
        val fields = listOf(FieldDef(id = 7, key = "smoking", label = "Smoking", kind = "single", options = listOf(FieldOption(1, "Never"), FieldOption(2, "Sometimes")), filterable = true))
        val applied = mutableListOf<PreferencesPatch>()
        show { FiltersSheet(DiscoveryPreferences(), saving = false, onApply = { applied += it }, onDismiss = {}, advanced = true, advancedFields = fields) }
        compose.onNodeWithText("Never").performScrollTo().performClick()
        compose.onNodeWithText("Show people").performScrollTo().performClick()
        assertEquals(mapOf("smoking" to listOf(1)), applied.single().filters)
        assertEquals(emptyList<PaywallRequest>(), opened)
    }
}
