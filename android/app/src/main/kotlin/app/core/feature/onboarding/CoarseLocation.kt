package app.core.feature.onboarding

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.Executor
import kotlin.coroutines.resume

/** One approximate position, and whether it came from satellites (Android 12+ may serve coarse fixes from GPS). */
data class CoarseFix(val lat: Double, val lng: Double, val accuracyM: Int?, val fromGps: Boolean)

/** A position as a provider gave it: [ageMs] since it was taken. */
internal data class LocationReading(val provider: String, val lat: Double, val lng: Double, val accuracyM: Float?, val ageMs: Long)

/** The platform's location service as [CoarseLocation] uses it; a fake in tests. */
internal interface LocationPlatform {
    /** Whether [provider] exists on the device and is on; never throws. */
    fun enabled(provider: String): Boolean

    /** The last position [provider] has, or null when it has none or refuses; never throws. */
    fun lastKnown(provider: String): LocationReading?

    /** One fresh position, or null when [provider] gives up or refuses; cancelling the caller withdraws the request. */
    suspend fun fresh(provider: String): LocationReading?
}

/**
 * The phone's approximate position, once, from the platform's own location
 * service: no Google Play services library, so it works the same in both
 * store builds and on phones without them. Only the coarse permission is
 * asked; the position handed on is rounded to two decimal places ([coarsen]),
 * and the server turns it into a cell of a few kilometres and forgets the rest.
 */
object CoarseLocation {

    fun permitted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** A recent fix the phone already has, else a fresh one, within [timeoutMs]; null when there is none. */
    suspend fun current(context: Context, timeoutMs: Long = 15_000): CoarseFix? {
        if (!permitted(context)) return null
        val manager = context.getSystemService(LocationManager::class.java) ?: return null
        return locate(SystemLocationPlatform(manager, ContextCompat.getMainExecutor(context)), Build.VERSION.SDK_INT, timeoutMs)
    }

    /**
     * The providers asked for a fresh fix on [sdk]. Before API 31 the
     * platform refuses gps and passive to a coarse-only caller, so only
     * network is asked; from 31 every provider serves it, with coarsened
     * output. Passive starts nothing of its own and is never asked for a
     * fresh fix, only read for its last one.
     */
    @SuppressLint("InlinedApi")
    internal fun asked(sdk: Int): List<String> =
        if (sdk >= Build.VERSION_CODES.S) {
            listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        } else {
            listOf(LocationManager.NETWORK_PROVIDER)
        }

    /**
     * The most accurate usable last-known fix younger than [freshMs], else
     * the first usable fresh fix of any [asked] provider that is on, asked
     * all at once, within [timeoutMs]. Null at once when no provider can
     * answer, or as soon as every one has answered without a usable fix.
     */
    internal suspend fun locate(platform: LocationPlatform, sdk: Int, timeoutMs: Long, freshMs: Long = FRESH_MS): CoarseFix? {
        val asked = asked(sdk).filter(platform::enabled)
        val known = if (platform.enabled(LocationManager.PASSIVE_PROVIDER)) asked + LocationManager.PASSIVE_PROVIDER else asked
        known.mapNotNull(platform::lastKnown)
            .filter { it.usable() && it.ageMs < freshMs }
            .minByOrNull { it.accuracyM ?: Float.MAX_VALUE }
            ?.let { return it.fix() }
        if (asked.isEmpty()) return null
        return withTimeoutOrNull(timeoutMs) { firstFix(platform, asked) }?.fix()
    }

    /**
     * Every provider asked at once; the first usable answer wins and
     * withdraws the others' requests (the flow's scope is cancelled). A
     * provider that answers null or throws leaves the others to answer.
     */
    private suspend fun firstFix(platform: LocationPlatform, providers: List<String>): LocationReading? =
        channelFlow {
            for (provider in providers) {
                launch {
                    val reading = try {
                        platform.fresh(provider)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        null
                    }
                    send(reading)
                }
            }
        }.firstOrNull { it != null && it.usable() }

    /** A real position: finite, on the globe, not the (0, 0) of a provider with nothing, and not wildly inaccurate. */
    private fun LocationReading.usable(): Boolean =
        lat.isFinite() && lng.isFinite() && lat in -90.0..90.0 && lng in -180.0..180.0 &&
            !(lat == 0.0 && lng == 0.0) &&
            (accuracyM == null || accuracyM <= MAX_ACCURACY_M)

    private fun LocationReading.fix() = CoarseFix(
        lat = coarsen(lat),
        lng = coarsen(lng),
        accuracyM = accuracyM?.toInt(),
        fromGps = provider == LocationManager.GPS_PROVIDER,
    )

    /**
     * [degrees] rounded to two decimal places (about 1 km): the finest
     * position this code hands on, whatever the platform granted.
     */
    internal fun coarsen(degrees: Double): Double = Math.round(degrees * 100.0) / 100.0

    /** A fix younger than this is good enough: the server keeps a cell of a few kilometres. */
    private const val FRESH_MS = 30L * 60 * 1000

    /** A reading less accurate than this (metres) is not a position; also well under what the server accepts. */
    private const val MAX_ACCURACY_M = 100_000f
}

/** [LocationPlatform] over the platform's [LocationManager]; results arrive on [executor]. */
internal class SystemLocationPlatform(
    private val manager: LocationManager,
    private val executor: Executor,
) : LocationPlatform {

    override fun enabled(provider: String): Boolean =
        runCatching { LocationManagerCompat.hasProvider(manager, provider) && manager.isProviderEnabled(provider) }.getOrDefault(false)

    @SuppressLint("MissingPermission")
    override fun lastKnown(provider: String): LocationReading? =
        runCatching { manager.getLastKnownLocation(provider) }.getOrNull()?.reading()

    @SuppressLint("MissingPermission")
    override suspend fun fresh(provider: String): LocationReading? = suspendCancellableCoroutine { continuation ->
        val signal = android.os.CancellationSignal()
        continuation.invokeOnCancellation { runCatching { signal.cancel() } }
        try {
            LocationManagerCompat.getCurrentLocation(manager, provider, signal, executor) { location ->
                if (continuation.isActive) continuation.resume(location?.reading())
            }
        } catch (e: RuntimeException) {
            // A provider this caller may not use (SecurityException) or one that is gone (IllegalArgumentException).
            if (continuation.isActive) continuation.resume(null)
        }
    }

    private fun Location.reading() = LocationReading(
        provider = provider ?: "",
        lat = latitude,
        lng = longitude,
        accuracyM = if (hasAccuracy()) accuracy else null,
        // The monotonic clock when the fix carries it (a wrong wall clock cannot make it look fresh), else the wall clock.
        ageMs = if (elapsedRealtimeNanos > 0) {
            (SystemClock.elapsedRealtimeNanos() - elapsedRealtimeNanos) / 1_000_000
        } else {
            System.currentTimeMillis() - time
        },
    )
}
