package app.core.billing

import androidx.activity.ComponentActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.FakeClock
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.PlanKey
import app.core.model.PurchaseKind
import app.core.net.ApiError
import app.core.net.Fetched
import app.core.storage.MemorySecretStore
import app.core.store.BillingAvailability
import app.core.store.BillingUnavailableReason
import app.core.store.ConsumeOutcome
import app.core.store.PlanChangeKind
import app.core.store.ProductType
import app.core.store.PurchaseOutcome
import app.core.store.Store
import app.core.store.StorePurchaseState
import app.core.sync.EntitlementRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric

/**
 * The purchase state machine against a scripted store and server: every
 * state of a purchase, the queue that survives a lost network and a killed
 * process, restore, plan changes and boosts. Nothing is ever granted on the
 * phone: what the tests check as granted is what the fake server answered.
 */
@RunWith(AndroidJUnit4::class)
class PurchasesTest {

    private val activity: ComponentActivity by lazy { Robolectric.buildActivity(ComponentActivity::class.java).setup().get() }

    private class Rig(val store: Store, scope: CoroutineScope, secrets: MemorySecretStore = MemorySecretStore(), val clock: FakeClock = FakeClock()) {
        val billing = FakeBilling(store).apply { products += FakeStoreApi.storeProducts(store) }
        val api = FakeStoreApi(store)
        val account = MutableStateFlow<String?>("u1")
        var backgroundRetries = 0
        var entitlementReads = 0

        /** `GET /v1/me/entitlements` gets no answer (no network) while true. */
        var entitlementsDown = false
        val entitlements = EntitlementRepository(fetch = {
            entitlementReads++
            if (entitlementsDown) throw ApiError.Network(java.io.IOException("offline"))
            Fetched(api.entitlements, true)
        })
        val outbox = PurchaseOutbox(secrets)
        val known = KnownPurchases(secrets)
        val purchases = Purchases(
            billing = billing,
            api = api,
            outbox = outbox,
            known = known,
            entitlements = entitlements,
            account = { account.value },
            scope = scope,
            clock = clock,
            retryInBackground = { backgroundRetries++ },
        )

        suspend fun catalogue(): Catalogue = (purchases.catalogue() as CatalogueLoad.Ready).catalogue
    }

    private fun TestScope.rig(store: Store = Store.PLAY) = Rig(store, backgroundScope)

