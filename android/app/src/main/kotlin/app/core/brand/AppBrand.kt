package app.core.brand

import app.core.BuildConfig
import app.core.store.Store

/**
 * The brand and the store this build wears, fixed at build time.
 *
 * Both come from the build: the brand from `brands/<id>/brand.json`
 * (`-Pbrand=<id>`), the store from the product flavor (`bazaar` or `play`).
 * Nothing in `src/main` names a brand; every sentence that names the product
 * uses `{appName}` (see [app.core.i18n.brandText]).
 *
 * The name here is the build's default. When the server's `GET /config`
 * carries a display name, that one wins at run time.
 */
object AppBrand {
    /** The brand folder this build was made from (`_template` by default). */
    const val id: String = BuildConfig.BRAND_ID

    /** The product's name, for `{appName}`. */
    const val appName: String = BuildConfig.APP_NAME

    /** Which store this build is for. */
    val store: Store = Store.fromId(BuildConfig.STORE)

    /** The API a fresh install talks to. No trailing slash. */
    const val apiBaseUrl: String = BuildConfig.API_BASE_URL

    /** The realtime (Centrifugo) WebSocket endpoint. */
    const val realtimeUrl: String = BuildConfig.REALTIME_WS_URL

    /** Whether this build offers "Continue with Google". */
    const val supportsGoogleSignIn: Boolean = BuildConfig.SUPPORTS_GOOGLE_SIGN_IN

    /** Legal pages and support contact from brand.json; empty when the brand leaves one out. */
    object Legal {
        const val privacyUrl: String = BuildConfig.PRIVACY_URL
        const val termsUrl: String = BuildConfig.TERMS_URL
        const val guidelinesUrl: String = BuildConfig.GUIDELINES_URL
        const val deleteAccountUrl: String = BuildConfig.DELETE_ACCOUNT_URL
        const val supportEmail: String = BuildConfig.SUPPORT_EMAIL
    }
}
