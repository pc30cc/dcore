package app.core.store

import android.content.Context
import app.core.BuildConfig
import app.core.diag.Diag

/**
 * The Cafe Bazaar build's store services.
 *
 * The Play flavor has a class of the same name (`src/play`); `src/main` calls
 * [create] without knowing which store it got.
 */
internal object StoreModule {
    fun create(context: Context, diag: Diag): StoreServices {
        val info = BazaarStoreInfo()
        return StoreServices(
            info = info,
            billing = BazaarBilling(context, BuildConfig.BAZAAR_RSA_PUBLIC_KEY, diag),
            updates = BazaarUpdates(info),
            rating = BazaarRating(info),
            integrity = BazaarIntegrity,
        )
    }
}
