package app.core.store

import androidx.activity.ComponentActivity
import kotlinx.coroutines.flow.Flow

/**
 * In-app payments through the store the app was installed from.
 *
 * **The server is the only source of entitlements.** What this
 * interface reports is what the STORE says; nothing it returns grants a
 * subscription or a pack. Every [StorePurchase] must be sent to the server,
 * which verifies it with the store (Google Play Developer API, Cafe Bazaar's
 * Pardakht API), records it idempotently and returns the entitlements; only
 * then is a Play purchase acknowledged (by the server) and a consumable
 * consumed ([consume]).
 *
 * NOT WIRED YET: the server's verification endpoints
 * (`POST /store/google/purchases`, and a Cafe Bazaar counterpart) do not exist,
 * so no screen calls [purchase] yet and the paywall is not built. Until the
 * server acknowledges them, Play refunds a purchase after three days, so test
 * only with license testers.
 *
 * Product ids are neutral and identical in both stores (`sub.plus.1m`,
 * `cons.boost.1`, …), see [ProductIds].
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
     */
    suspend fun purchase(activity: ComponentActivity, product: StoreProduct, accountToken: String): PurchaseOutcome

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

    /** Releases the store connection. */
    fun disconnect()
}

/** The neutral product ids, the same in both stores and never a brand. */
object ProductIds {
    val subscriptions: List<String> = listOf(
        "sub.plus.1w", "sub.plus.1m", "sub.plus.3m", "sub.plus.6m",
        "sub.premium.1w", "sub.premium.1m", "sub.premium.3m", "sub.premium.6m",
    )
    val consumables: List<String> = listOf(
        "cons.superlike.5", "cons.superlike.15", "cons.superlike.30",
        "cons.boost.1", "cons.boost.5", "cons.boost.10",
        "cons.spotlight.1", "cons.dm.5",
    )
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
 * A product as the store shows it.
 *
 * [priceMicros] and [currencyCode] are null where the store does not give them
 * (Cafe Bazaar returns a formatted price only). [offerToken] is Play's token
 * for the subscription offer the purchase sheet should show; which offer
 * (trial, intro price) is the paywall's decision and is not made yet, so the
 * base plan's is used.
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
