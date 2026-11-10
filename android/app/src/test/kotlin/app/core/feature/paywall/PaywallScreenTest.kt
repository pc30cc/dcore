package app.core.feature.paywall

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
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
import app.core.billing.wireName
import app.core.model.BillingPeriod
import app.core.model.ConsumableProduct
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.PlanFlags
import app.core.model.PlanQuotas
import app.core.model.PurchaseKind
import app.core.model.StorePlan
import app.core.model.StoreProducts
import app.core.model.SubscriptionProduct
import app.core.model.Wallet
import app.core.model.WalletItem
import app.core.store.ProductType
import app.core.store.Store
import app.core.store.StoreProduct
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * Every state of the paywall (m14/h06) and the packs sheet (m15): the
 * server's plans with their names and what they give, the store's own
 * prices (toman regrouped for the reader, any other currency as the store
 * writes it), and each step of a purchase on the line under the button.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class PaywallScreenTest {

    @get:Rule val compose = createComposeRule()

    private val store = Store.fromId(app.core.BuildConfig.STORE)
    private val storeName: String get() = ApplicationProvider.getApplicationContext<android.content.Context>().getString(R.string.store_name)
    private val planNames = mapOf("plus" to "Plus (config)", "premium" to "Premium (config)")
    private val links = PaywallLinks("https://example.com/terms", "https://example.com/privacy")

    private class Recorder : StoreActions {
        val calls = mutableListOf<String>()
        override fun close() { calls += "close" }
        override fun selectPlan(plan: String) { calls += "plan:$plan" }
        override fun select(key: String) { calls += "select:$key" }
        override fun selectItem(item: WalletItem) { calls += "item:${item.wire}" }
        override fun selectPack(key: String) { calls += "pack:$key" }
        override fun buy(key: String) { calls += "buy:$key" }
        override fun restore() { calls += "restore" }
        override fun retry() { calls += "retry" }
        override fun checkAgain() { calls += "checkAgain" }
        override fun stepShown() { calls += "stepShown" }
        override fun manage() { calls += "manage" }
        override fun openLink(url: String) { calls += "link:$url" }
        override fun installStore() { calls += "install" }
        override fun openStore() { calls += "openStore" }
    }

    private val actions = Recorder()

    /** The shared fakes' catalogue: Plus and Premium, the store's own prices (€ on Play, toman on Cafe Bazaar). */
    private val catalogue: Catalogue by lazy {
        val all = FakeStoreApi.storeProducts(store)
        CatalogueJoin.join(store, FakeStoreApi.catalogueOf(store), all.filter { it.type == ProductType.SUBSCRIPTION }, all.filter { it.type == ProductType.ONE_TIME })
    }

    private fun plan(key: String, rank: Int, name: String, flags: PlanFlags = PlanFlags(), quotas: PlanQuotas = PlanQuotas(), badge: String? = null, description: String? = null) =
        StorePlan(key, rank, rank, name, description, badge, flags, quotas)

    /**
     * A catalogue of this build's store with the given plans and toman
     * prices (Cafe Bazaar's style), each plan sold for the periods in [prices].
     */
    private fun tomanCatalogue(plans: List<StorePlan>, prices: Map<String, List<Pair<BillingPeriod, String>>>, packs: List<Pair<Int, String>> = emptyList()): Catalogue {
        val subs = mutableListOf<SubscriptionProduct>()
        val products = mutableListOf<StoreProduct>()
        prices.forEach { (key, periods) ->
            periods.forEachIndexed { i, (period, price) ->
                val base = if (store == Store.PLAY) "b${period.wire.lowercase()}" else null
                val id = if (store == Store.PLAY) "sub.$key" else "sub.$key.${period.wire.lowercase()}"
                subs += SubscriptionProduct(id, base, key, period, if (period == BillingPeriod.ThreeMonths) "popular" else null, i)
                products += StoreProduct(id, ProductType.SUBSCRIPTION, id, "", price, basePlanId = base, billingPeriod = if (store == Store.PLAY) period.wire else null)
            }
        }
        val consumables = packs.mapIndexed { i, (n, _) -> ConsumableProduct("cons.superlike.$n", WalletItem.Superlike, n, if (n == 15) "best_value" else null, i) }
        val packProducts = packs.map { (n, price) -> StoreProduct("cons.superlike.$n", ProductType.ONE_TIME, "$n", "", price) }
        val server = StoreProducts(store.wireName(), FakeStoreApi.BILLING_REF, plans, subs, consumables)
        return CatalogueJoin.join(store, server, products, packProducts)
    }

    private val designPlans = listOf(
        plan("plus", 1, "Plus", PlanFlags(rewind = true), PlanQuotas(dailyLikes = -1, monthlyBoosts = 1)),
        plan("premium", 2, "Premium", PlanFlags(seeLikes = true, rewind = true, incognito = true, readReceipts = true), PlanQuotas(dailyLikes = -1, weeklySuperlikes = 5), badge = "popular"),
        plan("platinum", 3, "Platinum", PlanFlags(seeLikes = true), PlanQuotas(dailyLikes = -1, weeklySuperlikes = 10, monthlyBoosts = 2)),
    )

    private val designPrices = listOf(
        BillingPeriod.Month to "۱۸۰٬۰۰۰ تومان",
        BillingPeriod.ThreeMonths to "۴۵۰٬۰۰۰ تومان",
        BillingPeriod.Year to "۱٬۲۰۰٬۰۰۰ تومان",
    )

    private val designCatalogue: Catalogue by lazy {
        tomanCatalogue(designPlans, designPlans.associate { it.key to designPrices }, packs = listOf(5 to "۹۰٬۰۰۰ تومان", 15 to "۲۱۰٬۰۰۰ تومان", 30 to "۳۶۰٬۰۰۰ تومان"))
    }

    private fun ready(step: PurchaseStep = PurchaseStep.Idle, e: Entitlements? = Entitlements(), plan: String = "plus", c: Catalogue = catalogue) =
        StoreUiState(load = StoreLoad.Ready(c), plan = plan, selected = c.defaultOption(plan)?.key, step = step, entitlements = e)

    private var shown by mutableStateOf(StoreUiState())
    private var shownEntry by mutableStateOf(PaywallEntry.GENERAL)
    private var shownLikes by mutableStateOf<Int?>(null)
    private var started = false

    /** Sets the content once; later calls only change the state it draws. */
    private fun show(state: StoreUiState, entry: PaywallEntry = PaywallEntry.GENERAL, likes: Int? = null, dark: Boolean = false) {
        shown = state
        shownEntry = entry
        shownLikes = likes
        if (!started) {
            started = true
            compose.setContent { AppTheme(template = Templates.of(if (dark) Templates.NEON else Templates.WHITE)) { PaywallScreen(shown, shownEntry, store, planNames, links, actions, likes = shownLikes) } }
        }
        compose.waitForIdle()
    }

    private var packsShown by mutableStateOf(StoreUiState())

    private fun showPacks(state: StoreUiState) {
        packsShown = state
        if (!started) {
            started = true
            compose.setContent { AppTheme(template = Templates.of(Templates.WHITE)) { PacksContent(packsShown, actions) } }
        }
        compose.waitForIdle()
    }

    private val cta: SemanticsMatcher = hasText("Continue for", substring = true) and hasClickAction()

    @Test
    fun thePlansAreTheServersWithWhatTheyGiveThePeriodsThePriceOnTheButtonTheStoreLineAndTheLinks() {
        show(ready(c = designCatalogue, plan = "premium"))
        compose.onNodeWithText("Choose a plan").assertIsDisplayed()
        // The server's names, not the config's; two or three plans are a segmented control.
        compose.onNode(hasText("Premium") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).assertExists()
        compose.onNodeWithText("Platinum").assertExists()
        assertTrue(compose.onAllNodesWithText("Premium (config)").fetchSemanticsNodes().isEmpty())
        // What Premium gives, from its switches and quotas, four at most, in the design's order.
        for (line in listOf("See who likes you", "Unlimited likes", "5 super likes a week", "Undo your last pass")) compose.onNodeWithText(line).assertExists()
        assertTrue("four at most", compose.onAllNodesWithText("Incognito mode").fetchSemanticsNodes().isEmpty())
        // The periods: the toman price regrouped for the reader with its word apart, the saving rounded half up as the design writes it.
        compose.onNodeWithText("3 months").assertExists()
        compose.onNodeWithText("450,000").assertExists()
        compose.onNodeWithText("1,200,000").assertExists()
        compose.onNodeWithText("Save 17%").assertExists()
        compose.onNodeWithText("Save 44%").assertExists()
        assertTrue("no saving on the first period", compose.onAllNodesWithText("Save 0%").fetchSemanticsNodes().isEmpty())
        // The popular period is chosen: its price is on the button, its renewal on the one line under it.
        compose.onNode(cta).assertExists()
        compose.onNodeWithText("Continue for 450,000 Toman").assertExists()
        compose.onNodeWithText("Renews every 3 months. Cancel in $storeName.").assertExists()
        compose.onNodeWithText("Terms").performScrollTo().performClick()
        compose.onNodeWithText("Privacy").performClick()
        compose.onNodeWithText("Restore").performClick()
        compose.onNode(cta).performClick()
        val chosen = designCatalogue.defaultOption("premium")!!.key
        assertEquals(listOf("link:https://example.com/terms", "link:https://example.com/privacy", "restore", "buy:$chosen"), actions.calls)
    }

    @Test
    fun choosingAPlanAndAPeriodIsSaid() {
        show(ready(c = designCatalogue, plan = "premium"))
        compose.onNodeWithText("Plus").performClick()
        compose.onNodeWithText("12 months").performClick()
        val year = designCatalogue.plan("premium")!!.options.first { it.period == BillingPeriod.Year }.key
        assertEquals(listOf("plan:plus", "select:$year"), actions.calls)
    }

    @Test
    fun fourOrMorePlansAreARailOfNameOnlyCards() {
        val many = listOf("plus", "summer", "premium", "platinum", "vip").mapIndexed { i, key -> plan(key, i + 1, key.replaceFirstChar(Char::titlecase)) }
        val c = tomanCatalogue(many, many.associate { it.key to listOf(BillingPeriod.Month to "۱۲۰٬۰۰۰ تومان") })
        show(ready(c = c, plan = "summer"), PaywallEntry.OUT_OF_LIKES)
        compose.onNodeWithText("You’re out of likes for today").assertExists()
        // Radio cards, not tabs; no price on a card.
        compose.onNode(hasText("Summer") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)).assertExists()
        assertTrue(compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Continue for 120,000 Toman").assertExists()
        compose.onNodeWithText("Renews every month. Cancel in $storeName.").assertExists()
        compose.onNodeWithText("Plus").performClick()
        assertEquals(listOf("plan:plus"), actions.calls)
    }

    @Test
    fun aPlanKeyThisBuildNeverHeardOfIsSoldLikeAnyOther() {
        val gold = listOf(plan("gold_summer", 4, "Summer gold", PlanFlags(seeLikes = true, priorityLikes = true), PlanQuotas(monthlyBoosts = 2)))
        val c = tomanCatalogue(gold, mapOf("gold_summer" to listOf(BillingPeriod.Month to "۱۲۰٬۰۰۰ تومان")))
        show(ready(c = c, plan = "gold_summer"))
        compose.onNodeWithText("See who likes you").assertExists()
        compose.onNodeWithText("2 boosts a month").assertExists()
        compose.onNodeWithText("Your likes are seen first").assertExists()
        compose.onNode(cta).performClick()
        assertEquals(listOf("buy:${c.defaultOption("gold_summer")!!.key}"), actions.calls)
    }

    @Test
    fun aPlanThatGivesEverythingTheOneBelowGivesSaysSoAndListsWhatItAdds() {
        // The design's catalogue: Platinum is Premium and more; Premium is not Plus and more (Plus has a boost).
        val premiumFlags = PlanFlags(seeLikes = true, rewind = true, incognito = true, readReceipts = true)
        val plans = listOf(
            plan("plus", 1, "Plus", PlanFlags(rewind = true), PlanQuotas(dailyLikes = -1, monthlyBoosts = 1)),
            plan("premium", 2, "Premium", premiumFlags, PlanQuotas(dailyLikes = -1, weeklySuperlikes = 5)),
            plan("platinum", 3, "Platinum", premiumFlags.copy(priorityLikes = true), PlanQuotas(dailyLikes = -1, weeklySuperlikes = 10, dailyDm = -1, monthlyBoosts = 2)),
        )
        val c = tomanCatalogue(plans, plans.associate { it.key to designPrices })
        show(ready(c = c, plan = "platinum"))
        val lines = listOf("Everything in Premium", "Message before you match", "10 super likes a week", "2 boosts a month")
        lines.forEach { compose.onNodeWithText(it).assertExists() }
        assertTrue("four at most: the fifth addition is left out", compose.onAllNodesWithText("Your likes are seen first").fetchSemanticsNodes().isEmpty())
        show(ready(c = c, plan = "premium"))
        for (line in listOf("See who likes you", "Unlimited likes", "5 super likes a week", "Undo your last pass")) compose.onNodeWithText(line).assertExists()
        assertTrue(compose.onAllNodesWithText("Everything in Plus").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun nothingCanBeChosenWhileAPurchaseIsUnderWayAndOnlyItsButtonWorks() {
        val key = designCatalogue.defaultOption("premium")!!.key
        show(ready(PurchaseStep.Connecting(key), c = designCatalogue, plan = "premium"))
        compose.onNodeWithText("12 months").assertIsNotEnabled()
        compose.onNode(hasText("Plus") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).assertIsNotEnabled()
        compose.onNode(cta and SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Loading")).assertExists()
        // A step for another period (one bought before a new choice) does not spin this button.
        val year = designCatalogue.plan("premium")!!.options.first { it.period == BillingPeriod.Year }.key
        show(ready(PurchaseStep.Verifying(year), c = designCatalogue, plan = "premium"))
        compose.onNode(cta and SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Loading")).assertDoesNotExist()
        compose.onNode(cta).assertIsNotEnabled()
        show(ready(c = designCatalogue, plan = "premium"))
        compose.onNodeWithText("12 months").assertIsEnabled()
    }

    @Test
    fun aRestoreUnderWayIsSaidOnTheLineAndItsAnswerTakesTheSamePlace() {
        show(ready(c = designCatalogue, plan = "premium").copy(restoring = true))
        compose.onNodeWithText("Checking your purchases…").assertIsDisplayed()
        compose.onNodeWithText("Restore").assertIsNotEnabled()
        compose.onNode(hasText("Checking your purchases…") and SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion)).assertExists()
        show(ready(c = designCatalogue, plan = "premium").copy(restoreNotice = RestoreNotice.NOTHING))
        compose.onNodeWithText("Nothing to restore.").assertIsDisplayed()
        // The links stay visible: nothing is drawn over them.
        compose.onNodeWithText("Restore").assertIsDisplayed()
        // The button still buys: the renewal terms stay under the answer, not said aloud.
        compose.onNode(hasText("Renews every 3 months. Cancel in $storeName.") and SemanticsMatcher.keyNotDefined(SemanticsProperties.LiveRegion)).assertExists()
        compose.onNode(cta).assertIsEnabled()
    }

    @Test
    fun theRenewalTermsStayUnderTheButtonWhileAPaymentWaitsOrAPurchaseFailed() {
        show(ready(c = designCatalogue, plan = "premium").copy(waiting = 1))
        compose.onNodeWithText("Renews every 3 months. Cancel in $storeName.").assertExists()
        compose.onNode(cta).assertIsEnabled()
        val key = designCatalogue.defaultOption("premium")!!.key
        show(ready(PurchaseStep.Failed(key, PurchaseFailure.STORE_UNREACHABLE), c = designCatalogue, plan = "premium"))
        compose.onNodeWithText("Renews every 3 months. Cancel in $storeName.").assertExists()
    }

    @Test
    fun aStoreSubscriberKeepsTheStoresPageWhenThePlansCannotBeShown() {
        val (_, e) = onPlus()
        for (load in listOf(StoreLoad.Failed, StoreLoad.Offline, StoreLoad.Loading, StoreLoad.Unavailable(PurchaseFailure.STORE_UNREACHABLE))) {
            actions.calls.clear()
            show(StoreUiState(load = load, entitlements = e))
            compose.onNodeWithText("Manage subscription").performScrollTo().performClick()
            assertEquals("$load", listOf("manage"), actions.calls)
        }
        // A catalogue with nothing of this store on sale: the same.
        actions.calls.clear()
        val empty = Catalogue(store, "k7wq2m4zx5p3a", emptyList(), emptyList())
        show(StoreUiState(load = StoreLoad.Ready(empty), entitlements = e))
        compose.onNodeWithText("Manage subscription").performScrollTo().performClick()
        assertEquals(listOf("manage"), actions.calls)
        // Without a plan of this store there is nothing to manage.
        show(StoreUiState(load = StoreLoad.Failed, entitlements = Entitlements()))
        assertTrue(compose.onAllNodesWithText("Manage subscription").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun theRenewalLineIsNotAnnouncedOnEveryChoiceButAStepIs() {
        show(ready(c = designCatalogue, plan = "premium"))
        compose.onNode(hasText("Renews every 3 months. Cancel in $storeName.") and SemanticsMatcher.keyNotDefined(SemanticsProperties.LiveRegion)).assertExists()
        show(ready(PurchaseStep.Pending(designCatalogue.defaultOption("premium")!!.key), c = designCatalogue, plan = "premium"))
        compose.onNode(hasText("Your payment is pending.") and SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion)).assertExists()
    }

    @Test
    fun whenTheCatalogueCannotBeShownWhatHappenedIsThePagesOnlyTitle() {
        show(StoreUiState(load = StoreLoad.Unavailable(PurchaseFailure.STORE_MISSING)))
        compose.onNode(hasText("$storeName isn’t on this phone.") and SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)).assertExists()
        assertTrue("no second heading", compose.onAllNodesWithText("Choose a plan").fetchSemanticsNodes().isEmpty())
        assertEquals(1, compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)).fetchSemanticsNodes().size)
    }

    @Test
    fun aConfirmedPlanIsNamedByThePeriodJustBoughtEvenBeforeTheAccountShowsIt() {
        val key = designCatalogue.defaultOption("premium")!!.key
        // The entitlements still say free (the purchase settled elsewhere and they were not read again yet).
        show(ready(PurchaseStep.Done(key, PurchaseKind.Subscription), Entitlements(), c = designCatalogue, plan = "plus"))
        compose.onNodeWithText("Premium is active.").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("Free is active.").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun aPlanNoLineDescribesShowsItsOwnDescription() {
        val plain = listOf(plan("basic", 1, "Basic", description = "The basics, for a month."))
        val c = tomanCatalogue(plain, mapOf("basic" to listOf(BillingPeriod.Month to "۵۰٬۰۰۰ تومان")))
        show(ready(c = c, plan = "basic"))
        compose.onNodeWithText("The basics, for a month.").assertExists()
    }

    @Test
    fun aPriceInAnotherCurrencyIsTheStoresOwnString() {
        // The shared fakes: € on Play; toman on Cafe Bazaar.
        show(ready())
        val option = catalogue.defaultOption("plus")!!
        if (option.price.startsWith("€")) {
            compose.onNodeWithText("Continue for ⁨${option.price}⁩").assertExists()
        } else {
            compose.onNodeWithText("Continue for 120,000 Toman").assertExists()
        }
    }

    @Test
    fun theLikesTitleSaysHowManyLikeThePerson() {
        show(ready(c = designCatalogue, plan = "premium"), PaywallEntry.SEE_LIKES, likes = 12)
        compose.onNodeWithText("12 people like you").assertExists()
        show(ready(c = designCatalogue, plan = "premium"), PaywallEntry.SEE_LIKES, likes = null)
        compose.onNodeWithText("Choose a plan").assertExists()
    }

    @Test
    fun loadingAndEveryWayTheStoreCanBeUnavailable() {
        show(StoreUiState(load = StoreLoad.Loading))
        compose.onNodeWithContentDescription("Loading").assertExists()
        assertTrue("no price, no button while loading", compose.onAllNodes(cta).fetchSemanticsNodes().isEmpty())

        show(StoreUiState(load = StoreLoad.Unavailable(PurchaseFailure.STORE_MISSING)))
        compose.onNodeWithText("$storeName isn’t on this phone.").assertIsDisplayed()
        compose.onNodeWithText("Get $storeName").performClick()
        show(StoreUiState(load = StoreLoad.Unavailable(PurchaseFailure.STORE_UNREACHABLE)))
        compose.onNodeWithText("$storeName didn’t answer. Try again.").assertExists()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("install", "retry"), actions.calls)
    }

    @Test
    fun aStoreNotSignedInOpensTheStore() {
        show(StoreUiState(load = StoreLoad.Unavailable(PurchaseFailure.STORE_NOT_READY)))
        compose.onNodeWithText("Sign in to $storeName or update it, then try again.").assertIsDisplayed()
        compose.onNodeWithText("Open $storeName").performClick()
        assertEquals(listOf("openStore"), actions.calls)
    }

    @Test
    fun offlineFailedAndNothingOnSale() {
        show(StoreUiState(load = StoreLoad.Offline))
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        show(StoreUiState(load = StoreLoad.Failed))
        compose.onNodeWithText("Something went wrong. Try again.").assertIsDisplayed()
        val empty = Catalogue(store, "k7wq2m4zx5p3a", emptyList(), emptyList())
        show(StoreUiState(load = StoreLoad.Ready(empty)))
        compose.onNodeWithText("Nothing to buy right now.").assertIsDisplayed()
        // The links stay: restore works with nothing on sale.
        compose.onNodeWithText("Restore").performClick()
        assertEquals(listOf("restore"), actions.calls)
    }

    @Test
    fun theStepsOfAPurchaseAreSaidOnTheLineUnderTheButton() {
        val key = catalogue.defaultOption("plus")!!.key
        show(ready(PurchaseStep.InStore(key)))
        compose.onNode(cta and SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Loading")).assertExists()
        compose.onNodeWithText("Restore").assertIsNotEnabled()

        show(ready(PurchaseStep.Verifying(key)))
        compose.onNodeWithText("Confirming with $storeName…").assertIsDisplayed()

        show(ready(PurchaseStep.Pending(key)))
        compose.onNodeWithText("Your payment is pending.").assertIsDisplayed()
        compose.onNode(cta).assertIsNotEnabled()

        show(ready(PurchaseStep.Queued(key)))
        compose.onNodeWithText("Payment received. We’ll confirm it once you’re online.").assertIsDisplayed()
        compose.onNode(cta).assertIsNotEnabled()

        show(ready(PurchaseStep.Restoring(key)))
        compose.onNodeWithText("You bought this already. Restoring it…").assertIsDisplayed()

        show(ready(PurchaseStep.Failed(key, PurchaseFailure.OTHER_ACCOUNT)))
        compose.onNodeWithText("This purchase belongs to another account.").assertIsDisplayed()
        compose.onNode(cta).assertIsEnabled()

        show(ready().copy(waiting = 1))
        compose.onNodeWithText("A payment is still being confirmed. We’ll keep trying.").assertIsDisplayed()
    }

    @Test
    fun aMissingStoreDuringThePurchaseOffersToGetIt() {
        val key = catalogue.defaultOption("plus")!!.key
        show(ready(PurchaseStep.Failed(key, PurchaseFailure.STORE_MISSING)))
        compose.onNodeWithText("$storeName isn’t on this phone.").assertExists()
        compose.onNodeWithText("Get $storeName").performClick()
        assertEquals(listOf("install"), actions.calls)
    }

    @Test
    fun aConfirmedPlanSaysItIsActiveAndCloses() {
        val key = catalogue.defaultOption("plus")!!.key
        show(ready(PurchaseStep.Done(key, PurchaseKind.Subscription), Entitlements(plan = "plus", source = EntitlementSource.Play)))
        compose.onNodeWithText("Plus is active.").assertIsDisplayed()
        compose.onNodeWithText("Continue").performClick()
        assertEquals(listOf("stepShown", "close"), actions.calls)
    }

    private val ownSource: EntitlementSource get() = if (store == Store.PLAY) EntitlementSource.Play else EntitlementSource.Bazaar

    /** The person on Plus's first period, as the server names it. */
    private fun onPlus(): Pair<String, Entitlements> {
        val held = catalogue.plan("plus")!!.options.first()
        return held.key to Entitlements(
            plan = "plus",
            source = ownSource,
            autoRenew = true,
            planExpiresAt = Instant.parse("2026-12-09T08:00:00Z"),
            productId = held.productId,
            basePlanId = held.product.basePlanId,
        )
    }

    @Test
    fun thePeriodThePersonIsOnIsMarkedAndNotSoldAgainItsButtonOpensTheStoresPage() {
        val (held, e) = onPlus()
        show(ready(e = e).copy(selected = held, current = held))
        compose.onNodeWithText("Current plan").assertExists()
        assertTrue("no purchase button for it", compose.onAllNodes(cta).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Manage subscription").performClick()
        assertEquals(listOf("manage"), actions.calls)

        // Another period: on Play it is sold (a plan change), and the store's page stays one tap away under the line;
        // on Cafe Bazaar nothing else is sold while the plan runs: the button is the store's page, the line says why.
        val other = catalogue.plans.flatMap { it.options }.first { it.key != held }
        show(ready(e = e, plan = other.plan).copy(selected = other.key, current = held, subscriptionLocked = store == Store.BAZAAR))
        assertEquals("one way to the store's page", 1, compose.onAllNodesWithText("Manage subscription").fetchSemanticsNodes().size)
        if (store == Store.BAZAAR) {
            compose.onNodeWithText("You can choose another plan once this one ends.").assertExists()
            assertTrue("no greyed price button", compose.onAllNodes(cta).fetchSemanticsNodes().isEmpty())
        } else {
            compose.onNode(cta).assertIsEnabled()
        }
        compose.onNodeWithText("Manage subscription").performClick()
        assertEquals(listOf("manage", "manage"), actions.calls)
    }

    @Test
    fun aStorePlanTheCatalogueNoLongerSellsKeepsItsStoresPage() {
        // Held on a plan taken off sale: no period of it to choose, the store's page under the line.
        val e = Entitlements(plan = "gold_old", source = ownSource, autoRenew = true, planExpiresAt = Instant.parse("2026-12-09T08:00:00Z"), productId = "sub.gold_old")
        show(ready(e = e, c = designCatalogue, plan = "premium"))
        compose.onNodeWithText("Manage subscription").assertExists().performClick()
        assertEquals(listOf("manage"), actions.calls)
    }

    @Test
    fun aPlanHeldOnAnotherStoreAccountSaysSoWithItsPageAndSellsNoSubscription() {
        val (held, e) = onPlus()
        show(ready(e = e, plan = "premium").copy(current = held, heldElsewhere = true, subscriptionLocked = store == Store.BAZAAR))
        compose.onNodeWithText("Your plan is on another $storeName account.").assertExists()
        assertTrue(compose.onAllNodes(cta).fetchSemanticsNodes().isEmpty())
        assertTrue("one way to the store's page", compose.onAllNodesWithText("Manage subscription").fetchSemanticsNodes().size == 1)
        assertTrue("the line replaces the lock line", compose.onAllNodesWithText("You can choose another plan once this one ends.").fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Manage subscription").performClick()
        // The store's list can lag behind a purchase made elsewhere: the line asks it again on demand.
        compose.onNodeWithText("Check again").assertHasClickAction().performClick()
        assertEquals(listOf("manage", "checkAgain"), actions.calls)

        show(ready(e = e, plan = "premium").copy(current = held, heldElsewhere = true, checking = true))
        compose.onNodeWithText("Check again").assertIsNotEnabled()
    }

    @Test
    fun aPlanTheAccountHasAlreadyIsSaidAsSuch() {
        val key = catalogue.defaultOption("plus")!!.key
        show(ready(PurchaseStep.Failed(key, PurchaseFailure.ALREADY_CURRENT)))
        compose.onNodeWithText("You already have this plan.").assertExists()
    }

    @Test
    fun aGrantIsNotTheStoresToManage() {
        show(ready(e = Entitlements(plan = "premium", source = EntitlementSource.Grant, planExpiresAt = Instant.parse("2026-12-09T08:00:00Z")), plan = "premium"))
        assertTrue(compose.onAllNodesWithText("Manage subscription").fetchSemanticsNodes().isEmpty())
        compose.onNode(cta).assertExists()
    }

    @Test
    fun aRestoreSaysWhatItFound() {
        show(ready().copy(restoreNotice = RestoreNotice.UP_TO_DATE))
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Everything you bought is already on your account.").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun aRestoreOnASharedStoreAccountSaysBothThatTheAccountHasItsOwnAndThatAnotherPurchaseIsNotIts() {
        show(ready().copy(restoreNotice = RestoreNotice.UP_TO_DATE_WITH_OTHER_ACCOUNT))
        val text = "Everything you bought is already on your account. $storeName also has a purchase from another account."
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun aRestoreWithNothingToRestoreSaysSo() {
        show(ready().copy(restoreNotice = RestoreNotice.NOTHING))
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Nothing to restore.").fetchSemanticsNodes().isNotEmpty() }
    }

    // MARK: - Packs

    private fun packsState(step: PurchaseStep = PurchaseStep.Idle, e: Entitlements? = Entitlements(wallet = Wallet(superlike = 1)), item: WalletItem = WalletItem.Superlike, c: Catalogue = designCatalogue) =
        StoreUiState(load = StoreLoad.Ready(c), item = item, selectedPack = c.packsFor(item).startPack()?.key, step = step, entitlements = e)

    @Test
    fun packsShowTheBalanceTheCountsAndPricesTheButtonAndOneLineOfTerms() {
        showPacks(packsState())
        compose.onNodeWithText("More super likes").assertIsDisplayed()
        compose.onNodeWithText("You have 1").assertIsDisplayed()
        // Each pack reads as one: what it holds and the store's price; the best value is chosen first.
        compose.onNode(hasContentDescription("15 super likes, 210,000 Toman") and SemanticsMatcher.expectValue(SemanticsProperties.Selected, true)).assertExists()
        compose.onNodeWithText("Buy for 210,000 Toman").assertExists()
        compose.onNodeWithText("One-time payment, no renewal.").assertExists()
        compose.onNodeWithContentDescription("30 super likes, 360,000 Toman").performClick()
        compose.onNodeWithText("Buy for 210,000 Toman").performClick()
        assertEquals(listOf("pack:cons.superlike.30", "buy:cons.superlike.15"), actions.calls)
    }

    @Test
    fun packsSwitchBetweenSuperLikesAndBoostsWhenBothAreOnSale() {
        // The shared fakes sell super likes only: no switch.
        showPacks(packsState(c = catalogue))
        assertTrue(compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun packsAreSoldWhileThePlanIsHeldOnAnotherStoreAccount() {
        val (held, e) = onPlus()
        showPacks(packsState(e = e).copy(current = held, heldElsewhere = true))
        compose.onNodeWithText("One-time payment, no renewal.").assertExists()
        compose.onNodeWithText("Buy for 210,000 Toman").performClick()
        assertEquals(listOf("buy:cons.superlike.15"), actions.calls)
    }

    @Test
    fun aPackBeingConfirmedIsSaidAndAPackAddedSaysHowMany() {
        showPacks(packsState(PurchaseStep.Verifying("cons.superlike.15")))
        compose.onNodeWithText("Confirming with $storeName…").assertExists()
        showPacks(packsState(PurchaseStep.Done("cons.superlike.5", PurchaseKind.Consumable)))
        compose.onNodeWithText("5 super likes added.").assertIsDisplayed()
        compose.onNodeWithText("Continue").performClick()
        assertEquals(listOf("stepShown", "close"), actions.calls)
    }

    @Test
    fun packsOfAnItemNotOnSaleSayNothingIsOnSale() {
        showPacks(packsState(item = WalletItem.Spotlight))
        compose.onNodeWithText("Nothing to buy right now.").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianIsRightToLeftWithPersianDigitsAndTheThousandsSign() {
        showPacks(packsState(e = Entitlements(wallet = Wallet(superlike = 4))))
        compose.onNodeWithText("سوپرلایک بیشتر").assertIsDisplayed()
        compose.onNodeWithText("۴ تا داری").assertIsDisplayed()
        compose.onNodeWithContentDescription("۱۵ سوپرلایک، ۲۱۰٬۰۰۰ تومان").assertExists()
        compose.onNodeWithText("خرید با ۲۱۰٬۰۰۰ تومان").assertExists()
        compose.onNodeWithText("یه بار پرداخت، بدون تمدید.").assertExists()
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianPaywall() {
        show(ready(c = designCatalogue, plan = "premium"), PaywallEntry.SEE_LIKES, likes = 12)
        compose.onNodeWithText("۱۲ نفر لایکت کردن").assertIsDisplayed()
        compose.onNodeWithText("۳ ماهه").assertExists()
        compose.onNodeWithText("۴۵۰٬۰۰۰").assertExists()
        compose.onNodeWithText("۱۷٪ کمتر").assertExists()
        compose.onNodeWithText("ادامه با ۴۵۰٬۰۰۰ تومان").assertExists()
        compose.onNodeWithText("هر ۳ ماه خودکار تمدید می‌شه؛ از $storeName لغوش کن.").assertExists()
        compose.onNodeWithText("۵ سوپرلایک در هفته").assertExists()
        for (link in listOf("بازیابی خرید", "قوانین", "حریم خصوصی")) compose.onNodeWithText(link).assertExists()
        assertTrue("never a Latin comma in a Persian price", compose.onAllNodesWithText(",", substring = true).fetchSemanticsNodes().isEmpty())
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianHeldElsewhereAndTheCurrentPeriod() {
        val (held, e) = onPlus()
        show(ready(e = e).copy(selected = held, current = held, heldElsewhere = true))
        compose.onNodeWithText("اشتراکت روی یه حساب دیگه‌ی ${storeName}ه.").assertExists()
        compose.onNodeWithText("دوباره بررسی کن").assertExists()
        show(ready(e = e).copy(selected = held, current = held))
        compose.onNodeWithText("اشتراک فعلی").assertExists()
        compose.onNodeWithText("مدیریت اشتراک").assertExists()
    }

    @Test
    @Config(qualifiers = "+fa-night")
    fun persianDarkPaywall() {
        show(ready(c = designCatalogue, plan = "premium"), dark = true)
        compose.onNodeWithText("یه اشتراک انتخاب کن").assertIsDisplayed()
        compose.onNodeWithText("ادامه با ۴۵۰٬۰۰۰ تومان").assertIsDisplayed()
    }
}
