package app.core.billing

import app.core.model.BillingPeriod
import app.core.model.ConsumableProduct
import app.core.model.Entitlements
import app.core.model.Plan
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
    val plan: Plan,
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

data class PlanGroup(val plan: Plan, val options: List<PlanOption>)

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

    fun plan(plan: Plan): PlanGroup? = plans.firstOrNull { it.plan == plan }

    fun packsFor(item: WalletItem): List<PackOption> = packs.filter { it.item == item }

    fun option(key: String): PlanOption? = plans.asSequence().flatMap { it.options }.firstOrNull { it.key == key }

    fun pack(key: String): PackOption? = packs.firstOrNull { it.key == key }

    /** The default choice for [plan]: its "popular" period, else its first. */
    fun defaultOption(plan: Plan): PlanOption? =
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
    fun startOption(plan: Plan, current: Entitlements?, now: Instant): PlanOption? {
        val held = current(current, now)?.key
        val others = plan(plan)?.options?.filter { it.key != held }.orEmpty()
        return others.firstOrNull { it.badge == ProductBadge.POPULAR } ?: others.firstOrNull() ?: defaultOption(plan)
    }
}

/** The ids to ask the store for, per product type. Play's base plans share one product id. */
data class CatalogueQuery(val subscriptions: List<String>, val consumables: List<String>)

object CatalogueJoin {

    /** The paid plans, in the order a paywall shows them. */
    val PLANS: List<Plan> = listOf(Plan.Plus, Plan.Premium)

    fun query(server: StoreProducts): CatalogueQuery = CatalogueQuery(
        subscriptions = server.subscriptions.map { it.productId }.distinct(),
        consumables = server.consumables.map { it.productId }.distinct(),
    )

    /**
     * Joins [server]'s catalogue with the store's answers. Only entries the
     * store returned are kept, in the server's order; an entry whose plan,
     * period or item this build does not know is left out, and so is a Play
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
            .filter { it.plan in PLANS && it.period != BillingPeriod.Unknown }
            .mapNotNull { entry ->
                val product = subs.firstOrNull { it.id == entry.productId && it.basePlanId == entry.basePlanId } ?: return@mapNotNull null
                if (product.billingPeriod != null && product.billingPeriod != entry.period.wire) {
                    onMismatch("${entry.productId}:${entry.basePlanId}: the store says ${product.billingPeriod}, the catalogue ${entry.period.wire}")
                    return@mapNotNull null
                }
                PlanOption(entry.plan, entry.period, ProductBadge.of(entry.badge), entry.sort, product)
            }
            .sortedWith(compareBy<PlanOption> { it.sort }.thenBy { it.period.ordinal })
        val plans = PLANS.mapNotNull { plan -> options.filter { it.plan == plan }.takeIf { it.isNotEmpty() }?.let { PlanGroup(plan, it) } }

        val oneTime = consumables.filter { it.type == ProductType.ONE_TIME }
        val packs = server.consumables
            .filter { it.item != WalletItem.Unknown && it.quantity > 0 }
            .mapNotNull { entry -> oneTime.firstOrNull { it.id == entry.productId }?.let { PackOption(entry.item, entry.quantity, ProductBadge.of(entry.badge), entry.sort, it) } }
            .sortedWith(compareBy<PackOption> { it.item.ordinal }.thenBy { it.sort }.thenBy { it.quantity })
        return Catalogue(store, server.billingRef, plans, packs)
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
