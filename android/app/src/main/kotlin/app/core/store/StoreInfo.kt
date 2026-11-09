package app.core.store

import android.app.Activity
import android.content.Context

/** The store itself: its app on the phone, and this app's page in it. */
interface StoreInfo {
    val store: Store

    /** The store app's package on the phone (the installer it reports). */
    val storePackage: String

    /** Whether the store app is installed (and visible to this app). */
    fun isStoreInstalled(context: Context): Boolean

    /**
     * Whether this copy was installed by the store: true or false when the
     * platform says, null when it cannot tell (a sideload reports no installer).
     */
    fun installedByStore(context: Context): Boolean?

    /** This app's page on the store's website, for when the store app is missing. */
    fun appPageWebUrl(packageName: String): String

    /** Opens this app's page in the store app, else on the web. False when nothing could open it. */
    fun openAppPage(activity: Activity): Boolean

    /**
     * Whether [url] is a page of THIS store, the only kind of subscription
     * link the app opens: a link the server sends that names another store
     * (or anything else) is not followed.
     */
    fun isOwnStoreLink(url: String): Boolean

    /**
     * Opens the store's own place for cancelling or changing a subscription
     * ([productId]: the product to show, where the store can). [serverLink]
     * is the entitlements' `manageUrl`, opened instead when it is this
     * store's ([isOwnStoreLink]). False when nothing could open.
     */
    fun openSubscriptions(activity: Activity, productId: String?, serverLink: String?): Boolean

    /** Where the store app itself can be got, for a phone that lacks it. False when nothing could open. */
    fun openStoreInstall(activity: Activity): Boolean
}
