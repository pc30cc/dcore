package app.core.billing

import androidx.activity.ComponentActivity
import app.core.model.BillingPeriod
import app.core.model.BoostKind
import app.core.model.BoostStarted
import app.core.model.ConsumableProduct
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.model.PurchaseRecord
import app.core.model.PurchaseResult
import app.core.model.RestorePurchase
import app.core.model.RestoreResult
import app.core.model.RestoredPurchase
import app.core.model.StoreName
import app.core.model.StoreProducts
import app.core.model.SubscriptionProduct
import app.core.model.WalletItem
import app.core.net.ApiError
import app.core.store.BillingAvailability
import app.core.store.BillingResult
import app.core.store.ConsumeOutcome
import app.core.store.PlanChange
import app.core.store.ProductType
import app.core.store.PurchaseOutcome
import app.core.store.Store
import app.core.store.StoreBilling
import app.core.store.StoreProduct
import app.core.store.StorePurchase
import app.core.store.StorePurchaseState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import java.io.IOException
import java.time.Instant

/** A store for the tests: products, owned purchases and the next purchase sheet's answer, all set by the test. */
class FakeBilling(override val store: Store) : StoreBilling {
    var availability: BillingAvailability = BillingAvailability.Ready
    val products = mutableListOf<StoreProduct>()
    val owned = mutableListOf<Pair<StorePurchase, ProductType>>()
    var next: (StoreProduct) -> PurchaseOutcome = { product -> PurchaseOutcome.Purchased(purchase(product.id, "tok-${product.id}")) }
    var consumeAnswer: () -> ConsumeOutcome = { if (store == Store.PLAY) ConsumeOutcome.HandledByServer else ConsumeOutcome.Consumed }
    val sheets = mutableListOf<Pair<String, String>>()
    val changes = mutableListOf<PlanChange?>()
    val consumed = mutableListOf<String>()
    val updates = MutableSharedFlow<StorePurchase>(extraBufferCapacity = 8)
    val statusChanges = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    var ownedQueries = 0
    var connects = 0

    /** Runs before each owned-purchases answer, with its number (1 for the first): a store whose list catches up. */
    var onOwnedQuery: (Int) -> Unit = {}

    override val unsolicitedPurchases: Flow<StorePurchase> = updates
    override val subscriptionStatusChanges: Flow<Unit> = statusChanges

    /** A purchase as the store reports it; [accountRef] is the reference it was bought with (this account's by default). */
    fun purchase(
        productId: String,
        token: String,
        state: StorePurchaseState = StorePurchaseState.PURCHASED,
        accountRef: String? = FakeStoreApi.BILLING_REF,
        suspended: Boolean = false,
        purchaseTimeMillis: Long = 1_000L,
    ) = StorePurchase(
        store = store,
        productIds = listOf(productId),
        purchaseToken = token,
        orderId = "order-$token",
        purchaseTimeMillis = purchaseTimeMillis,
        state = state,
        acknowledged = if (store == Store.PLAY) false else null,
        originalJson = """{"purchaseToken":"$token"}""",
        signature = "c2lnbmF0dXJlLW9mLXRoZS10ZXN0",
        accountRef = accountRef,
        suspended = suspended,
    )

    override suspend fun connect(): BillingAvailability {
        connects++
        return availability
    }

    override suspend fun products(type: ProductType, ids: List<String>): BillingResult<List<StoreProduct>> {
        (availability as? BillingAvailability.Unavailable)?.let { return BillingResult.Failed(it.reason) }
        return BillingResult.Ok(products.filter { it.type == type && it.id in ids })
    }

    override suspend fun purchase(activity: ComponentActivity, product: StoreProduct, accountToken: String, change: PlanChange?): PurchaseOutcome {
        sheets += product.id to accountToken
        changes += change
        return next(product)
    }

    override suspend fun ownedPurchases(type: ProductType): BillingResult<List<StorePurchase>> {
        ownedQueries++
        onOwnedQuery(ownedQueries)
        (availability as? BillingAvailability.Unavailable)?.let { return BillingResult.Failed(it.reason) }
        return BillingResult.Ok(owned.filter { it.second == type }.map { it.first })
    }

    override suspend fun consume(purchase: StorePurchase): ConsumeOutcome {
        val answer = consumeAnswer()
        if (answer == ConsumeOutcome.Consumed) {
            consumed += purchase.purchaseToken
            owned.removeAll { it.first.purchaseToken == purchase.purchaseToken }
        }
        return answer
    }

    override fun disconnect() = Unit
}

/** The server's store routes for the tests: answers by token, every call recorded. */
class FakeStoreApi(private val store: Store) : StoreApi {
    val submitted = mutableListOf<String>()
    val restored = mutableListOf<List<String>>()
    var productsCalls = 0
    var boosts = 0

    /** No answer at all (no network) while true. */
    var offline = false

    /** Whether the restore answer says `fresh` per token (false: a server from before the flag). */
    var saysFresh = true

    /** The server's verdict per token: a state, or one of the problems below. */
    val verdicts = mutableMapOf<String, String>()
    val granted = mutableSetOf<String>()
    var entitlements = Entitlements()
    var catalogue: StoreProducts = catalogueOf(store)
    var boostAnswer: () -> BoostStarted = { BoostStarted(Instant.parse("2026-11-09T08:30:00Z")) }

    override suspend fun products(): StoreProducts {
        productsCalls++
        if (offline) throw ApiError.Network(IOException("offline"))
        return catalogue
    }

    /** Runs as each purchase reaches the server (a test's moment "while the server is asked"). */
    var onSubmit: () -> Unit = {}

