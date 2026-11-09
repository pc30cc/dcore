package app.core.billing

import app.core.model.BillingPeriod
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.store.PlanChangeKind
import app.core.store.ProductType
import app.core.store.Store
import app.core.store.StoreProduct
import app.core.store.StorePurchaseState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Which owned subscription a Play plan change replaces, and the replacement mode it may use. */
class PlanChangesTest {

    private fun option(productId: String, basePlan: String, plan: Plan, period: BillingPeriod, micros: Long?, currency: String? = "EUR") =
        PlanOption(
            plan = plan,
            period = period,
            badge = null,
            sort = 0,
            product = StoreProduct(productId, ProductType.SUBSCRIPTION, productId, "", "x", micros, currency, basePlanId = basePlan, billingPeriod = period.wire),
        )

    private val plusWeek = option("sub.plus", "w1", Plan.Plus, BillingPeriod.Week, 2_990_000)
    private val plusMonth = option("sub.plus", "m1", Plan.Plus, BillingPeriod.Month, 4_990_000)
    private val premiumMonth = option("sub.premium", "m1", Plan.Premium, BillingPeriod.Month, 9_990_000)
    private val premiumSixMonths = option("sub.premium", "m6", Plan.Premium, BillingPeriod.SixMonths, 29_990_000)

    @Test
    fun anotherBasePlanOfTheSameSubscriptionIsChargedInFull() {
        assertEquals(PlanChangeKind.CHARGE_FULL, PlanChanges.kind(Plan.Plus, "sub.plus", listOf(plusWeek, plusMonth), plusMonth))
    }

    @Test
    fun aLowerTierWaitsForTheRenewal() {
        assertEquals(PlanChangeKind.AT_RENEWAL, PlanChanges.kind(Plan.Premium, "sub.premium", listOf(premiumMonth), plusMonth))
    }

    @Test
    fun aHigherTierIsProratedOnlyWhenItCostsMorePerUnitOfTime() {
        assertEquals(PlanChangeKind.CHARGE_DIFFERENCE, PlanChanges.kind(Plan.Plus, "sub.plus", listOf(plusMonth), premiumMonth))
        // Plus weekly to Premium for six months: dearer tier, cheaper per week. Play refuses a prorated charge.
        assertEquals(PlanChangeKind.CREDIT_TIME, PlanChanges.kind(Plan.Plus, "sub.plus", listOf(plusMonth), premiumSixMonths))
        // The base plan a Play purchase is on is not known: the dearest of the owned product's is the bar.
        assertEquals(PlanChangeKind.CREDIT_TIME, PlanChanges.kind(Plan.Plus, "sub.plus", listOf(plusWeek, plusMonth), premiumMonth))
    }

    @Test
    fun pricesThatCannotBeComparedAreNeverProrated() {
        val noPrice = option("sub.plus", "m1", Plan.Plus, BillingPeriod.Month, null)
        val dollars = option("sub.plus", "m1", Plan.Plus, BillingPeriod.Month, 1_000, "USD")
        assertFalse(PlanChanges.costsMorePerUnitOfTime(listOf(noPrice), premiumMonth))
        assertFalse(PlanChanges.costsMorePerUnitOfTime(listOf(dollars), premiumMonth))
        assertFalse(PlanChanges.costsMorePerUnitOfTime(emptyList(), premiumMonth))
        assertTrue(PlanChanges.costsMorePerUnitOfTime(listOf(plusMonth), premiumMonth))
    }

    @Test
    fun aMonthIsReadAsTwentyEightToThirtyOneDays() {
        assertEquals(7..7, PlanChanges.periodDays("P1W"))
        assertEquals(28..31, PlanChanges.periodDays("P1M"))
        assertEquals(84..93, PlanChanges.periodDays("P3M"))
        assertEquals(365..366, PlanChanges.periodDays("P1Y"))
        assertNull(PlanChanges.periodDays("P0D"))
        assertNull(PlanChanges.periodDays("monthly"))
        // A month plan barely dearer than four weeks is not "more per unit of time" on every reading.
        val week = option("sub.plus", "w1", Plan.Plus, BillingPeriod.Week, 1_000_000)
        val month = option("sub.premium", "m1", Plan.Premium, BillingPeriod.Month, 4_200_000)
        assertFalse(PlanChanges.costsMorePerUnitOfTime(listOf(week), month))
    }

