package app.core.billing

import app.core.model.Entitlements
import app.core.store.PlanChangeKind
import app.core.store.Store
import app.core.store.StoreProduct
import app.core.store.StorePurchase
import app.core.store.StorePurchaseState
import java.time.Instant

/**
 * A Play subscription bought while one runs: which owned one it replaces,
 * and how.
 *
 * The store account on a phone can hold subscriptions of several accounts
 * of the app (a shared phone), and an account can hold a cancelled one of
 * another plan that has not ended yet. Replacing a token ends it for the
 * account the server recorded it for, so only the subscription behind this
 * account's own plan is ever replaced.
 */
internal object PlanChanges {

    /**
     * The owned subscription behind [plan] for the account whose reference
     * is [billingRef]: paid, not on hold or paused, bought with that
     * reference, of [productId] when the server names the plan's product,
     * else of a product the catalogue sells as [plan] ([planOf]). The latest
     * when several are; null when none is (nothing is replaced then).
     */
    fun backing(
        owned: List<StorePurchase>,
        plan: String,
        billingRef: String,
        planOf: (String) -> String?,
        productId: String? = null,
    ): StorePurchase? {
        if (billingRef.isEmpty()) return null
        return owned
            .filter { p ->
                p.state == StorePurchaseState.PURCHASED && !p.suspended && p.accountRef == billingRef &&
                    p.productIds.size == 1 &&
                    (if (productId != null) p.productIds.first() == productId else planOf(p.productIds.first()) == plan)
            }
            .maxByOrNull { it.purchaseTimeMillis }
    }

    /**
     * Whether the plan [current] shows, from [store], is held on another
     * store account than the one on this phone: a plan not past its end at
     * [now] ([runningStorePlan]) whose product the server names, the store
     * answered ([owned]; null when it could not be asked), and nothing the
     * store lists of that product can be this account's (bought with
     * [billingRef], or with no reference at all). No second subscription is
     * sold then; the plan is changed from the account that holds it.
     *
     * Cafe Bazaar's list can come back empty or short for the very account
     * that holds the plan (Poolakey #75 after a sign-in; entries failing its
     * local signature check are dropped), so there only a token of the
     * product bought with another reference says so. Its lock on a second
     * subscription stops the sale either way.
     */
    fun heldElsewhere(store: Store, current: Entitlements?, owned: List<StorePurchase>?, billingRef: String, now: Instant): Boolean {
        if (current == null || owned == null || !current.runningStorePlan(store, now)) return false
        val productId = current.productId ?: return false
        val ofProduct = owned.filter { productId in it.productIds && it.state != StorePurchaseState.REFUNDED }
        if (ofProduct.any { p -> p.accountRef == null || billingRef.isEmpty() || p.accountRef == billingRef }) return false
        return store != Store.BAZAAR || ofProduct.isNotEmpty()
    }

    /**
     * The base plans whose price is the bar for [costsMorePerUnitOfTime]:
     * the one the person is on when the server names it ([heldBasePlan]),
     * else (a Play purchase does not say which base plan it is on) every base
     * plan the catalogue sells of the owned product, [ownedOptions]. A named
     * base plan the catalogue does not sell has no price here: nothing is the
     * bar, so the change credits the time left, which Play takes between any
     * two products.
     */
    fun bar(ownedOptions: List<PlanOption>, heldBasePlan: String?): List<PlanOption> =
        if (heldBasePlan == null) ownedOptions else ownedOptions.filter { it.product.basePlanId == heldBasePlan }

    /**
     * How [target] replaces the owned subscription of [ownedProductId] (on
     * [currentPlan]); [ownedOptions] are the base plans whose price is the
     * bar ([bar]), with the store's prices; [rankOf] is the server's upgrade
     * rank of a plan key, null when it is not known.
     *
     * - another base plan of the same subscription: [PlanChangeKind.CHARGE_FULL]
     *   (between base plans of one subscription Play takes only that or
     *   `WITHOUT_PRORATION`);
     * - a lower tier (both ranks known): [PlanChangeKind.AT_RENEWAL];
     * - otherwise [PlanChangeKind.CHARGE_DIFFERENCE] when [target] costs more
     *   per unit of time (the only case Play takes it in), else
     *   [PlanChangeKind.CREDIT_TIME] (a higher tier on a longer, cheaper
     *   per-week period, or prices that cannot be compared).
     */
    fun kind(
        currentPlan: String,
        ownedProductId: String,
        ownedOptions: List<PlanOption>,
        target: PlanOption,
        rankOf: (String) -> Int?,
    ): PlanChangeKind = when {
        target.productId == ownedProductId -> PlanChangeKind.CHARGE_FULL
        lower(rankOf(target.plan), rankOf(currentPlan)) -> PlanChangeKind.AT_RENEWAL
        costsMorePerUnitOfTime(ownedOptions, target) -> PlanChangeKind.CHARGE_DIFFERENCE
        else -> PlanChangeKind.CREDIT_TIME
    }

    /**
     * Whether [target] costs more per unit of time than any of [owned] does:
     * the base plan the person is on, or, when that is not known, the dearest
     * of the owned product's base plans ([bar]). A month is read as 28 to 31
     * days and a year as 365 to 366, and the target must be dearer on every
     * reading, so the answer does not depend on how the store counts them.
     * False when a price, a currency or a period is missing or they differ.
     */
    fun costsMorePerUnitOfTime(owned: List<PlanOption>, target: PlanOption): Boolean {
        if (owned.isEmpty()) return false
        val currency = target.product.currencyCode ?: return false
        val targetCheapest = perDay(target.product, longestReading = true) ?: return false
        var ownedDearest = 0.0
        for (option in owned) {
            if (option.product.currencyCode != currency) return false
            val rate = perDay(option.product, longestReading = false) ?: return false
            ownedDearest = maxOf(ownedDearest, rate)
        }
        return targetCheapest > ownedDearest
    }

    /** Price per day in micros, over the longest or the shortest reading of the product's period. */
    private fun perDay(product: StoreProduct, longestReading: Boolean): Double? {
        val micros = product.priceMicros?.takeIf { it > 0 } ?: return null
        val days = periodDays(product.billingPeriod ?: return null) ?: return null
        return micros.toDouble() / if (longestReading) days.last else days.first
    }

    private val PERIOD = Regex("""^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$""")

    /** The days an ISO 8601 period (`P1W`, `P3M`, `P1Y`) can span, shortest to longest; null when it is not one. */
    fun periodDays(period: String): IntRange? {
        val m = PERIOD.matchEntire(period) ?: return null
        val (y, mo, w, d) = m.destructured.toList().map { it.toIntOrNull() ?: 0 }
        val shortest = y * 365 + mo * 28 + w * 7 + d
        val longest = y * 366 + mo * 31 + w * 7 + d
        return if (shortest <= 0) null else shortest..longest
    }

    private fun lower(target: Int?, current: Int?): Boolean = target != null && current != null && target < current
}