    override suspend fun submit(purchase: QueuedPurchase): PurchaseResult {
        submitted += purchase.token
        onSubmit()
        if (offline) throw ApiError.Network(IOException("offline"))
        return when (val verdict = verdicts[purchase.token] ?: "active") {
            "pending" -> PurchaseResult(PurchaseRecord(state = PurchaseRecord.PENDING))
            "other_account" -> throw ApiError.Http(409, app.core.model.Problem.of(409, "purchase_other_account"))
            "invalid" -> throw ApiError.Http(422, app.core.model.Problem.of(422, "purchase_invalid"))
            "store_unavailable" -> throw ApiError.Http(503, app.core.model.Problem.of(503, "store_unavailable"))
            "upgrade_required" -> throw ApiError.Http(426, app.core.model.Problem.of(426, "upgrade_required"))
            "not_found" -> throw ApiError.Http(404, app.core.model.Problem.of(404, "not_found"))
            else -> {
                // The server records a token once: the same answer, never a second credit; only a state that gives access grants.
                if (verdict in Purchases.GRANTING && granted.add(purchase.token)) grant(purchase.productId)
                PurchaseResult(PurchaseRecord("1", verdict, purchase.productId), entitlements)
            }
        }
    }

    override suspend fun restore(purchases: List<RestorePurchase>): RestoreResult {
        restored += purchases.map { it.purchaseToken }
        if (offline) throw ApiError.Network(IOException("offline"))
        val results = purchases.map { p ->
            val verdict = verdicts[p.purchaseToken] ?: if (p.kind == app.core.model.PurchaseKind.Consumable) "purchased" else "active"
            // `fresh`: this call is the one that granted it (never a token granted before, by any route).
            val first = verdict in Purchases.GRANTING && granted.add(p.purchaseToken)
            if (first) grant(p.productId)
            RestoredPurchase(p.purchaseToken, verdict, fresh = first.takeIf { saysFresh })
        }
        return RestoreResult(results, entitlements)
    }

    override suspend fun boost(kind: BoostKind): BoostStarted {
        boosts++
        if (offline) throw ApiError.Network(IOException("offline"))
        return boostAnswer()
    }

    private fun grant(productId: String) {
        val sub = catalogue.subscriptions.firstOrNull { it.productId == productId }
        val pack = catalogue.consumables.firstOrNull { it.productId == productId }
        entitlements = when {
            sub != null -> entitlements.copy(plan = sub.plan, source = if (store == Store.PLAY) app.core.model.EntitlementSource.Play else app.core.model.EntitlementSource.Bazaar)
            pack?.item == WalletItem.Superlike -> entitlements.copy(wallet = entitlements.wallet.copy(superlike = entitlements.wallet.superlike + pack.quantity))
            pack?.item == WalletItem.Boost -> entitlements.copy(wallet = entitlements.wallet.copy(boost = entitlements.wallet.boost + pack.quantity))
            else -> entitlements
        }
    }

    companion object {
        /** The account's reference in [catalogueOf]: what its purchases carry. */
        const val BILLING_REF = "k7wq2m4zx5p3a"

        fun catalogueOf(store: Store): StoreProducts = if (store == Store.PLAY) {
            StoreProducts(
                store = StoreName.Play,
                billingRef = BILLING_REF,
                subscriptions = listOf(
                    SubscriptionProduct("sub.plus", "m1", Plan.Plus, BillingPeriod.Month, "popular", 11),
                    SubscriptionProduct("sub.plus", "m3", Plan.Plus, BillingPeriod.ThreeMonths, "best_value", 12),
                    SubscriptionProduct("sub.premium", "m1", Plan.Premium, BillingPeriod.Month, null, 21),
                ),
                consumables = listOf(ConsumableProduct("cons.superlike.5", WalletItem.Superlike, 5, null, 30)),
            )
        } else {
            StoreProducts(
                store = StoreName.Bazaar,
                billingRef = BILLING_REF,
                subscriptions = listOf(
                    SubscriptionProduct("sub.plus.1m", null, Plan.Plus, BillingPeriod.Month, "popular", 11),
                    SubscriptionProduct("sub.premium.1m", null, Plan.Premium, BillingPeriod.Month, null, 21),
                ),
                consumables = listOf(ConsumableProduct("cons.superlike.5", WalletItem.Superlike, 5, null, 30)),
            )
        }

        /** What each store returns for [catalogueOf]. */
        fun storeProducts(store: Store): List<StoreProduct> = if (store == Store.PLAY) {
            listOf(
                StoreProduct("sub.plus", ProductType.SUBSCRIPTION, "Plus", "", "€4.99", 4_990_000, "EUR", offerToken = "o-m1", basePlanId = "m1", billingPeriod = "P1M"),
                StoreProduct("sub.plus", ProductType.SUBSCRIPTION, "Plus", "", "€12.99", 12_990_000, "EUR", offerToken = "o-m3", basePlanId = "m3", billingPeriod = "P3M"),
                StoreProduct("sub.premium", ProductType.SUBSCRIPTION, "Premium", "", "€9.99", 9_990_000, "EUR", offerToken = "o-pm1", basePlanId = "m1", billingPeriod = "P1M"),
                StoreProduct("cons.superlike.5", ProductType.ONE_TIME, "5", "", "€2.99", 2_990_000, "EUR"),
            )
        } else {
            listOf(
                StoreProduct("sub.plus.1m", ProductType.SUBSCRIPTION, "Plus", "", "۱۲۰٬۰۰۰ تومان"),
                StoreProduct("sub.premium.1m", ProductType.SUBSCRIPTION, "Premium", "", "۲۴۰٬۰۰۰ تومان"),
                StoreProduct("cons.superlike.5", ProductType.ONE_TIME, "5", "", "۶۰٬۰۰۰ تومان"),
            )
        }
    }
}
