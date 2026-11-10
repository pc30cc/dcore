package app.core.feature.paywall

import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.billing.FakeBilling
import app.core.billing.FakeStoreApi
import app.core.billing.KnownPurchases
import app.core.billing.PurchaseOutbox
import app.core.billing.Purchases
import app.core.common.FakeClock
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.PlanKey
import app.core.net.Fetched
import app.core.storage.MemorySecretStore
import app.core.store.ProductType
import app.core.store.Store
import app.core.sync.EntitlementRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The paywall's state from the engine: the period the person is on, and
 * whether the plan is held on another store account, from the store's own
 * list, asked again when the plan's product changes.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class StoreViewModelTest {

    private val main = UnconfinedTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(main)

    @After fun tearDown() = Dispatchers.resetMain()

    private class Rig(store: Store) {
        val billing = FakeBilling(store).apply { products += FakeStoreApi.storeProducts(store) }
        val api = FakeStoreApi(store)
        private val secrets = MemorySecretStore()
        var reads = 0
        val entitlements = EntitlementRepository(fetch = {
            reads++
            Fetched(api.entitlements, true)
        })
        val purchases = Purchases(
            billing = billing,
            api = api,
            outbox = PurchaseOutbox(secrets),
            known = KnownPurchases(secrets),
            entitlements = entitlements,
            account = { "u1" },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            clock = FakeClock(),
        )

        fun paywall(request: PaywallRequest = PaywallRequest.Plans(PaywallEntry.GENERAL)) = StoreViewModel(purchases, entitlements, request)
    }

    private val plusMonthly = Entitlements(plan = "plus", source = EntitlementSource.Play, productId = "sub.plus", basePlanId = "m1")

    @Test
    fun thePeriodThePersonIsOnIsMarkedAndItsTabOpensOnAnother() {
        val r = Rig(Store.PLAY)
        r.api.entitlements = plusMonthly
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        val vm = r.paywall()
        assertEquals("sub.plus:m1", vm.state.value.current)
        assertFalse(vm.state.value.heldElsewhere)
        // Plus holders open on Premium; on the Plus tab the chosen period is not the one held.
        assertEquals("premium", vm.state.value.plan)
        vm.selectPlan("plus")
        assertEquals("sub.plus:m3", vm.state.value.selected)
        assertEquals("the store page names the server's product", "sub.plus", vm.currentProductId())
    }

    @Test
    fun theEntryOpensOnAPlanThatGivesWhatItWasOpenedFor() {
        // In the fakes Plus has no incognito and Premium has: a gate for incognito opens on Premium.
        val r = Rig(Store.PLAY)
        assertEquals("premium", r.paywall(PaywallRequest.Plans(PaywallEntry.INCOGNITO)).state.value.plan)
        assertEquals("both show who likes: the first", "plus", r.paywall(PaywallRequest.Plans(PaywallEntry.SEE_LIKES)).state.value.plan)
        assertEquals("a plan asked for by key", "premium", r.paywall(PaywallRequest.Plans(PaywallEntry.GENERAL, plan = "premium")).state.value.plan)
        assertEquals("a key not sold is not opened", "plus", r.paywall(PaywallRequest.Plans(PaywallEntry.GENERAL, plan = "gold")).state.value.plan)
    }

    @Test
    fun aFailedPurchaseLineGoesWhenAnotherPeriodOrPlanIsChosen() {
        val r = Rig(Store.PLAY)
        val vm = r.paywall()
        r.billing.next = { app.core.store.PurchaseOutcome.Failed(app.core.store.BillingUnavailableReason.ERROR) }
        kotlinx.coroutines.runBlocking {
            r.purchases.buy(org.robolectric.Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java).setup().get(), vm.state.value.catalogue!!, app.core.billing.PurchaseTarget.Subscription(vm.state.value.catalogue!!.defaultOption("plus")!!))
        }
        assertTrue(vm.state.value.step is app.core.billing.PurchaseStep.Failed)
        vm.select("sub.plus:m3")
        assertEquals(app.core.billing.PurchaseStep.Idle, vm.state.value.step)
    }

    @Test
    fun nothingElseCanBeChosenWhileAPurchaseIsUnderWay() {
        val r = Rig(Store.PLAY)
        val vm = r.paywall()
        val plan = vm.state.value.plan!!
        val selected = vm.state.value.selected!!
        val other = vm.state.value.catalogue!!.plan(plan)!!.options.first { it.key != selected }.key
        var during: app.core.billing.PurchaseStep? = null
        r.billing.next = {
            // The store's sheet is open: a tap on another period or plan changes nothing.
            during = r.purchases.step.value
            vm.select(other)
            vm.selectPlan(vm.state.value.plans.first { it != plan })
            app.core.store.PurchaseOutcome.Failed(app.core.store.BillingUnavailableReason.ERROR)
        }
        vm.buy(org.robolectric.Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java).setup().get(), selected)
        assertTrue(during is app.core.billing.PurchaseStep.InStore)
        assertEquals(plan, vm.state.value.plan)
        assertEquals(selected, vm.state.value.selected)
        assertTrue(vm.state.value.step is app.core.billing.PurchaseStep.Failed)
        // Once it stopped, the choice is free again (and the failure's line goes with it).
        vm.select(other)
        assertEquals(other, vm.state.value.selected)
        assertEquals(app.core.billing.PurchaseStep.Idle, vm.state.value.step)
    }

    @Test
    fun aRestoresAnswerStaysOnTheLineUntilSomethingElseIsChosen() {
        val r = Rig(Store.PLAY)
        val vm = r.paywall()
        vm.restore()
        assertFalse(vm.state.value.restoring)
        assertTrue(vm.state.value.restoreNotice != null)
        val other = vm.state.value.catalogue!!.plan(vm.state.value.plan!!)!!.options.first { it.key != vm.state.value.selected }.key
        vm.select(other)
        assertEquals(null, vm.state.value.restoreNotice)
    }

    @Test
    fun aPacksSheetStartsOnItsBestPackAndSwitchesItems() {
        val r = Rig(Store.PLAY)
        val vm = r.paywall(PaywallRequest.Packs(app.core.model.WalletItem.Superlike, PaywallEntry.OUT_OF_SUPERLIKES))
        assertEquals(app.core.model.WalletItem.Superlike, vm.state.value.item)
        assertEquals("cons.superlike.5", vm.state.value.selectedPack)
        vm.selectItem(app.core.model.WalletItem.Boost)
        assertEquals(app.core.model.WalletItem.Boost, vm.state.value.item)
        assertEquals("the fakes sell no boost", null, vm.state.value.selectedPack)
        vm.selectItem(app.core.model.WalletItem.Superlike)
        vm.selectPack("cons.superlike.5")
        assertEquals("cons.superlike.5", vm.state.value.selectedPack)
    }

    @Test
    fun theCatalogueIsReadAgainWhenTheStoreComesBack() {
        val r = Rig(Store.PLAY)
        r.billing.availability = app.core.store.BillingAvailability.Unavailable(app.core.store.BillingUnavailableReason.STORE_NOT_INSTALLED)
        val vm = r.paywall()
        assertTrue(vm.state.value.load is StoreLoad.Unavailable)
        // Back from installing it.
        r.billing.availability = app.core.store.BillingAvailability.Ready
        vm.resumed()
        assertTrue(vm.state.value.load is StoreLoad.Ready)
    }

    @Test
    fun aPlanHeldOnAnotherStoreAccountIsReadFromTheStoresList() {
        val r = Rig(Store.PLAY)
        r.api.entitlements = plusMonthly
        val vm = r.paywall()
        assertTrue("this store account holds nothing of it", vm.state.value.heldElsewhere)

        // A packs sheet does not ask: it sells packs whatever the store account holds.
        val before = r.billing.ownedQueries
        val packs = r.paywall(PaywallRequest.Packs(app.core.model.WalletItem.Superlike, PaywallEntry.OUT_OF_SUPERLIKES))
        assertFalse(packs.state.value.heldElsewhere)
        assertEquals(before, r.billing.ownedQueries)
    }

    @Test
    fun aStoreTheServerCannotVerifyIsAnEmptyCatalogueNotAFailure() {
        for (store in listOf(Store.PLAY, Store.BAZAAR)) {
            val r = Rig(store)
            // The server's answer for a store it has no credentials for: the usual shape, no product.
            r.api.catalogue = app.core.model.StoreProducts(r.api.catalogue.store, FakeStoreApi.BILLING_REF)
            r.api.entitlements = plusMonthly
            val vm = r.paywall()
            val load = vm.state.value.load
            assertTrue("$store: $load", load is StoreLoad.Ready && load.catalogue.isEmpty)
            assertEquals("$store: nothing to compare with the store's list", 0, r.billing.ownedQueries)
            assertFalse(vm.state.value.heldElsewhere)
        }
    }

    @Test
    fun theStoresListIsAskedAgainWhenThePlansProductChanges() {
        val r = Rig(Store.PLAY)
        val vm = r.paywall()
        assertFalse("free: nothing held anywhere", vm.state.value.heldElsewhere)
        val asked = r.billing.ownedQueries

        // Bought on this phone while the paywall is open: the new token is in the store's list by now.
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        r.entitlements.apply(plusMonthly)
        main.scheduler.advanceUntilIdle()
        assertEquals(asked + 1, r.billing.ownedQueries)
        assertFalse(vm.state.value.heldElsewhere)
        assertEquals("sub.plus:m1", vm.state.value.current)

        // A wallet change is not a plan change: no new question to the store.
        r.entitlements.apply(plusMonthly.copy(wallet = app.core.model.Wallet(superlike = 3)))
        main.scheduler.advanceUntilIdle()
        assertEquals(asked + 1, r.billing.ownedQueries)

        // Changed on another phone, to a product this store account does not hold.
        r.entitlements.apply(plusMonthly.copy(plan = "premium", productId = "sub.premium"))
        main.scheduler.advanceUntilIdle()
        assertEquals(asked + 2, r.billing.ownedQueries)
        assertTrue(vm.state.value.heldElsewhere)
    }

    /**
     * The plan ended while the app was in the background (its `entitlement`
     * event outlived the realtime history): the copy in memory still says
     * Plus, the store no longer lists it. Opening the paywall reads the
     * entitlements again, so nothing is marked as held or held elsewhere.
     */
    @Test
    fun aPlanThatEndedWhileTheAppWasAwayIsReadAgainWhenThePaywallOpens() {
        val r = Rig(Store.PLAY)
        r.api.entitlements = plusMonthly.copy(autoRenew = false)
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        kotlinx.coroutines.runBlocking { r.entitlements.ensure() }
        assertEquals(1, r.reads)

        r.api.entitlements = Entitlements()
        r.billing.owned.clear()
        val vm = r.paywall()
        assertEquals("read again on opening", 2, r.reads)
        assertEquals(PlanKey.FREE, vm.state.value.entitlements?.plan)
        assertFalse(vm.state.value.heldElsewhere)
        assertEquals(null, vm.state.value.current)
        assertEquals("the Plus tab opens on its popular period", "plus", vm.state.value.plan)
        assertEquals("sub.plus:m1", vm.state.value.selected)
    }

    /**
     * The store's list behind "held elsewhere" is asked again when the
     * paywall comes back to the front, on "Check again" and after a restore:
     * Play answers from a cache that can lag behind a purchase made on
     * another device.
     */
    @Test
    fun heldElsewhereIsAskedAgainOnResumeCheckAgainAndRestore() {
        val r = Rig(Store.PLAY)
        r.api.entitlements = plusMonthly
        val vm = r.paywall()
        assertTrue(vm.state.value.heldElsewhere)

        // The store caught up while the person was in another app.
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        vm.resumed()
        assertFalse(vm.state.value.heldElsewhere)

        r.billing.owned.clear()
        val asked = r.billing.ownedQueries
        val reads = r.reads
        vm.checkAgain()
        assertTrue(vm.state.value.heldElsewhere)
        assertFalse(vm.state.value.checking)
        assertEquals("the entitlements too", reads + 1, r.reads)
        assertEquals(asked + 1, r.billing.ownedQueries)

        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        vm.restore()
        assertFalse("the list the restore read decides", vm.state.value.heldElsewhere)

        // Free: nothing to say about another account, so a resume asks the store nothing.
        val free = Rig(Store.PLAY)
        val fvm = free.paywall()
        val before = free.billing.ownedQueries
        fvm.resumed()
        assertEquals(before, free.billing.ownedQueries)
    }

    /**
     * Cafe Bazaar can list nothing for the very account that holds the plan
     * (after a sign-in to Bazaar): the paywall keeps its usual lock note and
     * does not say the plan is on another Bazaar account.
     */
    @Test
    fun anEmptyBazaarListKeepsTheLockNotAnotherAccount() {
        val r = Rig(Store.BAZAAR)
        r.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Bazaar, productId = "sub.plus.1m")
        val vm = r.paywall()
        assertFalse(vm.state.value.heldElsewhere)
        assertTrue(vm.state.value.subscriptionLocked)
        assertEquals("sub.plus.1m", vm.state.value.current)

        // Another reference's token of the plan's product is on this Bazaar account: then it is said.
        r.billing.owned += r.billing.purchase("sub.plus.1m", "tok-theirs", accountRef = "otheraccount2") to ProductType.SUBSCRIPTION
        vm.resumed()
        assertTrue(vm.state.value.heldElsewhere)
    }
}
