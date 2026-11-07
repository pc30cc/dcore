package app.core.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Whether the phone has a network that reaches the internet, as it changes.
 * Only a hint for "try again by itself when the network is back": a request
 * is still the only proof that the server can be reached.
 */
fun Context.internetAvailability(): Flow<Boolean> = callbackFlow {
    val manager = getSystemService(ConnectivityManager::class.java)
    if (manager == null) {
        trySend(true)
        awaitClose { }
        return@callbackFlow
    }
    fun current(): Boolean = manager.activeNetwork?.let { network ->
        manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    } == true

    val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            trySend(true)
        }

        override fun onLost(network: Network) {
            trySend(current())
        }
    }
    trySend(current())
    runCatching { manager.registerDefaultNetworkCallback(callback) }
    awaitClose { runCatching { manager.unregisterNetworkCallback(callback) } }
}.distinctUntilChanged()
