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
}
