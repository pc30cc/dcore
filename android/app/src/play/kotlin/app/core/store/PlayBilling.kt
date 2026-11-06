package app.core.store

import android.content.Context
import androidx.activity.ComponentActivity
import app.core.diag.Diag
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import com.android.billingclient.api.BillingResult as PlayResult

/**
 * Google Play Billing (Play Billing Library 9).
 *
 * Implemented: connecting (with the library's automatic reconnection),
 * product details, the purchase sheet with the account's obfuscated id,
 * pending purchases, owned purchases and the stream of purchases that arrive
 * outside a flow.
 *
 * NOT done here, by design: acknowledging and consuming. The server
 * verifies each purchase token with the Google Play Developer API, records it,
 * acknowledges it (within three days, or Play refunds it) and consumes packs.
 * That server endpoint (`POST /store/google/purchases`) does not exist yet, so
 * no screen starts a purchase. Which subscription offer (trial, intro price)
 * to show is the paywall's decision and is not made yet: [products] picks each
 * subscription's base plan.
 */
internal class PlayBilling(
    context: Context,
    private val info: PlayStoreInfo,
    private val diag: Diag,
) : StoreBilling {

    override val store: Store = Store.PLAY

    private val appContext = context.applicationContext

    private val updates = MutableSharedFlow<StorePurchase>(extraBufferCapacity = 16)
    override val unsolicitedPurchases: Flow<StorePurchase> = updates.asSharedFlow()

    private val inFlightLock = Any()
    private var inFlight: CompletableDeferred<Pair<PlayResult, List<Purchase>?>>? = null

    /**
     * Every purchase update: the answer to the flow in progress if there is
     * one still waiting, otherwise one that arrived on its own (a pending
     * purchase completing, a flow whose screen has gone).
     */
    private val listener = PurchasesUpdatedListener { result, purchases ->
        val waiting = synchronized(inFlightLock) { inFlight.also { inFlight = null } }
        val delivered = waiting?.complete(result to purchases) == true
        if (!delivered && result.responseCode == BillingResponseCode.OK) {
            purchases.orEmpty().forEach { updates.tryEmit(it.toStorePurchase()) }
        }
    }

    private val client: BillingClient = BillingClient.newBuilder(appContext)
        .setListener(listener)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
        .enableAutoServiceReconnection()
        .build()

    /** Product details by id, from the last [products] call: what a purchase sheet is opened with. */
    private val details = ConcurrentHashMap<String, ProductDetails>()

    private val connectLock = Mutex()
    private val purchaseLock = Mutex()

    override suspend fun connect(): BillingAvailability = connectLock.withLock {
        // First, and every time: the Play Store can be disabled or removed
        // while the app runs, and "not installed" is the one answer a person
        // can act on.
        if (!info.isStoreInstalled(appContext)) {
            return@withLock BillingAvailability.Unavailable(BillingUnavailableReason.STORE_NOT_INSTALLED)
        }
        if (client.isReady) return@withLock BillingAvailability.Ready
        suspendCancellableCoroutine { continuation ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: PlayResult) {
                    if (!continuation.isActive) return
                    continuation.resume(
                        if (result.responseCode == BillingResponseCode.OK) {
                            BillingAvailability.Ready
                        } else {
                            diag.info(AREA, "setup failed: ${result.responseCode}")
                            BillingAvailability.Unavailable(reasonOf(result.responseCode), result.debugMessage)
                        },
                    )
                }

                override fun onBillingServiceDisconnected() {
                    if (continuation.isActive) {
                        continuation.resume(BillingAvailability.Unavailable(BillingUnavailableReason.SERVICE_UNAVAILABLE, "disconnected"))
                    }
                }
            })
        }
    }

    override suspend fun products(type: ProductType, ids: List<String>): BillingResult<List<StoreProduct>> {
        if (ids.isEmpty()) return BillingResult.Ok(emptyList())
        unavailable()?.let { return it }
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                ids.map { id ->
                    QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(type.play).build()
                },
            )
            .build()
        val result = client.queryProductDetails(params)
        if (result.billingResult.responseCode != BillingResponseCode.OK) {
            return BillingResult.Failed(reasonOf(result.billingResult.responseCode), result.billingResult.debugMessage)
        }
        val found = result.productDetailsList.orEmpty()
        found.forEach { details[it.productId] = it }
        return BillingResult.Ok(found.mapNotNull { it.toStoreProduct(type) })
    }

    override suspend fun purchase(activity: ComponentActivity, product: StoreProduct, accountToken: String): PurchaseOutcome =
        purchaseLock.withLock {
            if (accountToken.length > MAX_ACCOUNT_ID) {
                return@withLock PurchaseOutcome.Failed(BillingUnavailableReason.ERROR, "account token longer than $MAX_ACCOUNT_ID characters")
            }
            when (val availability = connect()) {
                BillingAvailability.Ready -> Unit
                is BillingAvailability.Unavailable -> return@withLock PurchaseOutcome.Failed(availability.reason, availability.detail)
            }
            val productDetails = details[product.id]
                ?: return@withLock PurchaseOutcome.Failed(BillingUnavailableReason.ERROR, "no product details: call products() first")
            val item = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(productDetails)
            product.offerToken?.let { item.setOfferToken(it) }
            val flow = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(item.build()))
                .setObfuscatedAccountId(accountToken)
                .build()

            val waiting = CompletableDeferred<Pair<PlayResult, List<Purchase>?>>()
            synchronized(inFlightLock) { inFlight = waiting }
            try {
                val launched = withContext(Dispatchers.Main.immediate) { client.launchBillingFlow(activity, flow) }
                if (launched.responseCode != BillingResponseCode.OK) {
                    return@withLock outcomeOf(launched, null, product.id)
                }
                val (result, purchases) = waiting.await()
                outcomeOf(result, purchases, product.id)
            } finally {
                // A flow whose caller went away: its answer, when it comes,
                // goes to unsolicitedPurchases instead.
                synchronized(inFlightLock) { if (inFlight === waiting) inFlight = null }
                waiting.cancel()
            }
        }

    override suspend fun ownedPurchases(type: ProductType): BillingResult<List<StorePurchase>> {
        unavailable()?.let { return it }
        val result = client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type.play).build())
        if (result.billingResult.responseCode != BillingResponseCode.OK) {
            return BillingResult.Failed(reasonOf(result.billingResult.responseCode), result.billingResult.debugMessage)
        }
        return BillingResult.Ok(result.purchasesList.map { it.toStorePurchase() })
    }

    /** The server consumes Play packs through the Play Developer API once it has credited them. */
    override suspend fun consume(purchase: StorePurchase): ConsumeOutcome = ConsumeOutcome.HandledByServer

    override fun disconnect() {
        client.endConnection()
    }

    private suspend fun unavailable(): BillingResult.Failed? =
        when (val availability = connect()) {
            BillingAvailability.Ready -> null
            is BillingAvailability.Unavailable -> BillingResult.Failed(availability.reason, availability.detail)
        }

    private fun outcomeOf(result: PlayResult, purchases: List<Purchase>?, productId: String): PurchaseOutcome =
        when (result.responseCode) {
            BillingResponseCode.OK -> {
                val purchase = purchases.orEmpty().firstOrNull { productId in it.products }?.toStorePurchase()
                when (purchase?.state) {
                    StorePurchaseState.PURCHASED -> PurchaseOutcome.Purchased(purchase)
                    StorePurchaseState.PENDING -> PurchaseOutcome.Pending(purchase)
                    else -> PurchaseOutcome.Failed(BillingUnavailableReason.ERROR, "no purchase for the product in Play's answer")
                }
            }
            BillingResponseCode.USER_CANCELED -> PurchaseOutcome.Cancelled
            BillingResponseCode.ITEM_ALREADY_OWNED -> PurchaseOutcome.AlreadyOwned(productId)
            else -> {
                diag.info(AREA, "purchase failed: ${result.responseCode}")
                PurchaseOutcome.Failed(reasonOf(result.responseCode), result.debugMessage)
            }
        }

    private fun reasonOf(code: Int): BillingUnavailableReason = when (code) {
        BillingResponseCode.BILLING_UNAVAILABLE -> BillingUnavailableReason.STORE_NOT_READY
        BillingResponseCode.FEATURE_NOT_SUPPORTED, BillingResponseCode.ITEM_UNAVAILABLE -> BillingUnavailableReason.NOT_SUPPORTED
        BillingResponseCode.SERVICE_UNAVAILABLE,
        BillingResponseCode.SERVICE_DISCONNECTED,
        BillingResponseCode.NETWORK_ERROR,
        -> BillingUnavailableReason.SERVICE_UNAVAILABLE
        else -> BillingUnavailableReason.ERROR
    }

    private val ProductType.play: String
        get() = when (this) {
            ProductType.SUBSCRIPTION -> BillingClient.ProductType.SUBS
            ProductType.ONE_TIME -> BillingClient.ProductType.INAPP
        }

    private fun ProductDetails.toStoreProduct(type: ProductType): StoreProduct? = when (type) {
        ProductType.ONE_TIME -> oneTimePurchaseOfferDetailsList?.firstOrNull()?.let { offer ->
            StoreProduct(
                id = productId,
                type = type,
                title = name,
                description = description,
                formattedPrice = offer.formattedPrice,
                priceMicros = offer.priceAmountMicros,
                currencyCode = offer.priceCurrencyCode,
                offerToken = offer.offerToken,
            )
        }
        ProductType.SUBSCRIPTION -> {
            val offers = subscriptionOfferDetails.orEmpty()
            // The base plan: the offer with no offer id. Its last pricing
            // phase is the recurring price.
            val base = offers.firstOrNull { it.offerId == null } ?: offers.firstOrNull()
            val recurring = base?.pricingPhases?.pricingPhaseList?.lastOrNull()
            if (base == null || recurring == null) {
                null
            } else {
                StoreProduct(
                    id = productId,
                    type = type,
                    title = name,
                    description = description,
                    formattedPrice = recurring.formattedPrice,
                    priceMicros = recurring.priceAmountMicros,
                    currencyCode = recurring.priceCurrencyCode,
                    offerToken = base.offerToken,
                )
            }
        }
    }

    private fun Purchase.toStorePurchase() = StorePurchase(
        store = Store.PLAY,
        productIds = products,
        purchaseToken = purchaseToken,
        orderId = orderId,
        purchaseTimeMillis = purchaseTime,
        state = when (purchaseState) {
            Purchase.PurchaseState.PURCHASED -> StorePurchaseState.PURCHASED
            Purchase.PurchaseState.PENDING -> StorePurchaseState.PENDING
            else -> StorePurchaseState.UNKNOWN
        },
        acknowledged = isAcknowledged,
        originalJson = originalJson,
        signature = signature,
    )

    private companion object {
        const val AREA = "Billing"

        /** Play's limit for `obfuscatedAccountId`. */
        const val MAX_ACCOUNT_ID = 64
    }
}