    @Test
    fun theBasePlanThePersonIsOnIsTheBarWhenTheServerNamesIt() {
        val owned = listOf(plusWeek, plusMonth)
        // On monthly Plus: Premium monthly costs more per day than that, so the difference is charged.
        assertEquals(PlanChangeKind.CHARGE_DIFFERENCE, PlanChanges.kind(Plan.Plus, "sub.plus", PlanChanges.bar(owned, "m1"), premiumMonth))
        // On weekly Plus (dearer per day than Premium monthly): the time left is credited instead.
        assertEquals(PlanChangeKind.CREDIT_TIME, PlanChanges.kind(Plan.Plus, "sub.plus", PlanChanges.bar(owned, "w1"), premiumMonth))
        // Not named (an older server): the dearest of the product's base plans, weekly, is the bar.
        assertEquals(owned, PlanChanges.bar(owned, null))
        assertEquals(PlanChangeKind.CREDIT_TIME, PlanChanges.kind(Plan.Plus, "sub.plus", PlanChanges.bar(owned, null), premiumMonth))
        // Named but no longer sold: no price to compare, so never a prorated charge.
        assertEquals(emptyList<PlanOption>(), PlanChanges.bar(owned, "y1"))
        assertEquals(PlanChangeKind.CREDIT_TIME, PlanChanges.kind(Plan.Plus, "sub.plus", PlanChanges.bar(owned, "y1"), premiumMonth))
    }

    @Test
    fun theServersProductPicksTheSubscriptionThatIsReplaced() {
        val billing = FakeBilling(Store.PLAY)
        // Both products read as Plus in a catalogue that sells two Plus products; the server names the one it counts.
        val planOf = { _: String -> Plan.Plus }
        val older = billing.purchase("sub.plus", "t-plus", purchaseTimeMillis = 1)
        val later = billing.purchase("sub.plus.extra", "t-extra", purchaseTimeMillis = 9)
        val ref = FakeStoreApi.BILLING_REF
        assertEquals(later, PlanChanges.backing(listOf(older, later), Plan.Plus, ref, planOf))
        assertEquals(older, PlanChanges.backing(listOf(older, later), Plan.Plus, ref, planOf, productId = "sub.plus"))
        assertNull(PlanChanges.backing(listOf(later), Plan.Plus, ref, planOf, productId = "sub.plus"))
    }

