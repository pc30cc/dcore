package app.core.billing

import app.core.model.BillingPeriod
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.StoreProducts
import app.core.model.Wire
import app.core.model.WalletItem
import app.core.store.ProductType
import app.core.store.Store
import app.core.store.StoreProduct
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.io.File

/** The server's catalogue (the shared fixture, as the server sends it) joined with what the store returned. */
class CatalogueJoinTest {

    private val fixture: StoreProducts by lazy {
        val root = generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
            .map { File(it, "server/packages/shared/fixtures/v1/store-products.json") }
            .firstOrNull { it.isFile } ?: error("store-products.json not found")
        Wire.json.decodeFromString(StoreProducts.serializer(), root.readText())
    }

    private fun sub(id: String, base: String?, price: String, period: String? = null) =
        StoreProduct(id, ProductType.SUBSCRIPTION, id, "", price, offerToken = base?.let { "offer-$it" }, basePlanId = base, billingPeriod = period)

    private fun pack(id: String, price: String) = StoreProduct(id, ProductType.ONE_TIME, id, "", price)

    @Test
    fun onlyWhatTheStoreReturnedIsShownWithTheStoresOwnPrice() {
        // Play returns sub.plus's m1 and m3 and two packs: w1, Premium, the boost and the dm pack are not on sale here.
        val catalogue = CatalogueJoin.join(
            Store.PLAY,
            fixture,
            subscriptions = listOf(sub("sub.plus", "m1", "€4.99", "P1M"), sub("sub.plus", "m3", "€11.99", "P3M")),
            consumables = listOf(pack("cons.superlike.5", "€2.49"), pack("cons.spotlight.1", "€3.99")),
        )
        assertEquals(listOf("plus"), catalogue.plans.map { it.plan })
        val plus = catalogue.plan("plus")!!.options
        assertEquals(listOf("sub.plus:m1", "sub.plus:m3"), plus.map { it.key })
        assertEquals(listOf("€4.99", "€11.99"), plus.map { it.price })
        assertEquals(listOf(BillingPeriod.Month, BillingPeriod.ThreeMonths), plus.map { it.period })
        assertEquals(listOf(ProductBadge.POPULAR, ProductBadge.BEST_VALUE), plus.map { it.badge })
        assertEquals(listOf(WalletItem.Superlike, WalletItem.Spotlight), catalogue.packs.map { it.item })
        assertEquals(ProductBadge.NEW, catalogue.pack("cons.spotlight.1")!!.badge)
        assertEquals("k7wq2m4zx5p3a", catalogue.billingRef)
        assertEquals("the popular period is chosen first", "sub.plus:m1", catalogue.defaultOption("plus")!!.key)
    }

    @Test
    fun aBasePlanWhosePeriodTheStoreDisagreesWithIsHidden() {
        val mismatches = mutableListOf<String>()
        val catalogue = CatalogueJoin.join(
            Store.PLAY,
            fixture,
            subscriptions = listOf(sub("sub.plus", "m1", "€4.99", "P1W"), sub("sub.plus", "m3", "€11.99", "P3M")),
            consumables = emptyList(),
            onMismatch = { mismatches += it },
        )
        assertEquals(listOf("sub.plus:m3"), catalogue.plan("plus")!!.options.map { it.key })
        assertEquals(1, mismatches.size)
    }

    @Test
    fun anotherStoresCatalogueSellsNothing() {
        val catalogue = CatalogueJoin.join(Store.BAZAAR, fixture, listOf(sub("sub.plus", "m1", "x", "P1M")), emptyList())
        assertTrue(catalogue.isEmpty)
    }

    @Test
    fun bazaarProductsHaveNoBasePlanAndJoinByTheirOwnIds() {
        val server = FakeStoreApi.catalogueOf(Store.BAZAAR)
        val catalogue = CatalogueJoin.join(Store.BAZAAR, server, FakeStoreApi.storeProducts(Store.BAZAAR).filter { it.type == ProductType.SUBSCRIPTION }, emptyList())
        assertEquals(listOf("plus", "premium"), catalogue.plans.map { it.plan })
        assertEquals("sub.plus.1m", catalogue.plan("plus")!!.options.single().key)
        assertEquals("۱۲۰٬۰۰۰ تومان", catalogue.plan("plus")!!.options.single().price)
        assertTrue(catalogue.packs.isEmpty())
    }

