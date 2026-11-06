package app.core.store

/** The store a build is made for: one product flavor each. */
enum class Store(val id: String) {
    /** Cafe Bazaar (cafebazaar.ir): billing through Poolakey. */
    BAZAAR("bazaar"),

    /** Google Play: Play Billing, In-App Review, In-App Updates, Play Integrity. */
    PLAY("play"),
    ;

    companion object {
        fun fromId(id: String): Store =
            entries.firstOrNull { it.id == id } ?: error("unknown store '$id': the build's STORE must be one of ${entries.map { it.id }}")
    }
}

/**
 * Everything the app needs from the store it was installed from, behind
 * store-neutral interfaces.
 *
 * `src/main` sees only these. Each flavor's `StoreModule` (in `src/bazaar` and
 * `src/play`, the same class name in both) builds the set for its store,
 * against its store's SDK. That
 * is what keeps Poolakey out of the Play APK and every Google Play library out
 * of the Bazaar APK; `tools/check-store-separation.sh` checks the built APKs.
 *
 * Built once, in [app.core.AppGraph].
 */
class StoreServices(
    val info: StoreInfo,
    val billing: StoreBilling,
    val updates: AppUpdates,
    val rating: AppRating,
    val integrity: DeviceIntegrity,
    /** Sign-in with an account on the phone (Google, in the Play build only). */
    val externalSignIn: ExternalSignIn = ExternalSignIn.None,
    /** Sign-in codes read from the text message (SMS Retriever, in the Play build only). */
    val smsCodes: SmsCodeReceiver = SmsCodeReceiver.None,
)
