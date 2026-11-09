package app.core.billing

import app.core.model.BazaarPurchaseRequest
import app.core.model.BoostKind
import app.core.model.BoostStarted
import app.core.model.PlayPurchaseRequest
import app.core.model.PurchaseResult
import app.core.model.RestorePurchase
import app.core.model.RestoreResult
import app.core.model.StoreProducts
import app.core.net.ServerApi
import app.core.store.Store

/** The server's store routes (§3.12), as purchases need them. */
interface StoreApi {
    /** `GET /v1/store/products`: the session store's active products, no prices. */
    suspend fun products(): StoreProducts

    /** `POST /v1/store/{play,bazaar}/purchases`: 200 granted, 202 pending (the record says `pending`). */
    suspend fun submit(purchase: QueuedPurchase): PurchaseResult

    /** `POST /v1/store/restore`, at most 20. */
    suspend fun restore(purchases: List<RestorePurchase>): RestoreResult

    /** `POST /v1/boosts`. Never retried by the client: it may spend from the wallet. */
    suspend fun boost(kind: BoostKind): BoostStarted
}

class ServerStoreApi(private val api: ServerApi) : StoreApi {
    override suspend fun products(): StoreProducts = api.products()

    override suspend fun submit(purchase: QueuedPurchase): PurchaseResult = when (storeOf(purchase.store)) {
        Store.PLAY -> api.verifyPlayPurchase(PlayPurchaseRequest(purchase.productId, purchase.token, purchase.kind))
        Store.BAZAAR -> api.verifyBazaarPurchase(
            BazaarPurchaseRequest(purchase.productId, purchase.token, purchase.originalJson, purchase.signature.orEmpty(), purchase.kind),
        )
        null -> error("unknown store '${purchase.store}'")
    }

    override suspend fun restore(purchases: List<RestorePurchase>): RestoreResult = api.restorePurchases(purchases)

    override suspend fun boost(kind: BoostKind): BoostStarted = api.boost(kind)
}