    @Test
    fun entriesWithoutAPlanOrWithAPeriodOrItemThisBuildDoesNotKnowAreLeftOutAndUnknownBadgesShowNone() {
        val json = """
            {"store":"play","billingRef":"k7wq2m4zx5p3a",
             "subscriptions":[
               {"productId":"sub.plus","basePlanId":"m1","plan":"plus","period":"P1M","badge":"flash_sale","sort":1},
               {"productId":"sub.gold","basePlanId":"m1","plan":"gold","period":"P1M","sort":2},
               {"productId":"sub.plus","basePlanId":"d1","plan":"plus","period":"P1D","sort":3}],
             "consumables":[{"productId":"cons.rose.1","item":"rose","quantity":1,"sort":4}]}
        """.trimIndent()
        val server = Wire.json.decodeFromString(StoreProducts.serializer(), json)
        val catalogue = CatalogueJoin.join(
            Store.PLAY,
            server,
            listOf(sub("sub.plus", "m1", "€1", "P1M"), sub("sub.gold", "m1", "€2", "P1M"), sub("sub.plus", "d1", "€3")),
            listOf(pack("cons.rose.1", "€1")),
        )
        // A plan key the server lists but this build never heard of ("gold") is a plan like any other.
        assertEquals(listOf("sub.plus:m1", "sub.gold:m1"), catalogue.plans.flatMap { it.options }.map { it.key })
        assertEquals(listOf("plus", "gold"), catalogue.plans.map { it.plan })
        assertNull(catalogue.plan("plus")!!.options.single().badge)
        assertTrue(catalogue.packs.isEmpty())
    }

    @Test
    fun thePlansAreTheServersInItsOrderWithItsNamesBadgesRanksAndWhatTheyGive() {
        val json = """
            {"store":"play","billingRef":"k7wq2m4zx5p3a",
             "plans":[
               {"key":"premium","rank":2,"sort":2,"name":"Premium","features":{"see_likes":true},"quotas":{"weekly_superlikes":5}},
               {"key":"gold_summer","rank":3,"sort":1,"name":"Summer gold","description":"For the summer.","badge":"popular",
                "features":{"see_likes":true,"priority_likes":true,"a_switch_from_later":true},"quotas":{"daily_likes":-1,"monthly_boosts":2}},
               {"key":"free","rank":0,"sort":0,"name":"Free","features":{},"quotas":{}}],
             "subscriptions":[
               {"productId":"sub.premium","basePlanId":"m1","plan":"premium","period":"P1M","sort":1},
               {"productId":"sub.gold","basePlanId":"y1","plan":"gold_summer","period":"P12M","sort":2},
               {"productId":"sub.free","basePlanId":"m1","plan":"free","period":"P1M","sort":3}],
             "consumables":[]}
        """.trimIndent()
        val server = Wire.json.decodeFromString(StoreProducts.serializer(), json)
        // Play writes a year as P1Y where the catalogue says P12M: the same period, kept.
        val catalogue = CatalogueJoin.join(
            Store.PLAY,
            server,
            listOf(sub("sub.premium", "m1", "€9.99", "P1M"), sub("sub.gold", "y1", "€49.99", "P1Y"), sub("sub.free", "m1", "€0", "P1M")),
            emptyList(),
        )
        assertEquals("by the server's sort; the free plan is never sold", listOf("gold_summer", "premium"), catalogue.plans.map { it.plan })
        val gold = catalogue.plan("gold_summer")!!
        assertEquals("Summer gold", gold.name)
        assertEquals("For the summer.", gold.description)
        assertEquals(ProductBadge.POPULAR, gold.badge)
        assertEquals(3, catalogue.rank("gold_summer"))
        assertEquals(2, catalogue.rank("premium"))
        assertNull(catalogue.rank("plus"))
        assertTrue(gold.features.priorityLikes)
        assertEquals(-1, gold.quotas.dailyLikes)
        assertEquals(BillingPeriod.Year, gold.options.single().period)
    }

