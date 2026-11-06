package app.core.store

import android.content.Context
import app.core.BuildConfig
import app.core.diag.Diag

/**
 * The Google Play build's store services.
 *
 * The Cafe Bazaar flavor has a class of the same name (`src/bazaar`); `src/main`
 * calls [create] without knowing which store it got.
 */
internal object StoreModule {
    fun create(context: Context, diag: Diag): StoreServices {
        val info = PlayStoreInfo()
        return StoreServices(
            info = info,
            billing = PlayBilling(context, info, diag),
            updates = PlayUpdates(context, diag),
            rating = PlayRating(context, diag),
            integrity = PlayIntegrity(context, BuildConfig.PLAY_CLOUD_PROJECT_NUMBER, diag),
        )
    }
}