    @Test
    fun aPurchaseGoesToTheServerWithTheBillingRefAndOnlyItsAnswerGrants() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        val option = catalogue.option("sub.plus:m1")!!
        val end = r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(option))

        assertEquals(PurchaseStep.Done("sub.plus:m1", PurchaseKind.Subscription), end)
        assertEquals(listOf("sub.plus" to "k7wq2m4zx5p3a"), r.billing.sheets)
        assertEquals(listOf("tok-sub.plus"), r.api.submitted)
        assertEquals("plus", r.entitlements.entitlements.value?.plan)
        assertTrue("nothing left waiting", r.outbox.all().isEmpty())
        assertEquals("active", r.known.state("tok-sub.plus"))
        assertEquals(0, r.purchases.waiting.value)
    }

    @Test
    fun cancellingInTheStoreSendsNothing() = runTest {
        val r = rig()
        r.billing.next = { PurchaseOutcome.Cancelled }
        val catalogue = r.catalogue()
        assertEquals(PurchaseStep.Idle, r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!)))
        assertTrue(r.api.submitted.isEmpty())
        assertEquals(PlanKey.FREE, r.entitlements.entitlements.value?.plan ?: PlanKey.FREE)
    }

    @Test
    fun aMissingStoreAppIsSaidBeforeAnySheet() = runTest {
        val r = rig(Store.BAZAAR)
        r.billing.availability = BillingAvailability.Unavailable(BillingUnavailableReason.STORE_NOT_INSTALLED)
        assertEquals(CatalogueLoad.StoreUnavailable(BillingUnavailableReason.STORE_NOT_INSTALLED), r.purchases.catalogue())
        assertEquals("the server's catalogue first: it has something to sell here", 1, r.api.productsCalls)

        r.billing.availability = BillingAvailability.Ready
        val catalogue = r.catalogue()
        r.billing.availability = BillingAvailability.Unavailable(BillingUnavailableReason.STORE_NOT_INSTALLED)
        val end = r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus.1m")!!))
        assertEquals(PurchaseStep.Failed("sub.plus.1m", PurchaseFailure.STORE_MISSING), end)
        assertTrue(r.billing.sheets.isEmpty())
    }

    @Test
    fun aPendingPaymentGrantsNothingUntilTheStoreSaysItIsPaid() = runTest {
        val r = rig()
        r.purchases.start(MutableStateFlow(true))
        runCurrent()
        r.billing.next = { p -> PurchaseOutcome.Pending(r.billing.purchase(p.id, "tok-pending", StorePurchaseState.PENDING)) }
        r.api.verdicts["tok-pending"] = "pending"
        val catalogue = r.catalogue()
        val end = r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m3")!!))

        assertEquals(PurchaseStep.Pending("sub.plus:m3"), end)
        assertEquals("nothing granted", PlanKey.FREE, r.entitlements.entitlements.value?.plan ?: PlanKey.FREE)
        assertEquals(KnownPurchases.PENDING, r.known.state("tok-pending"))

        // The cash is paid: Play reports the purchase outside the flow; it goes to the server once.
        r.api.verdicts["tok-pending"] = "active"
        r.billing.updates.emit(r.billing.purchase("sub.plus", "tok-pending"))
        runCurrent()
        assertEquals(listOf("tok-pending", "tok-pending"), r.api.submitted)
        assertEquals("plus", r.entitlements.entitlements.value?.plan)
        assertEquals("the paywall's pending step finishes", PurchaseStep.Done("sub.plus:m3", PurchaseKind.Subscription), r.purchases.step.value)
    }

    @Test
    fun aPurchaseTheServerNeverHeardOfIsQueuedRetriedAndGrantedOnce() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        r.api.offline = true
        val end = r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!))

        assertEquals(PurchaseStep.Queued("sub.plus:m1"), end)
        assertEquals(1, r.outbox.all().size)
        assertEquals(1, r.purchases.waiting.value)
        assertEquals("a background job with a network constraint was asked for", 1, r.backgroundRetries)
        assertEquals(PlanKey.FREE, r.entitlements.entitlements.value?.plan ?: PlanKey.FREE)

        // Still offline at the next try: it stays, with a longer wait.
        r.clock.advance(Purchases.backoff(0))
        assertEquals(1, r.purchases.flush())
        assertEquals(2, r.outbox.all().single().attempts)

        // The network is back.
        r.api.offline = false
        assertEquals(0, r.purchases.flushNow())
        assertEquals("plus", r.entitlements.entitlements.value?.plan)
        assertEquals("the queued step completes", PurchaseStep.Done("sub.plus:m1", PurchaseKind.Subscription), r.purchases.step.value)
        assertEquals("credited once", 1, r.api.granted.size)

        // Nothing left: another flush asks nothing.
        val before = r.api.submitted.size
        r.purchases.flushNow()
        assertEquals(before, r.api.submitted.size)
    }

    @Test
    fun theQueueOutlivesTheProcess() = runTest {
        val secrets = MemorySecretStore()
        val first = Rig(Store.PLAY, backgroundScope, secrets)
        val catalogue = first.catalogue()
        first.api.offline = true
        first.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!))
        assertEquals(1, first.outbox.all().size)
        assertFalse("the token is sealed, not plain", secrets.storedSecrets.isEmpty())

        // A new process: the same phone storage, a server that answers.
        val second = Rig(Store.PLAY, backgroundScope, secrets)
        assertEquals(0, second.purchases.flushNow())
        assertEquals(listOf("tok-sub.plus"), second.api.submitted)
        assertEquals("plus", second.entitlements.entitlements.value?.plan)
    }

    @Test
    fun aQueuedPurchaseIsSentOnlyForTheAccountThatBoughtIt() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        r.api.offline = true
        r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!))
        r.api.offline = false
        r.account.value = "u2"
        r.purchases.flushNow()
        assertEquals(listOf("tok-sub.plus"), r.api.submitted)
        r.account.value = "u1"
        r.purchases.flushNow()
        assertEquals(listOf("tok-sub.plus", "tok-sub.plus"), r.api.submitted)
        assertTrue(r.outbox.all().isEmpty())
    }

    @Test
    fun theStoresCheckBeingDownQueuesItToo() = runTest {
        val r = rig()
        r.api.verdicts["tok-sub.plus"] = "store_unavailable"
        val catalogue = r.catalogue()
        assertEquals(PurchaseStep.Queued("sub.plus:m1"), r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!)))
        assertEquals(1, r.outbox.all().size)

        // An app too old for the server, or a route not there yet, is no verdict on the purchase: kept too.
        r.api.verdicts["tok-sub.premium"] = "upgrade_required"
        assertEquals(PurchaseStep.Queued("sub.premium:m1"), r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.premium:m1")!!)))
        r.api.verdicts["tok-cons.superlike.5"] = "not_found"
        assertEquals(PurchaseStep.Queued("cons.superlike.5"), r.purchases.buy(activity, catalogue, PurchaseTarget.Pack(catalogue.pack("cons.superlike.5")!!)))
        assertEquals(3, r.outbox.all().size)
        assertEquals(PlanKey.FREE, r.entitlements.entitlements.value?.plan ?: PlanKey.FREE)
    }

    @Test
    fun anotherAccountsPurchaseAndAnUnconfirmedOneAreSaidAndNotRetried() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        r.api.verdicts["tok-sub.plus"] = "other_account"
        assertEquals(
            PurchaseStep.Failed("sub.plus:m1", PurchaseFailure.OTHER_ACCOUNT),
            r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!)),
        )
        r.api.verdicts["tok-sub.premium"] = "invalid"
        assertEquals(
            PurchaseStep.Failed("sub.premium:m1", PurchaseFailure.INVALID),
            r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.premium:m1")!!)),
        )
        assertTrue(r.outbox.all().isEmpty())
        assertFalse(r.known.needsSending("tok-sub.plus", StorePurchaseState.PURCHASED))
        assertEquals(PlanKey.FREE, r.entitlements.entitlements.value?.plan ?: PlanKey.FREE)
    }

    @Test
    fun alreadyOwnedRestoresInsteadOfChargingAgain() = runTest {
        val r = rig()
        r.billing.owned += r.billing.purchase("sub.plus", "tok-old") to ProductType.SUBSCRIPTION
        r.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        val catalogue = r.catalogue()
        val end = r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!))
        assertEquals(PurchaseStep.Done("sub.plus:m1", PurchaseKind.Subscription), end)
        assertEquals(listOf(listOf("tok-old")), r.api.restored)
        assertTrue(r.api.submitted.isEmpty())
    }

    @Test
    fun aBazaarPackIsConsumedInTheStoreOnlyAfterTheServerCreditedIt() = runTest {
        val r = rig(Store.BAZAAR)
        val catalogue = r.catalogue()
        val pack = PurchaseTarget.Pack(catalogue.pack("cons.superlike.5")!!)
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-cons.superlike.5") to ProductType.ONE_TIME

        r.api.offline = true
        assertEquals(PurchaseStep.Queued("cons.superlike.5"), r.purchases.buy(activity, catalogue, pack))
        assertTrue("not consumed while the server has not credited it", r.billing.consumed.isEmpty())

        // Credited, but Bazaar fails the consume: credited once, consumed on the next try.
        r.api.offline = false
        r.billing.consumeAnswer = { ConsumeOutcome.Failed("busy") }
        r.purchases.flushNow()
        assertEquals(5, r.entitlements.entitlements.value?.wallet?.superlike)
        assertEquals(OutboxStage.CONSUME, r.outbox.all().single().stage)
        r.billing.consumeAnswer = { ConsumeOutcome.Consumed }
        r.purchases.flushNow()
        assertEquals(listOf("tok-cons.superlike.5"), r.billing.consumed)
        assertTrue(r.outbox.all().isEmpty())
        assertEquals("one credit, whatever the retries", 1, r.api.granted.size)
        assertEquals(5, r.entitlements.entitlements.value?.wallet?.superlike)
    }

    @Test
    fun aRestoreAtLaunchSendsOnlyWhatTheServerDoesNotKnowAndAtMostTwenty() = runTest {
        val r = rig()
        repeat(25) { i -> r.billing.owned += r.billing.purchase("sub.plus", "tok-$i") to ProductType.SUBSCRIPTION }
        r.known.put("tok-0", "active")

        assertTrue(r.purchases.restore(manual = false) is RestoreOutcome.Done)
        assertEquals(1, r.api.restored.size)
        assertEquals("one request of at most 20, the known one left out", 20, r.api.restored.single().size)
        assertFalse("tok-0" in r.api.restored.single())

        // The next launch sends the rest; the one after sends nothing at all.
        r.purchases.restore(manual = false)
        assertEquals(4, r.api.restored[1].size)
        assertEquals(RestoreOutcome.NothingToRestore, r.purchases.restore(manual = false))
        assertEquals("no request when everything is known", 2, r.api.restored.size)
    }

    @Test
    fun theRestoreButtonSendsEveryOwnedTokenAndNeverTakesAnythingAway() = runTest {
        val r = rig()
        r.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Play)
        r.entitlements.apply(r.api.entitlements)
        // The store's list came back empty (it happens): nothing is sent, nothing removed; the server is read again.
        assertEquals(RestoreOutcome.NothingToRestore, r.purchases.restore(manual = true))
        assertTrue(r.api.restored.isEmpty())
        assertEquals("plus", r.entitlements.entitlements.value?.plan)

        r.billing.owned += r.billing.purchase("sub.plus", "tok-a") to ProductType.SUBSCRIPTION
        r.known.put("tok-a", "active")
        val done = r.purchases.restore(manual = true) as RestoreOutcome.Done
        assertEquals("a known token is sent again from the button", listOf(listOf("tok-a")), r.api.restored)
        assertEquals(setOf("sub.plus"), done.granted)
    }

    @Test
    fun aRestoreOfAnotherAccountsTokenIsCountedAndRemembered() = runTest {
        val r = rig()
        r.billing.owned += r.billing.purchase("sub.plus", "tok-b") to ProductType.SUBSCRIPTION
        r.api.verdicts["tok-b"] = "other_account"
        val done = r.purchases.restore(manual = false) as RestoreOutcome.Done
        assertEquals(1, done.foreign)
        assertEquals(RestoreOutcome.NothingToRestore, r.purchases.restore(manual = false))
    }

    @Test
    fun anUpgradeOnPlayReplacesTheOwnedSubscriptionAndBazaarSellsNoSecondOne() = runTest {
        val play = rig()
        play.entitlements.apply(Entitlements(plan = "plus", source = EntitlementSource.Play))
        play.billing.owned += play.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        val catalogue = play.catalogue()
        play.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.premium:m1")!!))
        val change = play.billing.changes.single()!!
        assertEquals("tok-plus", change.oldPurchaseToken)
        assertEquals("Premium a month costs more per day than any Plus base plan", PlanChangeKind.CHARGE_DIFFERENCE, change.kind)

        assertFalse(play.purchases.subscriptionLocked(play.entitlements.entitlements.value))

        val bazaar = rig(Store.BAZAAR)
        bazaar.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Bazaar)
        bazaar.entitlements.apply(bazaar.api.entitlements)
        assertTrue(bazaar.purchases.subscriptionLocked(bazaar.entitlements.entitlements.value))
        val bc = bazaar.catalogue()
        assertEquals(
            PurchaseStep.Failed("sub.premium.1m", PurchaseFailure.CHANGE_NOT_SUPPORTED),
            bazaar.purchases.buy(activity, bc, PurchaseTarget.Subscription(bc.option("sub.premium.1m")!!)),
        )
        assertTrue(bazaar.billing.sheets.isEmpty())

        // A plan given by the admin panel is not a store subscription: buying one is a plain purchase.
        val granted = rig(Store.BAZAAR)
        granted.entitlements.apply(Entitlements(plan = "plus", source = EntitlementSource.Grant))
        assertFalse(granted.purchases.subscriptionLocked(granted.entitlements.entitlements.value))
        val gc = granted.catalogue()
        granted.purchases.buy(activity, gc, PurchaseTarget.Subscription(gc.option("sub.premium.1m")!!))
        assertEquals(1, granted.billing.sheets.size)
    }

    @Test
    fun aBoostShowsItsEndAtOnceAndNoneLeftSaysWhetherPacksAreSold() = runTest {
        val r = rig()
        r.entitlements.apply(Entitlements())
        val started = r.purchases.boost(app.core.model.BoostKind.Boost) as BoostOutcome.Started
        assertEquals(started.endsAt, r.entitlements.entitlements.value?.boostEndsAt)

        r.api.boostAnswer = { throw ApiError.Http(429, app.core.model.Problem.of(429, "quota_exceeded", "feature" to "boosts", "canBuy" to true)) }
        assertEquals(BoostOutcome.NoneLeft(canBuy = true), r.purchases.boost(app.core.model.BoostKind.Boost))
        r.api.offline = true
        assertEquals(BoostOutcome.Offline, r.purchases.boost(app.core.model.BoostKind.Boost))
    }

    @Test
    fun theOutboxKeepsOneEntryPerTokenAndAPaidPendingOneJumpsTheQueue() = runTest {
        val outbox = PurchaseOutbox(MemorySecretStore())
        val billing = FakeBilling(Store.PLAY)
        val pending = QueuedPurchase.of("u1", billing.purchase("sub.plus", "t1", StorePurchaseState.PENDING), "sub.plus", PurchaseKind.Subscription, 1)
        outbox.add(pending)
        outbox.update(outbox.all().single().copy(attempts = 3, nextAt = 99_999))
        outbox.add(QueuedPurchase.of("u1", billing.purchase("sub.plus", "t1"), "sub.plus", PurchaseKind.Subscription, 2))
        val entry = outbox.all().single()
        assertFalse(entry.pending)
        assertEquals(0, entry.nextAt)
        assertFalse("a token is never logged whole", entry.toString().contains("t1,"))
    }

    /** A key store that cannot seal: what it is asked to keep is lost, as on a phone with a broken Keystore. */
    private class UnsealingStore : app.core.storage.SecretStore {
        private val plain = MemorySecretStore()
        override suspend fun readSecret(name: String): String? = null
        override suspend fun writeSecret(name: String, value: String?) = Unit
        override suspend fun read(name: String) = plain.read(name)
        override suspend fun write(name: String, value: String) = plain.write(name, value)
        override suspend fun remove(name: String) = plain.remove(name)
    }

    @Test
    fun aKeyStoreThatCannotSealNeverTurnsAPurchaseIntoAFalseSuccess() = runTest {
        val r = Rig(Store.PLAY, backgroundScope, secrets = MemorySecretStore())
        val broken = Purchases(
            billing = r.billing,
            api = r.api,
            outbox = PurchaseOutbox(UnsealingStore()),
            known = KnownPurchases(UnsealingStore()),
            entitlements = r.entitlements,
            account = { "u1" },
            scope = backgroundScope,
            clock = r.clock,
        )
        val catalogue = (broken.catalogue() as CatalogueLoad.Ready).catalogue
        r.api.offline = true
        assertEquals(PurchaseStep.Queued("sub.plus:m1"), broken.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!)))
        // Kept in memory for this process: sent once the network is back.
        r.api.offline = false
        assertEquals(0, broken.flushNow())
        assertEquals(listOf("tok-sub.plus", "tok-sub.plus"), r.api.submitted)
        assertEquals("plus", r.entitlements.entitlements.value?.plan)
    }

    @Test
    fun aStepDismissedWhileTheServerIsAskedDoesNotComeBack() = runTest {
        val r = rig()
        r.billing.next = { p -> PurchaseOutcome.Pending(r.billing.purchase(p.id, "tok-cash", StorePurchaseState.PENDING)) }
        r.api.verdicts["tok-cash"] = "pending"
        // The person closes "payment pending" before the server has answered.
        r.api.onSubmit = { r.purchases.acknowledge() }
        val catalogue = r.catalogue()
        r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!))
        assertEquals(PurchaseStep.Idle, r.purchases.step.value)
        assertEquals("the answer still landed", KnownPurchases.PENDING, r.known.state("tok-cash"))
    }

    // MARK: - Plan changes, restore states, packs already owned

    @Test
    fun aPlanChangeReplacesOnlyThisAccountsSubscriptionOfItsCurrentPlan() = runTest {
        val r = rig()
        r.entitlements.apply(Entitlements(plan = "premium", source = EntitlementSource.Play))
        // One phone, one Google account, two accounts of the app: A's Plus, this account's own
        // cancelled Plus that has not ended yet (bought later), and this account's Premium.
        r.billing.owned += r.billing.purchase("sub.plus", "tok-a-plus", accountRef = "otheraccount2") to ProductType.SUBSCRIPTION
        r.billing.owned += r.billing.purchase("sub.plus", "tok-own-plus", purchaseTimeMillis = 9_000) to ProductType.SUBSCRIPTION
        r.billing.owned += r.billing.purchase("sub.premium", "tok-own-premium") to ProductType.SUBSCRIPTION
        val catalogue = r.catalogue()
        r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m3")!!))
        val change = r.billing.changes.single()!!
        assertEquals("the token behind this account's Premium, never A's or the cancelled Plus", "tok-own-premium", change.oldPurchaseToken)
        assertEquals(PlanChangeKind.AT_RENEWAL, change.kind)
    }

    @Test
    fun noSubscriptionOfThisAccountsPlanOnTheStoreAccountReplacesNothing() = runTest {
        val r = rig()
        r.entitlements.apply(Entitlements(plan = "plus", source = EntitlementSource.Play))
        // Only another account's Plus, and this account's own Premium on hold: neither backs this Plus.
        r.billing.owned += r.billing.purchase("sub.plus", "tok-a-plus", accountRef = "otheraccount2") to ProductType.SUBSCRIPTION
        r.billing.owned += r.billing.purchase("sub.plus", "tok-no-ref", accountRef = null) to ProductType.SUBSCRIPTION
        r.billing.owned += r.billing.purchase("sub.premium", "tok-held", suspended = true) to ProductType.SUBSCRIPTION
        val catalogue = r.catalogue()
        r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.premium:m1")!!))
        assertEquals(listOf<app.core.store.PlanChange?>(null), r.billing.changes)
    }

    @Test
    fun anotherPeriodOfTheSamePlanIsChargedInFullNotProrated() = runTest {
        val r = rig()
        r.entitlements.apply(Entitlements(plan = "plus", source = EntitlementSource.Play))
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        val catalogue = r.catalogue()
        r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m3")!!))
        assertEquals(app.core.store.PlanChange("tok-plus", PlanChangeKind.CHARGE_FULL), r.billing.changes.single())
    }

    @Test
    fun aRestoreGrantsOnlyStatesThatGiveAccessAndCountsTheRest() = runTest {
        val r = rig()
        for (token in listOf("tok-hold", "tok-expired", "tok-foreign", "tok-later", "tok-cash")) {
            r.billing.owned += r.billing.purchase("sub.plus", token) to ProductType.SUBSCRIPTION
        }
        r.api.verdicts += mapOf(
            "tok-hold" to "on_hold",
            "tok-expired" to "expired",
            "tok-foreign" to "other_account",
            "tok-later" to "unavailable",
            "tok-cash" to "pending",
        )
        val done = r.purchases.restore(manual = true) as RestoreOutcome.Done
        assertEquals("nothing that gives access", emptySet<String>(), done.granted)
        assertEquals(1, done.foreign)
        assertEquals(2, done.later)
        assertEquals(2, done.inactive)
        assertEquals(PlanKey.FREE, r.entitlements.entitlements.value?.plan ?: PlanKey.FREE)

        r.api.verdicts["tok-hold"] = "grace"
        val grace = r.purchases.restore(manual = true) as RestoreOutcome.Done
        assertEquals("grace keeps access", setOf("sub.plus"), grace.granted)
    }

    @Test
    fun aVerifiedPurchaseInAStateThatGivesNothingIsNotDone() = runTest {
        val r = rig()
        r.api.verdicts["tok-sub.plus"] = "on_hold"
        val catalogue = r.catalogue()
        val end = r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!))
        assertEquals(PurchaseStep.Failed("sub.plus:m1", PurchaseFailure.NOT_ACTIVE), end)
        assertEquals(PlanKey.FREE, r.entitlements.entitlements.value?.plan ?: PlanKey.FREE)
        assertTrue("settled, not retried", r.outbox.all().isEmpty())
        assertEquals("on_hold", r.known.state("tok-sub.plus"))
    }

    @Test
    fun aPackTheServerCreditedBeforeIsNotAddedAgainWhenTheStoreStillHoldsIt() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        val pack = PurchaseTarget.Pack(catalogue.pack("cons.superlike.5")!!)
        r.api.verdicts["tok-cons.superlike.5"] = "purchased"
        assertEquals(PurchaseStep.Done("cons.superlike.5", PurchaseKind.Consumable), r.purchases.buy(activity, catalogue, pack))
        assertEquals(5, r.entitlements.entitlements.value?.wallet?.superlike)
        // Play keeps it owned until the server's consume reaches Google; a second tap is "already owned".
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-cons.superlike.5") to ProductType.ONE_TIME
        r.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        assertEquals(PurchaseStep.Failed("cons.superlike.5", PurchaseFailure.STILL_COMPLETING), r.purchases.buy(activity, catalogue, pack))
        assertEquals("nothing added", 5, r.entitlements.entitlements.value?.wallet?.superlike)
        assertEquals(1, r.api.granted.size)
    }

    @Test
    fun aPackThisRestoreCreditsIsDoneAndAnotherAccountsIsSaid() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        val pack = PurchaseTarget.Pack(catalogue.pack("cons.superlike.5")!!)
        r.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        // Paid earlier, never answered by the server (no record on this phone): this restore credits it.
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-lost") to ProductType.ONE_TIME
        assertEquals(PurchaseStep.Done("cons.superlike.5", PurchaseKind.Consumable), r.purchases.buy(activity, catalogue, pack))
        assertEquals(5, r.entitlements.entitlements.value?.wallet?.superlike)

        val other = rig()
        val oc = other.catalogue()
        other.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        other.billing.owned += other.billing.purchase("sub.plus", "tok-theirs", accountRef = "otheraccount2") to ProductType.SUBSCRIPTION
        other.api.verdicts["tok-theirs"] = "other_account"
        assertEquals(
            PurchaseStep.Failed("sub.plus:m1", PurchaseFailure.OTHER_ACCOUNT),
            other.purchases.buy(activity, oc, PurchaseTarget.Subscription(oc.option("sub.plus:m1")!!)),
        )
    }

    // MARK: - The plan's product, a plan on another store account, `fresh`

    @Test
    fun theBasePlanThePersonIsOnIsTheBarOfAnUpgrade() = runTest {
        val r = rig()
        // Plus is also sold weekly, dearer per day than Premium monthly.
        r.api.catalogue = r.api.catalogue.copy(
            subscriptions = r.api.catalogue.subscriptions + app.core.model.SubscriptionProduct("sub.plus", "w1", "plus", app.core.model.BillingPeriod.Week, null, 10),
        )
        r.billing.products += app.core.store.StoreProduct("sub.plus", ProductType.SUBSCRIPTION, "Plus", "", "€2.99", 2_990_000, "EUR", offerToken = "o-w1", basePlanId = "w1", billingPeriod = "P1W")
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        r.billing.next = { PurchaseOutcome.Cancelled }
        val catalogue = r.catalogue()
        val premium = PurchaseTarget.Subscription(catalogue.option("sub.premium:m1")!!)

        // The server says monthly Plus: Premium monthly costs more per day than that, so the difference is charged now.
        r.entitlements.apply(Entitlements(plan = "plus", source = EntitlementSource.Play, productId = "sub.plus", basePlanId = "m1"))
        r.purchases.buy(activity, catalogue, premium)
        assertEquals(app.core.store.PlanChange("tok-plus", PlanChangeKind.CHARGE_DIFFERENCE), r.billing.changes.last())

        // A server that does not name it: the dearest Plus base plan (weekly) is the bar, and the time left is credited.
        r.entitlements.apply(Entitlements(plan = "plus", source = EntitlementSource.Play))
        r.purchases.buy(activity, catalogue, premium)
        assertEquals(app.core.store.PlanChange("tok-plus", PlanChangeKind.CREDIT_TIME), r.billing.changes.last())
    }

    @Test
    fun thePeriodThePersonIsOnIsNotSoldAgain() = runTest {
        val play = rig()
        play.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Play, productId = "sub.plus", basePlanId = "m1")
        play.entitlements.apply(play.api.entitlements)
        play.billing.owned += play.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        val pc = play.catalogue()
        assertEquals(PurchaseStep.Failed("sub.plus:m1", PurchaseFailure.ALREADY_CURRENT), play.purchases.buy(activity, pc, PurchaseTarget.Subscription(pc.option("sub.plus:m1")!!)))
        assertTrue("no sheet opened", play.billing.sheets.isEmpty())
        // Another period of the same plan is a change of the one held.
        play.purchases.buy(activity, pc, PurchaseTarget.Subscription(pc.option("sub.plus:m3")!!))
        assertEquals(app.core.store.PlanChange("tok-plus", PlanChangeKind.CHARGE_FULL), play.billing.changes.single())

        val bazaar = rig(Store.BAZAAR)
        bazaar.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Bazaar, productId = "sub.plus.1m")
        bazaar.entitlements.apply(bazaar.api.entitlements)
        bazaar.billing.owned += bazaar.billing.purchase("sub.plus.1m", "tok-plus") to ProductType.SUBSCRIPTION
        val bc = bazaar.catalogue()
        assertEquals(PurchaseStep.Failed("sub.plus.1m", PurchaseFailure.ALREADY_CURRENT), bazaar.purchases.buy(activity, bc, PurchaseTarget.Subscription(bc.option("sub.plus.1m")!!)))
        assertEquals(
            PurchaseStep.Failed("sub.premium.1m", PurchaseFailure.CHANGE_NOT_SUPPORTED),
            bazaar.purchases.buy(activity, bc, PurchaseTarget.Subscription(bc.option("sub.premium.1m")!!)),
        )
        assertTrue(bazaar.billing.sheets.isEmpty())
    }

    @Test
    fun aPlanHeldOnAnotherStoreAccountSellsNoSecondSubscriptionButPacksStill() = runTest {
        for (store in listOf(Store.PLAY, Store.BAZAAR)) {
            val r = rig(store)
            val product = if (store == Store.PLAY) "sub.plus" else "sub.plus.1m"
            val source = if (store == Store.PLAY) EntitlementSource.Play else EntitlementSource.Bazaar
            r.api.entitlements = Entitlements(plan = "plus", source = source, productId = product, basePlanId = "m1".takeIf { store == Store.PLAY })
            r.entitlements.apply(r.api.entitlements)
            // The store account on this phone holds only another account's Plus.
            r.billing.owned += r.billing.purchase(product, "tok-theirs", accountRef = "otheraccount2") to ProductType.SUBSCRIPTION
            val catalogue = r.catalogue()
            val premium = catalogue.plan("premium")!!.options.first()
            assertTrue(r.purchases.heldElsewhere(r.entitlements.entitlements.value, r.purchases.ownedSubscriptions(), catalogue.billingRef))
            assertEquals(
                "$store: no second subscription",
                PurchaseStep.Failed(premium.key, PurchaseFailure.MANAGED_ELSEWHERE),
                r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(premium)),
            )
            assertTrue(r.billing.sheets.isEmpty())
            assertEquals(
                "$store: packs are still sold",
                PurchaseStep.Done("cons.superlike.5", PurchaseKind.Consumable),
                r.purchases.buy(activity, catalogue, PurchaseTarget.Pack(catalogue.pack("cons.superlike.5")!!)),
            )
            assertEquals(listOf("cons.superlike.5"), r.billing.sheets.map { it.first })
        }

        // A server that names no product: as before, nothing is known to be elsewhere (Play sells a plain one).
        val older = rig()
        older.entitlements.apply(Entitlements(plan = "plus", source = EntitlementSource.Play))
        val oc = older.catalogue()
        assertFalse(older.purchases.heldElsewhere(older.entitlements.entitlements.value, older.purchases.ownedSubscriptions(), oc.billingRef))
        older.purchases.buy(activity, oc, PurchaseTarget.Subscription(oc.option("sub.premium:m1")!!))
        assertEquals(listOf<app.core.store.PlanChange?>(null), older.billing.changes)
    }

    @Test
    fun aRestoreSaysAddedOnlyForTokensTheServerCallsFresh() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        // Bought here and confirmed: the server has it.
        r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!))
        r.billing.owned += r.billing.purchase("sub.plus", "tok-sub.plus") to ProductType.SUBSCRIPTION
        // A pack paid on this phone that never reached the server.
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-lost") to ProductType.ONE_TIME

        val first = r.purchases.restore(manual = true) as RestoreOutcome.Done
        assertEquals(setOf("sub.plus", "cons.superlike.5"), first.granted)
        assertEquals("only the pack is new", setOf("cons.superlike.5"), first.added)
        assertTrue(first.addedKnown)

        val again = r.purchases.restore(manual = true) as RestoreOutcome.Done
        assertEquals(setOf("sub.plus", "cons.superlike.5"), again.granted)
        assertEquals("nothing new the second time", emptySet<String>(), again.added)
    }

    @Test
    fun aServerWithoutFreshLeavesThePhonesGuess() = runTest {
        val r = rig()
        r.api.saysFresh = false
        r.billing.owned += r.billing.purchase("sub.plus", "tok-known") to ProductType.SUBSCRIPTION
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-lost") to ProductType.ONE_TIME
        r.known.put("tok-known", "active")
        r.api.granted += "tok-known"
        val done = r.purchases.restore(manual = true) as RestoreOutcome.Done
        assertFalse(done.addedKnown)
        assertEquals("no settled answer before, granting now", setOf("cons.superlike.5"), done.added)
        assertEquals(setOf("sub.plus", "cons.superlike.5"), done.granted)
    }

    @Test
    fun aPackCreditedFromAnotherPhoneIsNotAddedAgainWhenTheServerSaysSo() = runTest {
        // Credited long ago (another phone, or this one before its storage was cleared); Play still holds it.
        val r = rig()
        val catalogue = r.catalogue()
        val pack = PurchaseTarget.Pack(catalogue.pack("cons.superlike.5")!!)
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-old-pack") to ProductType.ONE_TIME
        r.api.granted += "tok-old-pack"
        r.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        assertEquals(PurchaseStep.Failed("cons.superlike.5", PurchaseFailure.STILL_COMPLETING), r.purchases.buy(activity, catalogue, pack))

        // From a server without `fresh` the phone can only guess (it had no answer for the token): "added", as before.
        val older = rig()
        older.api.saysFresh = false
        val oc = older.catalogue()
        older.billing.owned += older.billing.purchase("cons.superlike.5", "tok-old-pack") to ProductType.ONE_TIME
        older.api.granted += "tok-old-pack"
        older.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        assertEquals(PurchaseStep.Done("cons.superlike.5", PurchaseKind.Consumable), older.purchases.buy(activity, oc, PurchaseTarget.Pack(oc.pack("cons.superlike.5")!!)))
    }

    @Test
    fun aQueuedPackSentByTheRestoreIsAdded() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        val pack = PurchaseTarget.Pack(catalogue.pack("cons.superlike.5")!!)
        r.api.offline = true
        assertEquals(PurchaseStep.Queued("cons.superlike.5"), r.purchases.buy(activity, catalogue, pack))
        // Back online and its retry due, a second tap: Play says it is owned; the restore sends the queued one first, and that grants it.
        r.api.offline = false
        r.clock.advance(Purchases.backoff(0))
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-cons.superlike.5") to ProductType.ONE_TIME
        r.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        assertEquals(PurchaseStep.Done("cons.superlike.5", PurchaseKind.Consumable), r.purchases.buy(activity, catalogue, pack))
        assertEquals(5, r.entitlements.entitlements.value?.wallet?.superlike)
        assertEquals(1, r.api.granted.size)
    }

    @Test
    fun anOwnedPlanTheServerGaveBeforeIsTheOneThePersonHas() = runTest {
        val r = rig()
        val catalogue = r.catalogue()
        // Plus from a token the server knows, with no reference to replace it by: Play says "already owned".
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus", accountRef = null) to ProductType.SUBSCRIPTION
        r.api.granted += "tok-plus"
        r.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Play)
        r.entitlements.apply(r.api.entitlements)
        r.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        assertEquals(
            PurchaseStep.Failed("sub.plus:m3", PurchaseFailure.ALREADY_CURRENT),
            r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m3")!!)),
        )

        // A server without `fresh`: a plan it gives after the restore is done, as before.
        val older = rig()
        older.api.saysFresh = false
        val oc = older.catalogue()
        older.billing.owned += older.billing.purchase("sub.plus", "tok-plus", accountRef = null) to ProductType.SUBSCRIPTION
        older.api.granted += "tok-plus"
        older.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Play)
        older.entitlements.apply(older.api.entitlements)
        older.billing.next = { p -> PurchaseOutcome.AlreadyOwned(p.id) }
        assertEquals(
            PurchaseStep.Done("sub.plus:m3", PurchaseKind.Subscription),
            older.purchases.buy(activity, oc, PurchaseTarget.Subscription(oc.option("sub.plus:m3")!!)),
        )
    }

    @Test
    fun aStatusChangeInTheStoreSendsEveryOwnedSubscriptionAgainButNoPack() = runTest {
        val r = rig()
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        r.billing.owned += r.billing.purchase("cons.superlike.5", "tok-pack") to ProductType.ONE_TIME
        // The server answered both before; the subscription has since gone on hold on its side.
        r.known.put("tok-plus", "on_hold")
        r.known.put("tok-pack", "purchased")
        assertEquals("a quiet restore leaves settled tokens alone", RestoreOutcome.NothingToRestore, r.purchases.restore(manual = false))
        assertTrue(r.api.restored.isEmpty())

        r.purchases.start(MutableStateFlow(false))
        runCurrent()
        r.billing.statusChanges.emit(Unit)
        runCurrent()
        assertEquals("the known subscription token, sent again; no pack", listOf(listOf("tok-plus")), r.api.restored)
        assertEquals("active", r.known.state("tok-plus"))
        assertEquals("plus", r.entitlements.entitlements.value?.plan)
        assertEquals("no purchase step: nothing is shown on the paywall", PurchaseStep.Idle, r.purchases.step.value)
    }

    @Test
    fun aResyncWithoutOwnedSubscriptionsReadsTheEntitlementsAgain() = runTest {
        var reads = 0
        val r = rig()
        val entitlements = app.core.sync.EntitlementRepository(fetch = { reads++; Fetched(r.api.entitlements, true) })
        val purchases = Purchases(r.billing, r.api, r.outbox, r.known, entitlements, { "u1" }, backgroundScope, r.clock)
        assertEquals(RestoreOutcome.NothingToRestore, purchases.resyncSubscriptions())
        assertTrue(r.api.restored.isEmpty())
        assertEquals(1, reads)
    }

    @Test
    fun aResyncSaysSomethingOnlyWhenItBringsAPlanBack() = runTest {
        val r = rig()
        val said = mutableListOf<Unit>()
        backgroundScope.launch { r.purchases.subscriptionBack.collect { said += it } }
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        r.known.put("tok-plus", "active")
        val plus = Entitlements(plan = "plus", source = EntitlementSource.Play)
        r.api.granted += "tok-plus"

        // In grace: the plan was shown all along. Its answer is applied, nothing said.
        r.api.entitlements = plus
        r.entitlements.apply(plus)
        r.api.verdicts["tok-plus"] = "grace"
        assertEquals(setOf("sub.plus"), (r.purchases.resyncSubscriptions() as RestoreOutcome.Done).granted)
        runCurrent()
        assertEquals(emptyList<Unit>(), said)

        // Still on hold: the app shows no plan and the answer gives none.
        r.api.entitlements = Entitlements()
        r.entitlements.apply(Entitlements())
        r.api.verdicts["tok-plus"] = "on_hold"
        assertEquals(1, (r.purchases.resyncSubscriptions() as RestoreOutcome.Done).inactive)
        runCurrent()
        assertEquals(emptyList<Unit>(), said)

        // The payment fixed: the plan comes back, said once.
        r.api.entitlements = plus
        r.api.verdicts["tok-plus"] = "active"
        r.purchases.resyncSubscriptions()
        runCurrent()
        assertEquals(listOf(Unit), said)
        assertEquals(plus, r.entitlements.entitlements.value)

        // Again, with the plan already shown: nothing more.
        r.purchases.resyncSubscriptions()
        runCurrent()
        assertEquals(1, said.size)
        assertEquals(PurchaseStep.Idle, r.purchases.step.value)
    }

    @Test
    fun aResyncWithEntitlementsNeverReadSaysNothing() = runTest {
        val r = rig()
        val said = mutableListOf<Unit>()
        backgroundScope.launch { r.purchases.subscriptionBack.collect { said += it } }
        r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        r.purchases.resyncSubscriptions()
        runCurrent()
        assertEquals("plus", r.entitlements.entitlements.value?.plan)
        assertEquals("what the app showed before is unknown: silent", emptyList<Unit>(), said)
    }

    /**
     * A plan that ended while the app was away (its `entitlement` event
     * missed): the copy shown still says Plus, the store no longer lists it.
     * The engine reads the entitlements again before refusing, so every
     * period is sold as a plain subscription, as for anyone without a plan.
     */
    @Test
    fun aPlanThatEndedUnannouncedIsReadAgainBeforeASaleIsRefused() = runTest {
        for (store in listOf(Store.PLAY, Store.BAZAAR)) {
            val r = rig(store)
            val product = if (store == Store.PLAY) "sub.plus" else "sub.plus.1m"
            r.api.entitlements = Entitlements(
                plan = "plus",
                source = if (store == Store.PLAY) EntitlementSource.Play else EntitlementSource.Bazaar,
                productId = product,
                basePlanId = "m1".takeIf { store == Store.PLAY },
                planExpiresAt = java.time.Instant.ofEpochMilli(r.clock.millis + 86_400_000L),
                autoRenew = false,
            )
            r.entitlements.ensure()
            r.billing.owned += r.billing.purchase(product, "tok-plus") to ProductType.SUBSCRIPTION
            val catalogue = r.catalogue()

            // It ends; nothing tells this phone.
            r.api.entitlements = Entitlements()
            r.billing.owned.clear()
            r.billing.next = { PurchaseOutcome.Cancelled }
            val reads = r.entitlementReads
            val keys = catalogue.plans.flatMap { it.options }.map { it.key }
            for (key in keys) {
                assertEquals("$store $key", PurchaseStep.Idle, r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option(key)!!)))
            }
            assertEquals("$store: every period reaches the store's sheet", keys.map { catalogue.option(it)!!.productId }, r.billing.sheets.map { it.first })
            assertTrue("$store: nothing replaced", r.billing.changes.all { it == null })
            assertEquals("$store: read once, before the first refusal", reads + 1, r.entitlementReads)
            assertEquals(PlanKey.FREE, r.entitlements.entitlements.value?.plan)
        }
    }

    /**
     * The same copy when the entitlements cannot be read again: its own end
     * has passed, so it marks no period and says nothing is held elsewhere.
     * A copy whose end has not come keeps refusing (the server may hold it).
     */
    @Test
    fun aCopyPastItsEndHoldsNothingWhenItCannotBeReadAgain() = runTest {
        val r = rig()
        val ended = Entitlements(
            plan = "plus",
            source = EntitlementSource.Play,
            productId = "sub.plus",
            basePlanId = "m1",
            planExpiresAt = java.time.Instant.ofEpochMilli(r.clock.millis - 3_600_000L),
        )
        r.entitlements.apply(ended)
        r.entitlementsDown = true
        val catalogue = r.catalogue()
        assertEquals(null, catalogue.current(ended, r.purchases.now()))
        assertFalse(r.purchases.heldElsewhere(ended, emptyList(), catalogue.billingRef))
        r.billing.next = { PurchaseOutcome.Cancelled }
        assertEquals(PurchaseStep.Idle, r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!)))
        assertEquals(listOf("sub.plus"), r.billing.sheets.map { it.first })

        val running = ended.copy(planExpiresAt = java.time.Instant.ofEpochMilli(r.clock.millis + 3_600_000L))
        r.entitlements.apply(running)
        assertEquals(
            PurchaseStep.Failed("sub.plus:m1", PurchaseFailure.ALREADY_CURRENT),
            r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.plus:m1")!!)),
        )
        assertEquals(
            PurchaseStep.Failed("sub.premium:m1", PurchaseFailure.MANAGED_ELSEWHERE),
            r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.premium:m1")!!)),
        )
        assertEquals("no further sheet", 1, r.billing.sheets.size)
    }

    /**
     * Play answers from its own cache, which can lag behind a purchase made
     * on another device with the same Google account: the store is asked
     * again before "held elsewhere" stops a change, and a list that caught up
     * replaces the plan as usual.
     */
    @Test
    fun theStoreIsAskedAgainBeforeSayingThePlanIsOnAnotherAccount() = runTest {
        val r = rig()
        r.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Play, productId = "sub.plus", basePlanId = "m1")
        r.entitlements.apply(r.api.entitlements)
        val catalogue = r.catalogue()
        val first = r.billing.ownedQueries
        r.billing.onOwnedQuery = { n ->
            if (n == first + 2) r.billing.owned += r.billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
        }
        r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.premium:m1")!!))
        assertEquals("asked twice", first + 2, r.billing.ownedQueries)
        assertEquals(listOf("sub.premium"), r.billing.sheets.map { it.first })
        assertEquals(app.core.store.PlanChange("tok-plus", PlanChangeKind.CHARGE_DIFFERENCE), r.billing.changes.single())
    }

    /**
     * Cafe Bazaar's list can come back empty for the account that holds the
     * plan (after a sign-in to Bazaar): that is not "another account", the
     * usual lock says why no second subscription is sold.
     */
    @Test
    fun anEmptyBazaarListIsNotAnotherAccount() = runTest {
        val r = rig(Store.BAZAAR)
        r.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Bazaar, productId = "sub.plus.1m")
        r.entitlements.apply(r.api.entitlements)
        val catalogue = r.catalogue()
        assertFalse(r.purchases.heldElsewhere(r.entitlements.entitlements.value, r.purchases.ownedSubscriptions(), catalogue.billingRef))
        assertEquals(
            PurchaseStep.Failed("sub.premium.1m", PurchaseFailure.CHANGE_NOT_SUPPORTED),
            r.purchases.buy(activity, catalogue, PurchaseTarget.Subscription(catalogue.option("sub.premium.1m")!!)),
        )
        assertTrue(r.billing.sheets.isEmpty())
    }

    /**
     * A store the server sells nothing for (none of its products, or the
     * store not set up there) is an empty catalogue without asking the store:
     * a phone without the store app reads "nothing on sale", not "install".
     */
    @Test
    fun nothingOnSaleIsSaidWithoutAskingTheStore() = runTest {
        for (store in listOf(Store.PLAY, Store.BAZAAR)) {
            val r = rig(store)
            r.api.catalogue = app.core.model.StoreProducts(r.api.catalogue.store, FakeStoreApi.BILLING_REF)
            r.billing.availability = BillingAvailability.Unavailable(BillingUnavailableReason.STORE_NOT_INSTALLED)
            val load = r.purchases.catalogue()
            assertTrue("$store: $load", load is CatalogueLoad.Ready && load.catalogue.isEmpty && load.catalogue.store == store)
            assertEquals("$store: the store is not asked", 0, r.billing.connects)
            assertEquals(FakeStoreApi.BILLING_REF, (load as CatalogueLoad.Ready).catalogue.billingRef)
        }
    }
}