    @Test
    fun aPlanIsHeldElsewhereOnlyWhenTheStoreListsNothingOfItThatCanBeThisAccounts() {
        val play = FakeBilling(Store.PLAY)
        val ref = FakeStoreApi.BILLING_REF
        val now = Instant.parse("2026-11-09T12:00:00Z")
        val plus = Entitlements(plan = Plan.Plus, source = EntitlementSource.Play, productId = "sub.plus", basePlanId = "m1", planExpiresAt = now.plusSeconds(86_400))
        fun held(owned: List<app.core.store.StorePurchase>?, e: Entitlements? = plus, store: Store = Store.PLAY, billingRef: String = ref) =
            PlanChanges.heldElsewhere(store, e, owned, billingRef, now)

        assertTrue("the store account here holds nothing", held(emptyList()))
        assertTrue("only another account's", held(listOf(play.purchase("sub.plus", "t1", accountRef = "otheraccount2"))))
        assertTrue("only another product", held(listOf(play.purchase("sub.premium", "t2"))))
        assertTrue("only a refunded one", held(listOf(play.purchase("sub.plus", "t3", StorePurchaseState.REFUNDED))))
        assertFalse("this account's", held(listOf(play.purchase("sub.plus", "t4"))))
        assertFalse("this account's, on hold", held(listOf(play.purchase("sub.plus", "t5", suspended = true))))
        assertFalse("one with no reference may be this account's", held(listOf(play.purchase("sub.plus", "t6", accountRef = null))))
        assertFalse("no reference to compare with", held(listOf(play.purchase("sub.plus", "t7", accountRef = "otheraccount2")), billingRef = ""))
        assertFalse("the store could not be asked", held(null))
        assertFalse("no product named (an older server)", held(emptyList(), plus.copy(productId = null, basePlanId = null)))
        assertFalse("a grant", held(emptyList(), plus.copy(source = EntitlementSource.Grant)))
        assertFalse("the other store's plan", held(emptyList(), plus.copy(source = EntitlementSource.Bazaar)))
        assertFalse("free", held(emptyList(), Entitlements()))
        assertFalse("not read yet", held(emptyList(), null))
        // A copy read before the plan ended: nothing is held anywhere any more.
        assertFalse("ended a minute ago", held(emptyList(), plus.copy(planExpiresAt = now.minusSeconds(60))))
        assertFalse("ends right now", held(emptyList(), plus.copy(planExpiresAt = now)))
        assertTrue("no end named", held(emptyList(), plus.copy(planExpiresAt = null)))

        // Cafe Bazaar's list can be empty or short for the account that holds the plan: only another
        // reference's token of the product says the plan is on another Bazaar account.
        val bazaar = FakeBilling(Store.BAZAAR)
        val bazaarPlus = Entitlements(plan = Plan.Plus, source = EntitlementSource.Bazaar, productId = "sub.plus.1m", planExpiresAt = now.plusSeconds(86_400))
        assertFalse("an empty list says nothing", held(emptyList(), bazaarPlus, Store.BAZAAR))
        assertFalse("nor one without the product", held(listOf(bazaar.purchase("sub.premium.1m", "b0")), bazaarPlus, Store.BAZAAR))
        assertFalse("nor a refunded one", held(listOf(bazaar.purchase("sub.plus.1m", "b9", StorePurchaseState.REFUNDED)), bazaarPlus, Store.BAZAAR))
        assertTrue("another reference's token of it", held(listOf(bazaar.purchase("sub.plus.1m", "b2", accountRef = "otheraccount2")), bazaarPlus, Store.BAZAAR))
        assertFalse(held(listOf(bazaar.purchase("sub.plus.1m", "b1")), bazaarPlus, Store.BAZAAR))
        assertFalse("ended", held(listOf(bazaar.purchase("sub.plus.1m", "b2", accountRef = "otheraccount2")), bazaarPlus.copy(planExpiresAt = now.minusSeconds(1)), Store.BAZAAR))
    }

    @Test
    fun onlyThisAccountsPaidSubscriptionOfItsPlanIsReplaced() {
        val billing = FakeBilling(Store.PLAY)
        val planOf = { id: String -> if (id == "sub.premium") Plan.Premium else Plan.Plus }
        val theirs = billing.purchase("sub.plus", "t-theirs", accountRef = "otheraccount2")
        val noRef = billing.purchase("sub.plus", "t-none", accountRef = null)
        val held = billing.purchase("sub.plus", "t-held", suspended = true)
        val older = billing.purchase("sub.plus", "t-older", purchaseTimeMillis = 1)
        val mine = billing.purchase("sub.plus", "t-mine", purchaseTimeMillis = 5)
        val premium = billing.purchase("sub.premium", "t-premium", purchaseTimeMillis = 9)
        val ref = FakeStoreApi.BILLING_REF
        assertEquals(mine, PlanChanges.backing(listOf(theirs, noRef, held, older, mine, premium), Plan.Plus, ref, planOf))
        assertNull(PlanChanges.backing(listOf(theirs, noRef, held), Plan.Plus, ref, planOf))
        assertNull("no reference, no replacement", PlanChanges.backing(listOf(mine), Plan.Plus, "", planOf))
    }
}
