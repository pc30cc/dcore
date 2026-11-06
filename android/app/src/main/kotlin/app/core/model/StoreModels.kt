@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import java.time.Instant

// Products, purchases, restore and boosts (/v1/store/*, /v1/boosts). Prices
// are never on the wire: the app shows the store SDK's own price.

@Serializable
data class SubscriptionProduct(
    val productId: String,
    /** Play only: the base plan of the tier's subscription. */
    val basePlanId: String? = null,
    val plan: Plan = Plan.Unknown,
    val period: BillingPeriod = BillingPeriod.Unknown,
    val badge: String? = null,
    val sort: Int = 0,
)

@Serializable
data class ConsumableProduct(
    val productId: String,
    val item: WalletItem = WalletItem.Unknown,
    val quantity: Int = 1,
    val badge: String? = null,
    val sort: Int = 0,
)

/** The catalogue for the session's store only. */
@Serializable
data class StoreProducts(
    val store: StoreName = StoreName.Unknown,
    val billingRef: String = "",
    val subscriptions: List<SubscriptionProduct> = emptyList(),
    val consumables: List<ConsumableProduct> = emptyList(),
)

@Serializable
data class PlayPurchaseRequest(
    val productId: String,
    val purchaseToken: String,
    val kind: PurchaseKind,
)

@Serializable
data class BazaarPurchaseRequest(
    val productId: String,
    val purchaseToken: String,
    /** Signed by the store; checked on the server before any call to the store. */
    val originalJson: String,
    val signature: String,
    val kind: PurchaseKind,
)

/** A purchase body of either store, for restore: the Bazaar fields are set only for Bazaar purchases. */
@Serializable
data class RestorePurchase(
    val productId: String,
    val purchaseToken: String,
    val kind: PurchaseKind,
    val originalJson: String? = null,
    val signature: String? = null,
)

@Serializable
data class RestoreRequest(
    /** At most 20, and only tokens the app does not know the server has. */
    val purchases: List<RestorePurchase>,
)

/**
 * A purchase as the server recorded it. [state] is kept as the server's
 * string: only `pending` (nothing granted yet) has a fixed meaning here.
 */
@Serializable
data class PurchaseRecord(
    val id: Id? = null,
    val state: String,
    val productId: String? = null,
    val expiresAt: Instant? = null,
) {
    val pending: Boolean get() = state == PENDING

    companion object {
        const val PENDING = "pending"
    }
}

/** A verified purchase and the entitlements it left; `entitlements` is absent while pending. */
@Serializable
data class PurchaseResult(
    val purchase: PurchaseRecord,
    val entitlements: Entitlements? = null,
)

@Serializable
data class RestoredPurchase(
    val purchaseToken: String,
    val state: String,
)

@Serializable
data class RestoreResult(
    val results: List<RestoredPurchase> = emptyList(),
    val entitlements: Entitlements = Entitlements(),
)

@Serializable
data class BoostRequest(val kind: BoostKind)

@Serializable
data class BoostStarted(val endsAt: Instant)
