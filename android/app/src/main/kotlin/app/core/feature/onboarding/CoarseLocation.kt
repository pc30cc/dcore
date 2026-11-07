package app.core.feature.onboarding

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/** One approximate position, and whether it came from satellites (Android 12+ may serve coarse fixes from GPS). */
data class CoarseFix(val lat: Double, val lng: Double, val accuracyM: Int?, val fromGps: Boolean)

/**
 * The phone's approximate position, once, from the platform's own location
 * service: no Google Play services library, so it works the same in both
 * store builds and on phones without them. Only the coarse permission is
 * asked; the server turns the position into a cell of a few kilometres and
 * forgets the rest.
 */
object CoarseLocation {

    fun permitted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** A recent fix the phone already has, else a fresh one, within [timeoutMs]; null when there is none. */
    @SuppressLint("MissingPermission")
    suspend fun current(context: Context, timeoutMs: Long = 15_000): CoarseFix? {
        if (!permitted(context)) return null
        val manager = context.getSystemService(LocationManager::class.java) ?: return null
        val providers = providers(manager)
        if (providers.isEmpty()) return null
        val now = System.currentTimeMillis()
        providers.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .filter { now - it.time < FRESH_MS }
            .minByOrNull { it.accuracy }
            ?.let { return it.fix() }
        return withTimeoutOrNull(timeoutMs) { fresh(manager, providers.first()) }?.fix()
    }

    private fun providers(manager: LocationManager): List<String> {
        val order = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(LocationManager.FUSED_PROVIDER)
            add(LocationManager.NETWORK_PROVIDER)
            // With only the coarse permission, Android 12+ hands out coarsened satellite fixes too.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(LocationManager.GPS_PROVIDER)
            add(LocationManager.PASSIVE_PROVIDER)
        }
        return order.filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) && it in manager.allProviders }
    }

    @SuppressLint("MissingPermission")
    private suspend fun fresh(manager: LocationManager, provider: String): Location? = suspendCancellableCoroutine { continuation ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val signal = CancellationSignal()
            val executor = Executors.newSingleThreadExecutor()
            continuation.invokeOnCancellation {
                signal.cancel()
                executor.shutdown()
            }
            runCatching {
                manager.getCurrentLocation(provider, signal, executor) { location ->
                    executor.shutdown()
                    if (continuation.isActive) continuation.resume(location)
                }
            }.onFailure { if (continuation.isActive) continuation.resume(null) }
        } else {
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    manager.removeUpdates(this)
                    if (continuation.isActive) continuation.resume(location)
                }

                @Deprecated("Deprecated in Java")
                override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) = Unit
                override fun onProviderEnabled(provider: String) = Unit
                override fun onProviderDisabled(provider: String) {
                    manager.removeUpdates(this)
                    if (continuation.isActive) continuation.resume(null)
                }
            }
            continuation.invokeOnCancellation { manager.removeUpdates(listener) }
            runCatching {
                @Suppress("DEPRECATION")
                manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            }.onFailure { if (continuation.isActive) continuation.resume(null) }
        }
    }

    private fun Location.fix() = CoarseFix(
        lat = latitude,
        lng = longitude,
        accuracyM = if (hasAccuracy()) accuracy.toInt() else null,
        fromGps = provider == LocationManager.GPS_PROVIDER,
    )

    /** A fix younger than this is good enough: the server keeps a cell of a few kilometres. */
    private const val FRESH_MS = 30L * 60 * 1000
}
