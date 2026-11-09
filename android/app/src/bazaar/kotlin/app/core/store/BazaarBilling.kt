package app.core.store

import android.content.Context
import androidx.activity.ComponentActivity
import app.core.common.Diag
import ir.cafebazaar.poolakey.Connection
import ir.cafebazaar.poolakey.Payment
import ir.cafebazaar.poolakey.config.PaymentConfiguration
import ir.cafebazaar.poolakey.config.SecurityCheck
import ir.cafebazaar.poolakey.entity.PurchaseInfo
import ir.cafebazaar.poolakey.entity.PurchaseState
import ir.cafebazaar.poolakey.entity.SkuDetails
import ir.cafebazaar.poolakey.exception.BazaarNotFoundException
import ir.cafebazaar.poolakey.exception.BazaarNotSupportedException
import ir.cafebazaar.poolakey.exception.DisconnectException
import ir.cafebazaar.poolakey.exception.IAPNotSupportedException
import ir.cafebazaar.poolakey.exception.SubsNotSupportedException
import ir.cafebazaar.poolakey.request.PurchaseRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * Cafe Bazaar in-app billing, through Poolakey (Bazaar's official SDK).
 *
 * Connecting, product details, the purchase and subscription sheets (the
 * developer payload is the server's `billingRef`), owned purchases and
 * consuming. NOT done here, by design: granting anything. A purchase is
 * reported as the store reported it and goes to the server
 * (`POST /v1/store/bazaar/purchases`), which checks its signature and asks
 * Cafe Bazaar's developer API before any entitlement exists; a pack is
 * consumed only after that ([StoreBilling]). Bazaar cannot replace one
 * subscription with another, so a [PlanChange] is not used here.
 *
 * The local signature check ([SecurityCheck.Enable]) needs the app's RSA
 * public key from the Bazaar developer panel (`-Pbazaar.rsaPublicKey`). Without
 * it the check is off: Poolakey then accepts what Bazaar returns, and the
 * server's validation is the only check, as it is the one that counts anyway.
 *
 * Poolakey calls back on the main thread; every call is made from it too.
 */
internal class BazaarBilling(
    context: Context,
    rsaPublicKey: String,
    private val diag: Diag,
) : StoreBilling {

    override val store: Store = Store.BAZAAR

    private val payment = Payment(
        context.applicationContext,
        PaymentConfiguration(
            if (rsaPublicKey.isBlank()) SecurityCheck.Disable else SecurityCheck.Enable(rsaPublicKey),
            true,
        ),
    )

    private val connectLock = Mutex()

    @Volatile private var connection: Connection? = null

    @Volatile private var connected = false

    init {
        if (rsaPublicKey.isBlank()) diag.info(AREA, "no RSA public key in this build: Poolakey's local check is off")
    }

    /**
     * Bazaar never tells an app about a purchase outside its own flow, so this
     * never emits. A flow interrupted by a crash is found by [ownedPurchases]
     * at the next launch.
     */
    override val unsolicitedPurchases: Flow<StorePurchase> = emptyFlow()

    override suspend fun connect(): BillingAvailability = connectLock.withLock {
        if (connected) return@withLock BillingAvailability.Ready
        withContext(Dispatchers.Main.immediate) {
            // A failed or dropped connection is released before a new one is
            // made, so retries never stack service bindings.
            connection?.disconnect()
            connection = null
            suspendCancellableCoroutine<BillingAvailability> { continuation ->
                connection = payment.connect {
                    connectionSucceed {
                        connected = true
                        if (continuation.isActive) continuation.resume(BillingAvailability.Ready)
                    }
                    connectionFailed { error ->
                        connected = false
                        diag.info(AREA, "connect failed: ${error.javaClass.simpleName}")
                        if (continuation.isActive) {
                            continuation.resume(BillingAvailability.Unavailable(reasonOf(error), error.javaClass.simpleName))
                        }
                    }
                    disconnected {
                        connected = false
                        diag.info(AREA, "disconnected")
                        if (continuation.isActive) {
                            continuation.resume(BillingAvailability.Unavailable(BillingUnavailableReason.SERVICE_UNAVAILABLE, "disconnected"))
                        }
                    }
                }
            }
        }
    }

    override suspend fun products(type: ProductType, ids: List<String>): BillingResult<List<StoreProduct>> {
        if (ids.isEmpty()) return BillingResult.Ok(emptyList())
        unavailable()?.let { return it }
        return withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine<BillingResult<List<StoreProduct>>> { continuation ->
                val callback: ir.cafebazaar.poolakey.callback.GetSkuDetailsCallback.() -> Unit = {
                    getSkuDetailsSucceed { list ->
                        if (continuation.isActive) continuation.resume(BillingResult.Ok(list.map { it.toProduct(type) }))
                    }
                    getSkuDetailsFailed { error ->
                        if (continuation.isActive) continuation.resume(BillingResult.Failed(reasonOf(error), error.javaClass.simpleName))
                    }
                }
                when (type) {
                    ProductType.SUBSCRIPTION -> payment.getSubscriptionSkuDetails(ids, callback)
                    ProductType.ONE_TIME -> payment.getInAppSkuDetails(ids, callback)
                }
            }
        }
    }

    override suspend fun purchase(
        activity: ComponentActivity,
        product: StoreProduct,
        accountToken: String,
        change: PlanChange?,
    ): PurchaseOutcome {
        when (val availability = connect()) {
            BillingAvailability.Ready -> Unit
            is BillingAvailability.Unavailable -> return PurchaseOutcome.Failed(availability.reason, availability.detail)
        }
        val request = PurchaseRequest(productId = product.id, payload = accountToken)
        return withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine<PurchaseOutcome> { continuation ->
                val callback: ir.cafebazaar.poolakey.callback.PurchaseCallback.() -> Unit = {
                    purchaseFlowBegan { diag.info(AREA, "purchase sheet open") }
                    failedToBeginFlow { error ->
                        if (continuation.isActive) continuation.resume(PurchaseOutcome.Failed(reasonOf(error), error.javaClass.simpleName))
                    }
                    purchaseSucceed { info ->
                        if (continuation.isActive) continuation.resume(PurchaseOutcome.Purchased(info.toPurchase()))
                    }
                    purchaseCanceled {
                        if (continuation.isActive) continuation.resume(PurchaseOutcome.Cancelled)
                    }
                    purchaseFailed { error ->
                        if (continuation.isActive) continuation.resume(PurchaseOutcome.Failed(reasonOf(error), error.javaClass.simpleName))
                    }
                }
                when (product.type) {
                    ProductType.SUBSCRIPTION -> payment.subscribeProduct(activity.activityResultRegistry, request, callback)
                    ProductType.ONE_TIME -> payment.purchaseProduct(activity.activityResultRegistry, request, callback)
                }
            }
        }
    }

    override suspend fun ownedPurchases(type: ProductType): BillingResult<List<StorePurchase>> {
        unavailable()?.let { return it }
        return withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine<BillingResult<List<StorePurchase>>> { continuation ->
                val callback: ir.cafebazaar.poolakey.callback.PurchaseQueryCallback.() -> Unit = {
                    querySucceed { list ->
                        if (continuation.isActive) continuation.resume(BillingResult.Ok(list.map { it.toPurchase() }))
                    }
                    queryFailed { error ->
                        if (continuation.isActive) continuation.resume(BillingResult.Failed(reasonOf(error), error.javaClass.simpleName))
                    }
                }
                when (type) {
                    ProductType.SUBSCRIPTION -> payment.getSubscribedProducts(callback)
                    ProductType.ONE_TIME -> payment.getPurchasedProducts(callback)
                }
            }
        }
    }

    /**
     * Consumes a pack in Bazaar. Bazaar's developer API cannot consume, so the
     * app does it, and only after the server has credited the pack: consuming
     * first and failing to reach the server would lose the purchase.
     */
    override suspend fun consume(purchase: StorePurchase): ConsumeOutcome {
        when (val availability = connect()) {
            BillingAvailability.Ready -> Unit
            is BillingAvailability.Unavailable -> return ConsumeOutcome.Failed(availability.reason.name)
        }
        return withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine<ConsumeOutcome> { continuation ->
                payment.consumeProduct(purchase.purchaseToken) {
                    consumeSucceed { if (continuation.isActive) continuation.resume(ConsumeOutcome.Consumed) }
                    consumeFailed { error ->
                        if (continuation.isActive) continuation.resume(ConsumeOutcome.Failed(error.javaClass.simpleName))
                    }
                }
            }
        }
    }

    override fun disconnect() {
        connection?.disconnect()
        connection = null
        connected = false
    }

    /** Null when connected; otherwise the failure to report. */
    private suspend fun unavailable(): BillingResult.Failed? =
        when (val availability = connect()) {
            BillingAvailability.Ready -> null
            is BillingAvailability.Unavailable -> BillingResult.Failed(availability.reason, availability.detail)
        }

    private fun reasonOf(error: Throwable): BillingUnavailableReason = when (error) {
        is BazaarNotFoundException -> BillingUnavailableReason.STORE_NOT_INSTALLED
        is BazaarNotSupportedException -> BillingUnavailableReason.STORE_NOT_READY
        is IAPNotSupportedException, is SubsNotSupportedException -> BillingUnavailableReason.NOT_SUPPORTED
        is DisconnectException -> BillingUnavailableReason.SERVICE_UNAVAILABLE
        else -> BillingUnavailableReason.ERROR
    }

    private fun SkuDetails.toProduct(type: ProductType) = StoreProduct(
        id = sku,
        type = type,
        title = title,
        description = description,
        formattedPrice = price,
    )

    private fun PurchaseInfo.toPurchase() = StorePurchase(
        store = Store.BAZAAR,
        productIds = listOf(productId),
        purchaseToken = purchaseToken,
        orderId = orderId,
        purchaseTimeMillis = purchaseTime,
        state = when (purchaseState) {
            PurchaseState.PURCHASED -> StorePurchaseState.PURCHASED
            PurchaseState.REFUNDED -> StorePurchaseState.REFUNDED
        },
        acknowledged = null,
        originalJson = originalJson,
        signature = dataSignature,
        accountRef = payload.takeIf { it.isNotEmpty() },
    )

    private companion object {
        const val AREA = "Billing"
    }
}
