package app.core.store

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.billing.FakeBilling
import app.core.billing.FakeStoreApi
import app.core.billing.KnownPurchases
import app.core.billing.PurchaseOutbox
import app.core.billing.PurchaseStep
import app.core.billing.Purchases
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.net.Fetched
import app.core.storage.MemorySecretStore
import app.core.sync.EntitlementRepository
import com.android.billingclient.api.InAppMessageResult.InAppMessageResponseCode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Play's in-app message for a declined payment: once the person fixes it
 * there (`SUBSCRIPTION_STATUS_UPDATED`), the purchase engine sends the
 * subscriptions to the server again, the ones it already knows included, and
 * says something only when a plan comes back.
 */
@RunWith(AndroidJUnit4::class)
class PlaySubscriptionStatusTest {

    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val play = StoreModule.create(context, Diag.Silent).billing as PlayBilling

    /** The fake store's purchases, with Play's own signal of a status change. */
    private class PlaySignals(fake: FakeBilling, private val play: PlayBilling) : StoreBilling by fake {
        override val subscriptionStatusChanges: Flow<Unit> get() = play.subscriptionStatusChanges
    }

    private inner class Rig(scope: TestScope) {
        val billing = FakeBilling(Store.PLAY)
        val api = FakeStoreApi(Store.PLAY)
        private val secrets = MemorySecretStore()
        val known = KnownPurchases(secrets)
        val entitlements = EntitlementRepository(fetch = { Fetched(api.entitlements, true) })
        val said = mutableListOf<Unit>()
        val purchases = Purchases(
            billing = PlaySignals(billing, play),
            api = api,
            outbox = PurchaseOutbox(secrets),
            known = known,
            entitlements = entitlements,
            account = { "u1" },
            scope = scope.backgroundScope,
            clock = FakeClock(),
        )

        init {
            billing.owned += billing.purchase("sub.plus", "tok-plus") to ProductType.SUBSCRIPTION
            billing.owned += billing.purchase("cons.superlike.5", "tok-pack") to ProductType.ONE_TIME
            purchases.start(MutableStateFlow(false))
            scope.backgroundScope.launch { purchases.subscriptionBack.collect { said += it } }
        }
    }

    /** What Play's listener hands on from its `InAppMessageResult` (whose public constructor keeps no code). */
    private fun answer(code: Int) = play.onInAppMessage(code)

    @Test
    fun `a payment fixed in Play's message sends the known subscription again and says the plan is back`() = runTest {
        val r = Rig(this)
        // On hold on the server's side: the app shows no plan, and a quiet restore sends nothing.
        r.known.put("tok-plus", "on_hold")
        r.known.put("tok-pack", "purchased")
        r.entitlements.apply(Entitlements())
        runCurrent()

        answer(InAppMessageResponseCode.SUBSCRIPTION_STATUS_UPDATED)
        runCurrent()

        assertEquals("the known subscription token once; no pack", listOf(listOf("tok-plus")), r.api.restored)
        assertEquals("active", r.known.state("tok-plus"))
        assertEquals("plus", r.entitlements.entitlements.value?.plan)
        assertEquals(EntitlementSource.Play, r.entitlements.entitlements.value?.source)
        assertEquals("said once", 1, r.said.size)
        assertEquals("the paywall's restore notice is not involved", PurchaseStep.Idle, r.purchases.step.value)
    }

    @Test
    fun `a status change for a plan still shown is sent but says nothing`() = runTest {
        val r = Rig(this)
        r.known.put("tok-plus", "grace")
        r.api.granted += "tok-plus"
        r.api.verdicts["tok-plus"] = "active"
        r.api.entitlements = Entitlements(plan = "plus", source = EntitlementSource.Play)
        r.entitlements.apply(r.api.entitlements)
        runCurrent()

        answer(InAppMessageResponseCode.SUBSCRIPTION_STATUS_UPDATED)
        runCurrent()

        assertEquals(listOf(listOf("tok-plus")), r.api.restored)
        assertTrue("nothing new: silent", r.said.isEmpty())
    }

    @Test
    fun `no action needed sends nothing`() = runTest {
        val r = Rig(this)
        r.known.put("tok-plus", "on_hold")
        runCurrent()

        answer(InAppMessageResponseCode.NO_ACTION_NEEDED)
        runCurrent()

        assertTrue(r.api.restored.isEmpty())
        assertEquals(0, r.billing.ownedQueries)
        assertTrue(r.said.isEmpty())
    }
}
