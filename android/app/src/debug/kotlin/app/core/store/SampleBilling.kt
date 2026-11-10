package app.core.store

import androidx.activity.ComponentActivity
import app.core.model.BillingPeriod
import app.core.model.WalletItem
import app.core.net.SampleData
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * A store for the sample backend (**debug builds only**, next to
 * `SampleApi`): it sells the sample catalogue at made-up prices, in the
 * store's own format, with no store app on the phone. Its purchases carry
 * tokens the sample server recognises, so every purchase state can be
 * reached on purpose ([next]): paid, pending, cancelled, already owned, a
 * store failure, another account's, unconfirmed (with `SampleApi`'s
 * switches: slow, unreachable).
 */
class SampleBilling(override val store: Store) : StoreBilling {

    /** What the store says when the next purchase sheet closes. */
    enum class Outcome { PURCHASED, PENDING, CANCELLED, ALREADY_OWNED, STORE_FAILED, OTHER_ACCOUNT, INVALID }

    @Volatile var next: Outcome = Outcome.PURCHASED

    /** The store app missing, signed out, …: what [connect] answers instead of ready. */
    @Volatile var unavailable: BillingUnavailableReason? = null

    private val owned = mutableListOf<Pair<StorePurchase, ProductType>>()
    private var counter = 0
    private val updates = MutableSharedFlow<StorePurchase>(extraBufferCapacity = 8)
    override val unsolicitedPurchases: Flow<StorePurchase> = updates.asSharedFlow()

    /** The purchases the sheet opened, for a test to count: product ids in order. */
    val sheets = mutableListOf<String>()

    /**
     * Another account signed in to the store on this phone: it holds none of
     * the earlier one's purchases (a plan bought there is "held elsewhere").
     * With [holdingAnotherAccountsPlan], it holds a subscription of each of
     * the same products, bought by another account of the app (a store
     * account shared on one phone): the store's own list says the plan is
     * not this one's.
     */
    fun switchStoreAccount(holdingAnotherAccountsPlan: Boolean = false) {
        synchronized(owned) {
            val theirs = if (holdingAnotherAccountsPlan) {
                owned.filter { it.second == ProductType.SUBSCRIPTION }.map { (p, type) ->
                    p.copy(purchaseToken = "foreign-${p.purchaseToken}", orderId = "foreign-${p.orderId}", accountRef = OTHER_ACCOUNT_REF) to type
                }
            } else {
                emptyList()
            }
            owned.clear()
            owned += theirs
        }
    }

    /** The store no longer lists the purchases whose token starts with [prefix] (refunded, or used up on another phone). */
    fun removeOwned(prefix: String) {
        synchronized(owned) { owned.removeAll { it.first.purchaseToken.startsWith(prefix) } }
    }

    /** A pending purchase completing outside the app, as Play reports it. */
    suspend fun completePending(token: String) {
        val done = synchronized(owned) {
            val i = owned.indexOfFirst { it.first.purchaseToken == token }
            if (i < 0) return
            val paid = owned[i].first.copy(state = StorePurchaseState.PURCHASED, purchaseToken = token.removePrefix("pending-").let { "sample-$it" })
            owned[i] = paid to owned[i].second
            paid
        }
        updates.emit(done)
    }

    override suspend fun connect(): BillingAvailability =
        unavailable?.let { BillingAvailability.Unavailable(it) } ?: BillingAvailability.Ready

    override suspend fun products(type: ProductType, ids: List<String>): BillingResult<List<StoreProduct>> {
        unavailable?.let { return BillingResult.Failed(it) }
        val products = when (type) {
            ProductType.SUBSCRIPTION -> SampleData.subscriptions(store.id).filter { it.productId in ids }.map { s ->
                StoreProduct(
                    id = s.productId,
                    type = type,
                    title = s.productId,
                    description = "",
                    formattedPrice = price(s.plan, s.period),
                    priceMicros = micros(SampleData.plan(s.plan)?.toman?.get(s.period)),
                    currencyCode = if (store == Store.PLAY) "EUR" else null,
                    basePlanId = s.basePlanId,
                    // Play writes a year as P1Y; the server's catalogue says P12M.
                    billingPeriod = if (store == Store.PLAY) (if (s.period == BillingPeriod.Year) "P1Y" else s.period.wire) else null,
                    offerToken = s.basePlanId?.let { "offer-$it" },
                )
            }
            ProductType.ONE_TIME -> SampleData.consumables.filter { it.productId in ids }.map { c ->
                StoreProduct(
                    c.productId, type, c.productId, "", packPrice(c.item, c.quantity),
                    priceMicros = micros(SampleData.packToman(c.item, c.quantity)),
                    currencyCode = if (store == Store.PLAY) "EUR" else null,
                )
            }
        }
        return BillingResult.Ok(products)
    }

