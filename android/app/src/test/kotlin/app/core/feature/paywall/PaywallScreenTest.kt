package app.core.feature.paywall

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.billing.Catalogue
import app.core.billing.CatalogueJoin
import app.core.billing.FakeStoreApi
import app.core.billing.PurchaseFailure
import app.core.billing.PurchaseStep
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.model.PurchaseKind
import app.core.model.Wallet
import app.core.model.WalletItem
import app.core.store.ProductType
import app.core.store.Store
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.Instant

/** Every state of the paywall and the packs sheet, with the store's prices as they are. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class PaywallScreenTest {

    @get:Rule val compose = createComposeRule()

    private val store = Store.fromId(app.core.BuildConfig.STORE)
    private val storeName: String get() = ApplicationProvider.getApplicationContext<android.content.Context>().getString(R.string.store_name)
    private val planNames = mapOf("plus" to "Plus", "premium" to "Premium")
    private val links = PaywallLinks("https://example.com/terms", "https://example.com/privacy")

    private class Recorder : StoreActions {
        val calls = mutableListOf<String>()
        override fun close() { calls += "close" }
        override fun selectPlan(plan: Plan) { calls += "plan:${plan.wire}" }
        override fun select(key: String) { calls += "select:$key" }
        override fun buy(key: String) { calls += "buy:$key" }
        override fun restore() { calls += "restore" }
        override fun restoreShown() { calls += "restoreShown" }
        override fun retry() { calls += "retry" }
        override fun checkAgain() { calls += "checkAgain" }
        override fun stepShown() { calls += "stepShown" }
        override fun manage() { calls += "manage" }
        override fun openLink(url: String) { calls += "link:$url" }
        override fun installStore() { calls += "install" }
        override fun openStore() { calls += "openStore" }
        override fun seePlans() { calls += "plans" }
    }

    private val actions = Recorder()

    private val catalogue: Catalogue by lazy {
        val all = FakeStoreApi.storeProducts(store)
        CatalogueJoin.join(store, FakeStoreApi.catalogueOf(store), all.filter { it.type == ProductType.SUBSCRIPTION }, all.filter { it.type == ProductType.ONE_TIME })
    }

    private fun ready(step: PurchaseStep = PurchaseStep.Idle, e: Entitlements? = Entitlements(), plan: Plan = Plan.Plus) =
        StoreUiState(load = StoreLoad.Ready(catalogue), plan = plan, selected = catalogue.defaultOption(plan)?.key, step = step, entitlements = e)

    private var shown by mutableStateOf(StoreUiState())
    private var shownEntry by mutableStateOf(PaywallEntry.SEE_LIKES)
    private var started = false

    /** Sets the content once; later calls only change the state it draws. */
    private fun show(state: StoreUiState, entry: PaywallEntry = PaywallEntry.SEE_LIKES, dark: Boolean = false) {
        shown = state
        shownEntry = entry
        if (!started) {
            started = true
            compose.setContent { AppTheme(dark = dark) { PaywallScreen(shown, shownEntry, store, planNames, links, actions) } }
        }
        compose.waitForIdle()
    }

    private fun showPacks(state: StoreUiState, item: WalletItem = WalletItem.Superlike) {
        compose.setContent { AppTheme(dark = false) { PacksContent(state, item, actions) } }
    }

    private val firstPrice: String get() = catalogue.defaultOption(Plan.Plus)!!.price

    @Test
    fun thePlansShowTheStoresPriceThePeriodTheRenewalAndTheLinks() {
        show(ready())
        compose.onNodeWithText("See everyone who likes you").assertIsDisplayed()
        compose.onNodeWithText("Premium").assertIsDisplayed()
        compose.onNodeWithText("See who likes you").assertIsDisplayed()
        // The option row reads as one: period, the store's own price, the badge, and "selected".
        val row = hasContentDescription("1 month, $firstPrice, Most popular")
        compose.onNode(row).assertExists()
        compose.onNode(row and SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Selected")).assertExists()
        compose.onNodeWithText("every month. Renews automatically until you cancel.", substring = true).assertExists()
        compose.onNode(hasText(storeName, substring = true) and hasText("renews", substring = true)).assertExists()
        compose.onNodeWithText("Terms").performClick()
        compose.onNodeWithText("Privacy").performClick()
        compose.onNodeWithText("Restore purchases").performClick()
        compose.onNodeWithText("Subscribe").performClick()
        assertEquals(
            listOf("link:https://example.com/terms", "link:https://example.com/privacy", "restore", "buy:${catalogue.defaultOption(Plan.Plus)!!.key}"),
            actions.calls,
        )
    }

    @Test
    fun choosingAPlanAndAPeriodIsSaid() {
        show(ready())
        compose.onNodeWithText("Premium").performClick()
        compose.onNode(hasContentDescription("1 month", substring = true)).performScrollTo().performClick()
        assertEquals(listOf("plan:premium", "select:${catalogue.plan(Plan.Plus)!!.options.first().key}"), actions.calls)
    }

    @Test
    fun loadingAndEveryWayTheStoreCanBeUnavailable() {
        show(StoreUiState(load = StoreLoad.Loading))
        compose.onNodeWithText("Loading plans…").assertIsDisplayed()

        show(StoreUiState(load = StoreLoad.Unavailable(PurchaseFailure.STORE_MISSING)), PaywallEntry.GENERAL)
        compose.onNodeWithText("$storeName isn't on this phone").assertIsDisplayed()
        compose.onNodeWithText("Get $storeName").performClick()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("install", "retry"), actions.calls)
    }

    @Test
    fun aStoreNotSignedInOpensTheStore() {
        show(StoreUiState(load = StoreLoad.Unavailable(PurchaseFailure.STORE_NOT_READY)))
        compose.onNodeWithText("Sign in to $storeName").assertIsDisplayed()
        compose.onNodeWithText("Open $storeName").performClick()
        assertEquals(listOf("openStore"), actions.calls)
    }

    @Test
    fun offlineFailedAndNothingOnSale() {
        show(StoreUiState(load = StoreLoad.Offline))
        compose.onNodeWithText("You're offline").assertIsDisplayed()
        show(StoreUiState(load = StoreLoad.Failed), PaywallEntry.GENERAL)
        compose.onNodeWithText("Plans couldn't be loaded").assertIsDisplayed()
        val empty = Catalogue(store, "k7wq2m4zx5p3a", emptyList(), emptyList())
        show(StoreUiState(load = StoreLoad.Ready(empty)), PaywallEntry.GENERAL)
        compose.onNodeWithText("Nothing on sale right now").assertIsDisplayed()
    }

    @Test
    fun theStepsOfAPurchase() {
        val key = catalogue.defaultOption(Plan.Plus)!!.key
        show(ready(PurchaseStep.InStore(key)))
        compose.onNodeWithText("Opening $storeName…").assertIsDisplayed()
        compose.onNodeWithText("Restore purchases").assertIsNotEnabled()

        show(ready(PurchaseStep.Verifying(key)), PaywallEntry.GENERAL)
        compose.onNodeWithText("Confirming your purchase with $storeName…").assertIsDisplayed()

        show(ready(PurchaseStep.Pending(key)), PaywallEntry.GENERAL)
        compose.onNodeWithText("Payment pending").assertIsDisplayed()
        compose.onNodeWithText("Subscribe").assertIsNotEnabled()

        show(ready(PurchaseStep.Queued(key)), PaywallEntry.GENERAL)
        compose.onNodeWithText("Payment received").assertIsDisplayed()
        compose.onNodeWithText("Subscribe").assertIsNotEnabled()
        compose.onNodeWithText("There's nothing more to pay", substring = true).assertIsDisplayed()

        show(ready(PurchaseStep.Restoring(key)), PaywallEntry.GENERAL)
        compose.onNodeWithText("You already own this. Restoring it…").assertIsDisplayed()

        show(ready(PurchaseStep.Failed(key, PurchaseFailure.OTHER_ACCOUNT)), PaywallEntry.GENERAL)
        compose.onNodeWithText("This purchase belongs to another account", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Got it").performClick()
        assertEquals(listOf("stepShown"), actions.calls)
    }

    @Test
    fun aMissingStoreDuringThePurchaseOffersToGetIt() {
        val key = catalogue.defaultOption(Plan.Plus)!!.key
        show(ready(PurchaseStep.Failed(key, PurchaseFailure.STORE_MISSING)))
        compose.onNodeWithText("Get $storeName").performClick()
        assertEquals(listOf("install"), actions.calls)
    }

    @Test
    fun aConfirmedPlanSaysWelcomeAndCloses() {
        val key = catalogue.defaultOption(Plan.Plus)!!.key
        show(ready(PurchaseStep.Done(key, PurchaseKind.Subscription), Entitlements(plan = Plan.Plus, source = EntitlementSource.Play)))
        compose.onNodeWithText("Welcome to Plus").assertIsDisplayed()
        compose.onNodeWithText("Continue").performClick()
        assertEquals(listOf("stepShown", "close"), actions.calls)
    }

    @Test
    fun theCurrentPlanAndItsStoresPage() {
        val own = if (store == Store.PLAY) EntitlementSource.Play else EntitlementSource.Bazaar
        show(ready(e = Entitlements(plan = Plan.Plus, source = own, autoRenew = true, planExpiresAt = Instant.parse("2026-12-09T08:00:00Z")), plan = Plan.Premium))
        compose.onNodeWithText("Your plan").assertIsDisplayed()
        compose.onNodeWithText("Plus, renews on", substring = true).assertIsDisplayed()
        compose.onAllNodesWithText("Manage subscription")[0].performClick()
        assertEquals(listOf("manage"), actions.calls)
    }

    @Test
    fun aPlanThatBlocksASecondSubscriptionSaysSoBeforeAnyPurchase() {
        show(ready(plan = Plan.Premium).copy(subscriptionLocked = true))
        compose.onNodeWithText("You already have a subscription in $storeName", substring = true).assertExists()
        compose.onNodeWithText("Subscribe").assertIsNotEnabled()
    }

    private val ownSource: EntitlementSource get() = if (store == Store.PLAY) EntitlementSource.Play else EntitlementSource.Bazaar

    /** The person on Plus's first period, as the server names it. */
    private fun onPlus(): Pair<String, Entitlements> {
        val held = catalogue.plan(Plan.Plus)!!.options.first()
        return held.key to Entitlements(
            plan = Plan.Plus,
            source = ownSource,
            autoRenew = true,
            planExpiresAt = Instant.parse("2026-12-09T08:00:00Z"),
            productId = held.productId,
            basePlanId = held.product.basePlanId,
        )
    }

    @Test
    fun thePeriodThePersonIsOnIsMarkedAndNotSoldAgain() {
        val (held, e) = onPlus()
        show(ready(e = e).copy(selected = held, current = held))
        val row = hasContentDescription("Current plan", substring = true)
        compose.onNode(row).assertExists()
        compose.onNode(row and SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Selected")).assertExists()
        compose.onNodeWithText("You're on this plan").assertExists()
        assertTrue("no purchase button for it", compose.onAllNodesWithText("Subscribe").fetchSemanticsNodes().isEmpty())
        assertTrue("nor its price line", compose.onAllNodesWithText("Renews automatically", substring = true).fetchSemanticsNodes().isEmpty())

        // Another period is sold as usual (on Cafe Bazaar, after the note that one runs already).
        val other = catalogue.plans.flatMap { it.options }.first { it.key != held }
        show(ready(e = e, plan = other.plan).copy(selected = other.key, current = held, subscriptionLocked = store == Store.BAZAAR))
        compose.onNodeWithText("Subscribe").assertExists()
        assertTrue(compose.onAllNodesWithText("You're on this plan").fetchSemanticsNodes().isEmpty())
        if (store == Store.BAZAAR) compose.onNodeWithText("You already have a subscription in $storeName", substring = true).assertExists()
    }

    @Test
    fun aPlanHeldOnAnotherStoreAccountSaysSoWithItsPageAndSellsNoSubscription() {
        val (held, e) = onPlus()
        show(ready(e = e, plan = Plan.Premium).copy(current = held, heldElsewhere = true, subscriptionLocked = store == Store.BAZAAR))
        compose.onNodeWithText("$storeName on this phone doesn't list your plan. If you bought it with another $storeName account", substring = true).assertExists()
        assertTrue(compose.onAllNodesWithText("Subscribe").fetchSemanticsNodes().isEmpty())
        assertTrue("one way to the store's page, in the note", compose.onAllNodesWithText("Manage subscription").fetchSemanticsNodes().size == 1)
        assertTrue("the note replaces the other store's lock line", compose.onAllNodesWithText("You already have a subscription", substring = true).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Manage subscription").performClick()
        // The store's list can lag behind a purchase made elsewhere: the note asks it again on demand.
        compose.onNodeWithText("Check again").assertHasClickAction().performClick()
        assertEquals(listOf("manage", "checkAgain"), actions.calls)

        show(ready(e = e, plan = Plan.Premium).copy(current = held, heldElsewhere = true, checking = true))
        compose.onNodeWithText("Check again").assertIsNotEnabled()
    }

    @Test
    fun packsAreSoldWhileThePlanIsHeldOnAnotherStoreAccount() {
        val (held, e) = onPlus()
        showPacks(ready(e = e).copy(current = held, heldElsewhere = true))
        val pack = catalogue.packsFor(WalletItem.Superlike).single()
        compose.onNodeWithContentDescription("5 super likes for ${pack.price}").performClick()
        assertEquals(listOf("buy:cons.superlike.5"), actions.calls)
    }

    @Test
    fun aPlanTheAccountHasAlreadyIsSaidAsSuch() {
        val key = catalogue.defaultOption(Plan.Plus)!!.key
        show(ready(PurchaseStep.Failed(key, PurchaseFailure.ALREADY_CURRENT)))
        compose.onNodeWithText("You already have this plan.").assertExists()
    }

    @Test
    fun aRestoreOfWhatTheAccountHadSaysSo() {
        show(ready().copy(restoreNotice = RestoreNotice.UP_TO_DATE))
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Everything you bought is already on your account.").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun aRestoreOnASharedStoreAccountSaysBothThatTheAccountHasItsOwnAndThatAnotherPurchaseIsNotIts() {
        show(ready().copy(restoreNotice = RestoreNotice.UP_TO_DATE_WITH_OTHER_ACCOUNT))
        val text = "Everything you bought is already on your account. $storeName also has a purchase that belongs to another account."
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianSaysThePlanIsOnAnotherStoreAccount() {
        val (held, e) = onPlus()
        show(ready(e = e).copy(selected = held, current = held, heldElsewhere = true))
        compose.onNodeWithText("$storeName روی این گوشی اشتراکتان را نشان نمی‌دهد", substring = true).assertExists()
        compose.onNodeWithText("دوباره بررسی کنید").assertExists()
        show(ready(e = e).copy(selected = held, current = held))
        compose.onNodeWithText("همین اشتراک را دارید").assertExists()
        compose.onNode(hasContentDescription("اشتراک فعلی", substring = true)).assertExists()
    }

    @Test
    fun aGrantIsShownButHasNoStorePage() {
        show(ready(e = Entitlements(plan = Plan.Premium, source = EntitlementSource.Grant, planExpiresAt = Instant.parse("2026-12-09T08:00:00Z"))))
        compose.onNodeWithText("Premium, from", substring = true).assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("Manage subscription").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun aRestoreSaysWhatItFound() {
        show(ready().copy(restoreNotice = RestoreNotice.NOTHING))
        compose.waitUntil(5_000) { compose.onAllNodesWithText("There's nothing to restore.").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun packsShowTheWalletEachPackAndItsPrice() {
        showPacks(ready(e = Entitlements(wallet = Wallet(superlike = 4))))
        compose.onNodeWithText("Super likes").assertIsDisplayed()
        compose.onNodeWithText("You have 4 super likes").assertIsDisplayed()
        val pack = catalogue.packsFor(WalletItem.Superlike).single()
        compose.onNodeWithContentDescription("5 super likes for ${pack.price}").performClick()
        compose.onNodeWithText("Or get a plan").performClick()
        assertEquals(listOf("buy:cons.superlike.5", "plans"), actions.calls)
    }

    @Test
    fun aPackAddedSaysHowMany() {
        showPacks(ready(PurchaseStep.Done("cons.superlike.5", PurchaseKind.Consumable)))
        compose.onNodeWithText("Added to your account").assertIsDisplayed()
        compose.onNodeWithText("5 super likes").assertIsDisplayed()
    }

    @Test
    fun packsOfAnItemNotOnSaleSayNothingIsOnSale() {
        showPacks(ready(), WalletItem.Spotlight)
        compose.onNodeWithText("Nothing on sale right now").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianIsRightToLeftWithPersianDigitsAndTheStoresPriceUntouched() {
        showPacks(ready(e = Entitlements(wallet = Wallet(superlike = 4))))
        compose.onNodeWithText("۴ سوپرلایک دارید").assertIsDisplayed()
        val pack = catalogue.packsFor(WalletItem.Superlike).single()
        compose.onNodeWithContentDescription("۵ سوپرلایک به قیمت ${pack.price}").assertExists()
    }

    @Test
    @Config(qualifiers = "+fa-night")
    fun persianDarkPaywall() {
        show(ready(), dark = true)
        compose.onNodeWithText("همهٔ کسانی را که لایکتان کرده‌اند ببینید").assertIsDisplayed()
        compose.onNodeWithText("خرید اشتراک").assertIsDisplayed()
    }
}