    @Test
    fun periodsAreComparedAsPeriodsNotAsText() {
        assertTrue(CatalogueJoin.samePeriod("P1Y", "P12M"))
        assertTrue(CatalogueJoin.samePeriod("P1W", "P7D"))
        assertTrue(CatalogueJoin.samePeriod("P3M", "P3M"))
        assertFalse(CatalogueJoin.samePeriod("P1M", "P1W"))
        assertFalse(CatalogueJoin.samePeriod("P6M", "P1Y"))
        assertFalse(CatalogueJoin.samePeriod("monthly", "P1M"))
    }

    @Test
    fun aPaywallOpensOnAPlanThatGivesWhatItWasOpenedForAboveTheOneHeld() {
        val json = """
            {"store":"play","billingRef":"k7wq2m4zx5p3a",
             "plans":[
               {"key":"plus","rank":1,"sort":1,"name":"Plus","features":{"rewind":true},"quotas":{"daily_likes":-1}},
               {"key":"premium","rank":2,"sort":2,"name":"Premium","badge":"popular","features":{"see_likes":true,"rewind":true},"quotas":{"daily_likes":-1}},
               {"key":"platinum","rank":3,"sort":3,"name":"Platinum","features":{"see_likes":true,"incognito":true},"quotas":{"daily_likes":-1}}],
             "subscriptions":[
               {"productId":"sub.plus","basePlanId":"m1","plan":"plus","period":"P1M","sort":1},
               {"productId":"sub.premium","basePlanId":"m1","plan":"premium","period":"P1M","sort":2},
               {"productId":"sub.platinum","basePlanId":"m1","plan":"platinum","period":"P1M","sort":3}],
             "consumables":[]}
        """.trimIndent()
        val server = Wire.json.decodeFromString(StoreProducts.serializer(), json)
        val c = CatalogueJoin.join(
            Store.PLAY,
            server,
            listOf(sub("sub.plus", "m1", "€4.99", "P1M"), sub("sub.premium", "m1", "€9.99", "P1M"), sub("sub.platinum", "m1", "€14.99", "P1M")),
            emptyList(),
        )
        val free = Entitlements()
        assertEquals("asked for and sold", "plus", c.startPlan("plus", PlanNeed.SEE_LIKES, free))
        assertEquals("nothing in particular: the popular one", "premium", c.startPlan(null, null, free))
        assertEquals("incognito: the one that gives it", "platinum", c.startPlan(null, PlanNeed.INCOGNITO, free))
        assertEquals("see likes: the popular one of those that give it", "premium", c.startPlan(null, PlanNeed.SEE_LIKES, free))
        assertEquals("rewind on Premium already: above it", "platinum", c.startPlan(null, PlanNeed.REWIND, Entitlements(plan = "premium")))
        assertEquals("on the best plan: all of them again", "premium", c.startPlan(null, null, Entitlements(plan = "platinum")))
        assertEquals("a plan this catalogue does not sell ranks nowhere", "premium", c.startPlan(null, null, Entitlements(plan = "legacy_gold")))
        assertEquals("nobody gives it: the popular one", "premium", c.startPlan("nonexistent", PlanNeed.BOOSTS, free))
        assertNull(CatalogueJoin.join(Store.PLAY, server, emptyList(), emptyList()).startPlan(null, null, free))
    }

    @Test
    fun messagesBeforeAMatchAreGivenByADailyQuotaOrAWeeklyGiftEvenUnlimited() {
        fun plan(quotas: app.core.model.PlanQuotas) = PlanGroup("x", emptyList(), quotas = quotas)
        assertTrue(PlanNeed.MESSAGES.givenBy(plan(app.core.model.PlanQuotas(dailyDm = 3))))
        assertTrue(PlanNeed.MESSAGES.givenBy(plan(app.core.model.PlanQuotas(dailyDm = -1))))
        assertTrue(PlanNeed.MESSAGES.givenBy(plan(app.core.model.PlanQuotas(weeklyDmGift = 2))))
        assertTrue("an unlimited weekly gift", PlanNeed.MESSAGES.givenBy(plan(app.core.model.PlanQuotas(weeklyDmGift = -1))))
        assertFalse(PlanNeed.MESSAGES.givenBy(plan(app.core.model.PlanQuotas())))
    }

