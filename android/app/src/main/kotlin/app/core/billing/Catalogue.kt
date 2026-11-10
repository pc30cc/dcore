package app.core.billing

import app.core.model.BillingPeriod
import app.core.model.ConsumableProduct
import app.core.model.Entitlements
import app.core.model.PlanFlags
import app.core.model.PlanKey
import app.core.model.PlanQuotas
import app.core.model.StoreName
import app.core.model.StoreProducts
import app.core.model.SubscriptionProduct
import app.core.model.WalletItem
import app.core.store.ProductType
import app.core.store.Store
import app.core.store.StoreProduct
import java.time.Instant

/** A badge the catalogue puts on a product; an unknown value shows none. */
enum class ProductBadge(val wire: String) {
    POPULAR("popular"),
    BEST_VALUE("best_value"),
    NEW("new"),
    ;

    companion object {
        fun of(wire: String?): ProductBadge? = entries.firstOrNull { it.wire == wire }
    }
}

/** One period of one plan, as the store sells it: its own price, never the server's. */
data class PlanOption(
    /** The plan's key ([app.core.model.StorePlan.key]). */
    val plan: String,
    val period: BillingPeriod,
    val badge: ProductBadge?,
    val sort: Int,
    val product: StoreProduct,
) {
    /** The product and, on Play, the base plan: what the server and the store call it. */
    val key: String get() = product.basePlanId?.let { "${product.id}:$it" } ?: product.id
    val productId: String get() = product.id
    val price: String get() = product.formattedPrice
}

/**
 * A plan on sale here, as the server describes it (its name and description
 * in the session's language, its badge, upgrade rank and what it gives) with
 * the periods the store sells of it. [name] and [rank] are null from a server
 * older than plans in the listing.
 */
data class PlanGroup(
    val plan: String,
    val options: List<PlanOption>,
    val name: String? = null,
    val description: String? = null,
    val badge: ProductBadge? = null,
    val rank: Int? = null,
    val features: PlanFlags = PlanFlags(),
    val quotas: PlanQuotas = PlanQuotas(),
)

/**
 * What a paywall was opened for. The plan it opens on is one that gives it
 * ([Catalogue.startPlan]), read from the plan's own switches and quotas, so
 * any plan the admin makes is matched without naming it here.
 */
enum class PlanNeed {
    SEE_LIKES,
    READ_RECEIPTS,
    INCOGNITO,
    ADVANCED_FILTERS,
    REWIND,

    /** Out of likes: a plan without a daily limit. */
    MORE_LIKES,
    MORE_SUPERLIKES,
    BOOSTS,

    /** Messages before a match. */
    MESSAGES,
    ;

    fun givenBy(plan: PlanGroup): Boolean = when (this) {
        SEE_LIKES -> plan.features.seeLikes
        READ_RECEIPTS -> plan.features.readReceipts
        INCOGNITO -> plan.features.incognito
        ADVANCED_FILTERS -> plan.features.advancedFilters
        REWIND -> plan.features.rewind
        MORE_LIKES -> plan.quotas.dailyLikes == PlanQuotas.UNLIMITED
        MORE_SUPERLIKES -> plan.quotas.weeklySuperlikes != 0
        BOOSTS -> plan.quotas.monthlyBoosts != 0
        MESSAGES -> plan.quotas.dailyDm != 0 || plan.quotas.weeklyDmGift != 0
    }
}

/** One pack of one consumable. */
data class PackOption(
    val item: WalletItem,
    val quantity: Int,
    val badge: ProductBadge?,
    val sort: Int,
    val product: StoreProduct,
) {
    val key: String get() = product.id
    val productId: String get() = product.id
    val price: String get() = product.formattedPrice
}

/**
 * What can be bought here and now: the server's active products for this
 * store joined with what the store itself returned for them. A product the
 * store did not return (not created in its console yet, not sold in this
 * country, inactive) is not shown.
 */
