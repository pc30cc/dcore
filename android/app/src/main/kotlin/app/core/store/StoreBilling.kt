package app.core.store

import android.app.Activity
import androidx.activity.ComponentActivity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

/**
 * In-app payments through the store the app was installed from.
 *
 * **The server is the only source of entitlements.** What this
 * interface reports is what the STORE says; nothing it returns grants a
 * subscription or a pack. Every [StorePurchase] goes to the server
 * (`POST /v1/store/{play,bazaar}/purchases`, `app.core.billing`), which
 * verifies it with the store, records it once by its token and returns the
 * entitlements; only then is a Play purchase acknowledged (by the server) and
 * a Cafe Bazaar pack consumed here ([consume]).
 *
 * Which products exist, in which order and with which badge, is the server's
 * catalogue (`GET /v1/store/products`); their prices are the store's own
 * ([StoreProduct.formattedPrice]), never the server's.
 */
interface StoreBilling {
    val store: Store

    /** Connects to the store's billing service, or says why it cannot. Safe to call repeatedly. */
    suspend fun connect(): BillingAvailability

    /** The products' store-side details (localised title and price) for [ids] of one [type]. */
    suspend fun products(type: ProductType, ids: List<String>): BillingResult<List<StoreProduct>>

    /**
     * Opens the store's purchase sheet for [product].
     *
     * [accountToken] ties the purchase to the account: the server's opaque
     * token for this user (Play's `obfuscatedAccountId`, Cafe Bazaar's
     * developer payload). Never an email, phone number or raw user id.
     *
     * [change]: the subscription this one replaces (Play's upgrade and
     * downgrade); stores that cannot replace one ignore it.
     */
    suspend fun purchase(
        activity: ComponentActivity,
        product: StoreProduct,
        accountToken: String,
        change: PlanChange? = null,
    ): PurchaseOutcome

    /** What the store says this account owns of [type]: for restore, and for purchases a crash left unsent. */
    suspend fun ownedPurchases(type: ProductType): BillingResult<List<StorePurchase>>

    /**
     * Purchases the store reports outside a [purchase] call: a pending
     * purchase completing later, or one finished in the store itself. Each
     * goes to the server like any other.
     */
    val unsolicitedPurchases: Flow<StorePurchase>

    /** Uses up a consumable once the SERVER has credited it. */
    suspend fun consume(purchase: StorePurchase): ConsumeOutcome

    /**
     * The store's own messages for the person (Play: a declined renewal
     * payment, a price change to accept), shown over [activity] when there
     * are any. Stores without them do nothing.
     */
    fun showStoreMessages(activity: Activity) = Unit

    /**
     * The store says a subscription's status moved from one of its messages
     * ([showStoreMessages]; Play: the person fixed a declined payment). Its
     * token is worth sending to the server again, which asks the store anew
     * for a subscription it holds as on hold, paused or expired. Stores
     * without such messages never emit.
     */
    val subscriptionStatusChanges: Flow<Unit> get() = emptyFlow()

    /** Releases the store connection. */
    fun disconnect()
}

/** A subscription bought in place of the one the person has ([oldPurchaseToken]). */
data class PlanChange(val oldPurchaseToken: String, val kind: PlanChangeKind)

/**
 * How a replaced subscription gives way, by its effect. Play accepts each
 * only in some changes (developer.android.com/google/play/billing/subscriptions,
 * "Replacement modes" and "Set the replacement mode for a purchase"); the
 * caller picks one that applies.
 */
enum class PlanChangeKind {
    /**
     * At once, the billing date kept, the difference for the rest of the
     * period charged now (Play: `CHARGE_PRORATED_PRICE`). Only for another
     * subscription that costs more per unit of time.
     */
    CHARGE_DIFFERENCE,

    /**
     * At once, the value of the time left credited toward the new one, which
     * moves its first billing date (Play: `WITH_TIME_PRORATION`). Any change
     * between two subscription products.
     */
    CREDIT_TIME,

    /** At the next renewal; the old one runs out first (Play: `DEFERRED`). */
    AT_RENEWAL,