    @Test
    fun thePeriodThePersonIsOnIsTheOneTheServerNames() {
        val play = CatalogueJoin.join(
            Store.PLAY,
            FakeStoreApi.catalogueOf(Store.PLAY),
            FakeStoreApi.storeProducts(Store.PLAY).filter { it.type == ProductType.SUBSCRIPTION },
            emptyList(),
        )
        val now = Instant.parse("2026-11-09T12:00:00Z")
        val onM1 = Entitlements(plan = "plus", source = EntitlementSource.Play, productId = "sub.plus", basePlanId = "m1")
        assertEquals("sub.plus:m1", play.current(onM1, now)?.key)
        assertEquals("sub.plus:m3", play.current(onM1.copy(basePlanId = "m3"), now)?.key)
        assertNull("a Play product without its base plan names no period", play.current(onM1.copy(basePlanId = null), now))
        assertNull("a base plan not sold", play.current(onM1.copy(basePlanId = "y1"), now))
        assertNull("an older server names no product", play.current(onM1.copy(productId = null, basePlanId = null), now))
        assertNull("a grant", play.current(onM1.copy(source = EntitlementSource.Grant), now))
        assertNull("the other store's plan", play.current(onM1.copy(source = EntitlementSource.Bazaar), now))
        assertNull("a product of another plan than the one shown", play.current(onM1.copy(plan = "premium"), now))
        // A copy read before the plan ended (its end has passed) holds no period; one still running does.
        assertEquals("sub.plus:m1", play.current(onM1.copy(planExpiresAt = now.plusSeconds(60)), now)?.key)
        assertNull("ended a minute ago", play.current(onM1.copy(planExpiresAt = now.minusSeconds(60)), now))
        assertNull("ends right now", play.current(onM1.copy(planExpiresAt = now), now))
        assertEquals("an ended copy marks nothing: the popular period again", "sub.plus:m1",
            play.startOption("plus", onM1.copy(planExpiresAt = now.minusSeconds(60)), now)?.key)

        // The Plus tab opens on another period than the one held: the popular one is held, so the next.
        assertEquals("sub.plus:m1", play.startOption("plus", null, now)?.key)
        assertEquals("sub.plus:m3", play.startOption("plus", onM1, now)?.key)
        assertEquals("sub.plus:m1", play.startOption("plus", onM1.copy(basePlanId = "m3"), now)?.key)
        assertEquals("the only period of a plan, held", "sub.premium:m1",
            play.startOption("premium", Entitlements(plan = "premium", source = EntitlementSource.Play, productId = "sub.premium", basePlanId = "m1"), now)?.key)

        val bazaar = CatalogueJoin.join(
            Store.BAZAAR,
            FakeStoreApi.catalogueOf(Store.BAZAAR),
            FakeStoreApi.storeProducts(Store.BAZAAR).filter { it.type == ProductType.SUBSCRIPTION },
            emptyList(),
        )
        val bazaarPlus = Entitlements(plan = "plus", source = EntitlementSource.Bazaar, productId = "sub.plus.1m")
        assertEquals("sub.plus.1m", bazaar.current(bazaarPlus, now)?.key)
        assertNull(bazaar.current(bazaarPlus.copy(source = EntitlementSource.Play), now))
        assertNull("ended", bazaar.current(bazaarPlus.copy(planExpiresAt = now.minusSeconds(1)), now))
    }

    @Test
    fun theQueryAsksEachProductIdOnce() {
        val query = CatalogueJoin.query(fixture)
        assertEquals(listOf("sub.plus", "sub.premium"), query.subscriptions)
        assertEquals(listOf("cons.superlike.5", "cons.boost.1", "cons.spotlight.1", "cons.dm.5"), query.consumables)
    }
}