data class Catalogue(
    val store: Store,
    /** Play's `obfuscatedAccountId`, Cafe Bazaar's payload: the server's reference of this account. */
    val billingRef: String,
    val plans: List<PlanGroup>,
    val packs: List<PackOption>,
) {
    val isEmpty: Boolean get() = plans.isEmpty() && packs.isEmpty()

    fun plan(plan: String): PlanGroup? = plans.firstOrNull { it.plan == plan }

    /** The upgrade rank of [plan] (higher is better), when the catalogue sells it and the server gave one. */
    fun rank(plan: String): Int? = plan(plan)?.rank

    fun packsFor(item: WalletItem): List<PackOption> = packs.filter { it.item == item }

    fun option(key: String): PlanOption? = plans.asSequence().flatMap { it.options }.firstOrNull { it.key == key }

    fun pack(key: String): PackOption? = packs.firstOrNull { it.key == key }

    /** The default choice for [plan]: its "popular" period, else its first. */
    fun defaultOption(plan: String): PlanOption? =
        plan(plan)?.options?.let { options -> options.firstOrNull { it.badge == ProductBadge.POPULAR } ?: options.firstOrNull() }

    /**
     * The period the person is on, when [current] names it: a plan from this
     * store, not past its end at [now] ([runningStorePlan]), whose product
     * (and, on Play, base plan) the catalogue sells. Null when the
     * entitlements name no product (an older server, a grant, the other
     * store's plan), the plan has ended, or the catalogue no longer sells it.
     */
    fun current(current: Entitlements?, now: Instant): PlanOption? {
        val e = current?.takeIf { it.runningStorePlan(store, now) } ?: return null
        val productId = e.productId ?: return null
        return plans.asSequence().flatMap { it.options }
            .firstOrNull { it.plan == e.plan && it.productId == productId && it.product.basePlanId == e.basePlanId }
    }

    /**
     * The choice a tab of [plan] opens on: [defaultOption], unless that is the
     * period the person is on already ([current]), then the next one of the
     * plan the same way; the current one when it is all the plan sells.
     */
    fun startOption(plan: String, current: Entitlements?, now: Instant): PlanOption? {
        val held = current(current, now)?.key
        val others = plan(plan)?.options?.filter { it.key != held }.orEmpty()
        return others.firstOrNull { it.badge == ProductBadge.POPULAR } ?: others.firstOrNull() ?: defaultOption(plan)
    }

    /**
     * The plan a paywall opens on: [asked] when it is sold; otherwise, of the
     * plans ranked above the one [current] holds (all of them when none is,
     * or none ranks above), those that give [need] (all when none does), the
     * one the server marks popular, else the first in the server's order.
     * Null when nothing is sold.
     */
    fun startPlan(asked: String?, need: PlanNeed?, current: Entitlements?): String? {
        if (plans.isEmpty()) return null
        if (asked != null && plan(asked) != null) return asked
        val held = current?.plan?.takeIf(PlanKey::isPaid)?.let(::rank)
        val above = plans.filter { held == null || (it.rank ?: Int.MAX_VALUE) > held }.ifEmpty { plans }
        val giving = above.filter { need?.givenBy(it) ?: true }.ifEmpty { above }
        return (giving.firstOrNull { it.badge == ProductBadge.POPULAR } ?: giving.first()).plan
    }
}

/** The ids to ask the store for, per product type. Play's base plans share one product id. */
data class CatalogueQuery(val subscriptions: List<String>, val consumables: List<String>)

object CatalogueJoin {

    fun query(server: StoreProducts): CatalogueQuery = CatalogueQuery(
        subscriptions = server.subscriptions.map { it.productId }.distinct(),
        consumables = server.consumables.map { it.productId }.distinct(),
    )