    override suspend fun purchase(
        activity: ComponentActivity,
        product: StoreProduct,
        accountToken: String,
        change: PlanChange?,
    ): PurchaseOutcome {
        unavailable?.let { return PurchaseOutcome.Failed(it) }
        sheets += product.id
        val n = ++counter
        // Play's token says nothing of the base plan (the server asks Google); the sample server reads it from here.
        val basePlan = product.basePlanId?.let { "$BASE_PLAN_MARK$it" }.orEmpty()
        fun made(prefix: String, state: StorePurchaseState): StorePurchase {
            val purchase = StorePurchase(
                store = store,
                productIds = listOf(product.id),
                purchaseToken = "$prefix-$n-${product.id}$basePlan",
                orderId = "sample-order-$n",
                purchaseTimeMillis = System.currentTimeMillis(),
                state = state,
                acknowledged = if (store == Store.PLAY) false else null,
                originalJson = """{"productId":"${product.id}","purchaseToken":"$prefix-$n","developerPayload":"$accountToken"}""",
                signature = "c2FtcGxlLXNpZ25hdHVyZS1ub3QtcmVhbA==",
                accountRef = accountToken,
            )
            synchronized(owned) { owned += purchase to product.type }
            return purchase
        }
        return when (next) {
            Outcome.PURCHASED -> PurchaseOutcome.Purchased(made("sample", StorePurchaseState.PURCHASED))
            Outcome.PENDING -> PurchaseOutcome.Pending(made("pending", StorePurchaseState.PENDING))
            Outcome.CANCELLED -> PurchaseOutcome.Cancelled
            Outcome.ALREADY_OWNED -> PurchaseOutcome.AlreadyOwned(product.id)
            Outcome.STORE_FAILED -> PurchaseOutcome.Failed(BillingUnavailableReason.ERROR, "sample")
            Outcome.OTHER_ACCOUNT -> PurchaseOutcome.Purchased(made("foreign", StorePurchaseState.PURCHASED))
            Outcome.INVALID -> PurchaseOutcome.Purchased(made("invalid", StorePurchaseState.PURCHASED))
        }
    }

    override suspend fun ownedPurchases(type: ProductType): BillingResult<List<StorePurchase>> {
        unavailable?.let { return BillingResult.Failed(it) }
        return BillingResult.Ok(synchronized(owned) { owned.filter { it.second == type }.map { it.first } })
    }

    override suspend fun consume(purchase: StorePurchase): ConsumeOutcome {
        synchronized(owned) { owned.removeAll { it.first.purchaseToken == purchase.purchaseToken } }
        return if (store == Store.PLAY) ConsumeOutcome.HandledByServer else ConsumeOutcome.Consumed
    }

    override fun disconnect() = Unit

    companion object {
        /** Before the base plan in a sample token: `sample-3-sub.plus~m3`. */
        const val BASE_PLAN_MARK = "~"

        /** The reference another account of the app bought with, in [switchStoreAccount]. */
        private const val OTHER_ACCOUNT_REF = "otheraccount2"
    }

    /** Made-up prices in each store's own style: Play in a currency, the other in toman, as its SDK writes them. */
    private fun price(plan: String, period: BillingPeriod): String =
        format(SampleData.plan(plan)?.toman?.get(period) ?: 100_000L)

    private fun packPrice(item: WalletItem, quantity: Int): String = format(SampleData.packToman(item, quantity))

    /** Play's price in micros of a euro; Cafe Bazaar gives none. */
    private fun micros(toman: Long?): Long? = if (store == Store.PLAY && toman != null) Math.round(euros(toman) * 1_000_000) else null

    private fun euros(toman: Long): Double = Math.round(toman / 360.0) / 100.0 - 0.01

    private fun format(toman: Long): String = if (store == Store.PLAY) {
        "€" + String.format(java.util.Locale.ROOT, "%.2f", euros(toman))
    } else {
        val digits = String.format(java.util.Locale.ROOT, "%,d", toman).replace(',', '٬')
        digits.map { if (it in '0'..'9') '۰' + (it - '0') else it }.joinToString("") + " تومان"
    }
}