    /**
     * At once, the new one charged in full, the value of the time left
     * carried over (Play: `CHARGE_FULL_PRICE`). Between base plans of one
     * subscription, Play accepts only this or `WITHOUT_PRORATION`.
     */
    CHARGE_FULL,
}

enum class ProductType { SUBSCRIPTION, ONE_TIME }

sealed interface BillingAvailability {
    data object Ready : BillingAvailability

    data class Unavailable(val reason: BillingUnavailableReason, val detail: String? = null) : BillingAvailability
}

enum class BillingUnavailableReason {
    /** The store app is not on the phone. */
    STORE_NOT_INSTALLED,

    /** The store app is too old, or the person is not signed in to it. */
    STORE_NOT_READY,

    /** The store does not support this kind of purchase here (country, device, account). */
    NOT_SUPPORTED,

    /** The billing service could not be reached right now; worth a retry. */
    SERVICE_UNAVAILABLE,

    /** Anything else. */
    ERROR,
}

/** A store answer, or why there is none. */
sealed interface BillingResult<out T> {
    data class Ok<T>(val value: T) : BillingResult<T>

    data class Failed(val reason: BillingUnavailableReason, val detail: String? = null) : BillingResult<Nothing>
}

/**
 * A product as the store shows it: one per Play base plan, one per Cafe
 * Bazaar product.
 *
 * Product ids are neutral and never a brand (`sub.plus`, `sub.plus.1m`,
 * `cons.boost.5`). [basePlanId] and [billingPeriod] (ISO 8601, `P1M`) are
 * Play's; Cafe Bazaar has neither. [priceMicros] and [currencyCode] are null
 * where the store does not give them (Cafe Bazaar returns a formatted price
 * only). [offerToken] is Play's token for the offer the purchase sheet shows:
 * the base plan's own (no trial or intro offer at launch).
 */
data class StoreProduct(
    val id: String,
    val type: ProductType,
    val title: String,
    val description: String,
    val formattedPrice: String,
    val priceMicros: Long? = null,
    val currencyCode: String? = null,
    val offerToken: String? = null,
    val basePlanId: String? = null,
    val billingPeriod: String? = null,
)

/** A purchase as the store reported it. Unverified until the server says otherwise. */
data class StorePurchase(
    val store: Store,
    val productIds: List<String>,
    /** What the server verifies with the store. Never logged. */
    val purchaseToken: String,
    val orderId: String?,
    val purchaseTimeMillis: Long,
    val state: StorePurchaseState,
    /** Play: whether the purchase is acknowledged (by the server). Null for stores without the notion. */
    val acknowledged: Boolean?,
    /** The store's raw purchase JSON and its signature, for the server's check. */
    val originalJson: String,
    val signature: String?,
    /**
     * The account reference it was bought with (Play's `obfuscatedAccountId`,
     * Cafe Bazaar's payload: the server's `billingRef`), or null when the store
     * has none. Several accounts of the app can share one store account.
     */
    val accountRef: String? = null,
    /** Play: a subscription on hold or paused (its payment needs fixing); it gives nothing. */
    val suspended: Boolean = false,
)

enum class StorePurchaseState { PURCHASED, PENDING, REFUNDED, UNKNOWN }

sealed interface PurchaseOutcome {
    /** The store says it is paid. Send it to the server; grant nothing yet. */
    data class Purchased(val purchase: StorePurchase) : PurchaseOutcome

    /** Payment is pending (cash, bank transfer). It arrives later through [StoreBilling.unsolicitedPurchases]. */
    data class Pending(val purchase: StorePurchase) : PurchaseOutcome

    data object Cancelled : PurchaseOutcome

    data class AlreadyOwned(val productId: String) : PurchaseOutcome

    data class Failed(val reason: BillingUnavailableReason, val detail: String? = null) : PurchaseOutcome
}

sealed interface ConsumeOutcome {
    data object Consumed : ConsumeOutcome

    /** The store's server-side API consumes it (Google Play): nothing for the app to do. */
    data object HandledByServer : ConsumeOutcome

    data class Failed(val detail: String?) : ConsumeOutcome
}