    /**
     * Joins [server]'s catalogue with the store's answers. Only entries the
     * store returned are kept, in the server's order: the plans by their
     * `sort` with the server's names, badges and switches, any plan key
     * (one the server's plan list does not describe follows them, named by
     * its key); an entry without a plan, or whose period or item this build
     * does not know, is left out, and so is a Play
     * base plan whose period in the store differs from the server's (the
     * consoles and the panel disagree: neither price nor period can be shown
     * truthfully). A catalogue for another store than [store] is empty.
     */
    fun join(
        store: Store,
        server: StoreProducts,
        subscriptions: List<StoreProduct>,
        consumables: List<StoreProduct>,
        onMismatch: (String) -> Unit = {},
    ): Catalogue {
        if (server.store != store.wireName()) return Catalogue(store, server.billingRef, emptyList(), emptyList())
        val subs = subscriptions.filter { it.type == ProductType.SUBSCRIPTION }
        val options = server.subscriptions
            .filter { PlanKey.isPaid(it.plan) && it.period != BillingPeriod.Unknown }
            .mapNotNull { entry ->
                val product = subs.firstOrNull { it.id == entry.productId && it.basePlanId == entry.basePlanId } ?: return@mapNotNull null
                if (product.billingPeriod != null && !samePeriod(product.billingPeriod, entry.period.wire)) {
                    onMismatch("${entry.productId}:${entry.basePlanId}: the store says ${product.billingPeriod}, the catalogue ${entry.period.wire}")
                    return@mapNotNull null
                }
                PlanOption(entry.plan, entry.period, ProductBadge.of(entry.badge), entry.sort, product)
            }
            .sortedWith(compareBy<PlanOption> { it.sort }.thenBy { it.period.ordinal })
        val described = server.plans.filter { PlanKey.isPaid(it.key) }.sortedWith(compareBy({ it.sort }, { it.rank }))
        val order = (described.map { it.key } + options.map { it.plan }).distinct()
        val plans = order.mapNotNull { key ->
            val sold = options.filter { it.plan == key }.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val info = described.firstOrNull { it.key == key }
            PlanGroup(
                plan = key,
                options = sold,
                name = info?.name?.takeIf(String::isNotBlank),
                description = info?.description?.takeIf(String::isNotBlank),
                badge = ProductBadge.of(info?.badge),
                rank = info?.rank,
                features = info?.features ?: PlanFlags(),
                quotas = info?.quotas ?: PlanQuotas(),
            )
        }

        val oneTime = consumables.filter { it.type == ProductType.ONE_TIME }
        val packs = server.consumables
            .filter { it.item != WalletItem.Unknown && it.quantity > 0 }
            .mapNotNull { entry -> oneTime.firstOrNull { it.id == entry.productId }?.let { PackOption(entry.item, entry.quantity, ProductBadge.of(entry.badge), entry.sort, it) } }
            .sortedWith(compareBy<PackOption> { it.item.ordinal }.thenBy { it.sort }.thenBy { it.quantity })
        return Catalogue(store, server.billingRef, plans, packs)
    }

    private val PERIOD = Regex("""^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$""")

    /**
     * Whether two ISO 8601 periods are one billing period: Play writes a year
     * as `P1Y` where the catalogue says `P12M`, and a week as `P1W` or `P7D`.
     */
    fun samePeriod(a: String, b: String): Boolean = a == b || (canonical(a) != null && canonical(a) == canonical(b))

    private fun canonical(period: String): String? {
        val m = PERIOD.matchEntire(period) ?: return null
        val (y, mo, w, d) = m.destructured.toList().map { it.toIntOrNull() ?: 0 }
        val months = y * 12 + mo
        val days = w * 7 + d
        return when {
            months > 0 && days == 0 -> "${months}M"
            months == 0 && days > 0 -> "${days}D"
            else -> null
        }
    }

    /** The server's entry for [option], for the purchase body. */
    fun serverEntry(server: StoreProducts, option: PlanOption): SubscriptionProduct? =
        server.subscriptions.firstOrNull { it.productId == option.productId && it.basePlanId == option.product.basePlanId }

    fun serverEntry(server: StoreProducts, pack: PackOption): ConsumableProduct? =
        server.consumables.firstOrNull { it.productId == pack.productId }
}

fun Store.wireName(): StoreName = when (this) {
    Store.BAZAAR -> StoreName.Bazaar
    Store.PLAY -> StoreName.Play
}
