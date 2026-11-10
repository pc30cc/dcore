@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import java.time.Instant

// Products, purchases, restore and boosts (/v1/store/*, /v1/boosts). Prices
// are never on the wire: the app shows the store SDK's own price.

/**
 * Plans are named by string keys the admin panel makes (`plus`, `gold_summer`):
 * the app never holds a closed list of them, so a key from a newer server
 * is a plan like any other. Only the free plan has a fixed key.
 */
object PlanKey {
    const val FREE: String = "free"

    /** A paid plan: any key but the free one. */
    fun isPaid(key: String?): Boolean = !key.isNullOrBlank() && key != FREE
}

/** A plan's switches as the server sends them (`plan_features` booleans); calls are open unless turned off. */
@Serializable
data class PlanFlags(
    @SerialName("see_likes") val seeLikes: Boolean = false,
    val rewind: Boolean = false,
    @SerialName("read_receipts") val readReceipts: Boolean = false,
    val incognito: Boolean = false,
    @SerialName("travel_mode") val travelMode: Boolean = false,
    @SerialName("advanced_filters") val advancedFilters: Boolean = false,
    @SerialName("profile_views") val profileViews: Boolean = false,
    @SerialName("second_look") val secondLook: Boolean = false,
    @SerialName("priority_likes") val priorityLikes: Boolean = false,
    @SerialName("audio_calls") val audioCalls: Boolean = true,
    @SerialName("video_calls") val videoCalls: Boolean = true,
)

/** A plan's quotas (-1 is unlimited, 0 gives none). */
@Serializable
data class PlanQuotas(
    @SerialName("daily_likes") val dailyLikes: Int = 0,
    @SerialName("weekly_superlikes") val weeklySuperlikes: Int = 0,
    @SerialName("daily_dm") val dailyDm: Int = 0,
    @SerialName("weekly_dm_gift") val weeklyDmGift: Int = 0,
    @SerialName("monthly_boosts") val monthlyBoosts: Int = 0,
) {
    companion object {
        const val UNLIMITED: Int = -1
    }
}

/**
 * A plan on sale in the session's store: its name and description in the
 * session's language (the server picks it from `Accept-Language`), its
 * upgrade [rank] (higher is better), its display [sort], an optional badge
 * and what it gives. Its periods are the [SubscriptionProduct]s naming its key.
 */
@Serializable
data class StorePlan(
    val key: String,
    val rank: Int = 0,
    val sort: Int = 0,
    val name: String = "",
    val description: String? = null,
    val badge: String? = null,
    val features: PlanFlags = PlanFlags(),
    val quotas: PlanQuotas = PlanQuotas(),
)

@Serializable
data class SubscriptionProduct(
    val productId: String,
    /** Play only: the base plan of the tier's subscription. */
    val basePlanId: String? = null,
    /** The [StorePlan.key] this period belongs to. */
    val plan: String = "",
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
    /** The plans with at least one subscription below, by `sort`; empty from a server older than plans. */
    val plans: List<StorePlan> = emptyList(),
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
    /**
     * This restore granted or credited the token for the first time (it was
     * new to the server, pending or unclaimed). Null from a server that does
     * not say.
     */
    val fresh: Boolean? = null,
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
