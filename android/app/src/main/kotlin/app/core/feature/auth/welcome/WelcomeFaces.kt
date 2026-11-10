package app.core.feature.auth.welcome

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import app.core.common.runCatchingUnlessCancelled
import app.core.media.ImageLoading
import app.core.media.LocalRemoteImages
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.size.Precision
import coil3.size.Scale
import coil3.toBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

/**
 * The welcome's pictures. Never a member's photo: only the brand's own
 * pictures (shipped in the build, or named by the server's config and cached
 * like photos). Nothing is drawn in their place when there are none.
 *
 * Decoded off the main thread and kept, per picture, at the largest size
 * asked so far, in a cache bounded in bytes and emptied once the welcome is
 * gone for good ([release], on sign-in).
 */
object WelcomeFaces {

    /** The orbit's faces: one in the middle, six around it. */
    const val ORBIT = 7

    /** The framed photo is never blown up more than this to cover its frame (a small crop would turn soft). */
    const val MAX_UPSCALE = 1.5f

    private class Entry(val bitmap: Bitmap, val full: Boolean)

    private val cache = object : LruCache<WelcomePicture, Entry>(cacheBytes()) {
        override fun sizeOf(key: WelcomePicture, value: Entry): Int = value.bitmap.allocationByteCount
    }

    private fun cacheBytes(): Int = min(Runtime.getRuntime().maxMemory() / 8, MAX_CACHE_BYTES).toInt()

    /** How many pictures have been decoded or fetched in this process (tests wait for it). */
    @Volatile internal var loadedCount: Int = 0
        private set

    /** How many times a welcome finished choosing what to draw (tests wait for it). */
    @Volatile internal var settledCount: Int = 0
        private set

    /** The thread the last [load] ran on (tests: never the main one). */
    @Volatile internal var loadedOn: Thread? = null
        private set

    internal fun settled() {
        settledCount++
    }

    /** Lets the decoded pictures go: the welcome will not be shown again soon (signed in). */
    fun release() = cache.evictAll()

    /** Forgets what was decoded, so a test sees a first launch. */
    internal fun forgetForTest() {
        cache.evictAll()
        loadedCount = 0
        settledCount = 0
        loadedOn = null
    }

    /** A picture already decoded at its full size (tests: a brand picture without an asset file). */
    internal fun keepForTest(source: WelcomePicture, bitmap: Bitmap) {
        cache.put(source, Entry(bitmap, full = true))
    }

    /** [source] if it is already decoded large enough to cover [width] × [height] px, else null (no I/O). */
    fun cached(source: WelcomePicture, width: Int, height: Int): Bitmap? =
        cache.get(source)?.takeIf { it.full || (it.bitmap.width >= width && it.bitmap.height >= height) }?.bitmap

    /**
     * [source] decoded (or, with [remote], fetched) large enough to cover
     * [width] × [height] px where the picture has that many pixels, never
     * blown up; null when it cannot be read. Off the main thread.
     */
    suspend fun load(context: Context, source: WelcomePicture, remote: Boolean, width: Int, height: Int): Bitmap? {
        loadedOn = Thread.currentThread()
        cached(source, width, height)?.let { return it }
        val entry = when (source) {
            is WelcomePicture.Asset -> decodeAsset(context, source.name, width, height)
            is WelcomePicture.Remote -> if (remote) fetch(context, source.url, width, height) else null
        } ?: return null
        loadedCount++
        val kept = cache.get(source)
        if (kept == null || entry.bitmap.width > kept.bitmap.width) cache.put(source, entry)
        return entry.bitmap
    }

    /** The square a face is cut from: the whole width, a little above the middle of a portrait. */
    fun faceSquare(picture: Bitmap): Bitmap {
        val side = min(picture.width, picture.height)
        if (picture.width == picture.height) return picture
        val left = (picture.width - side) / 2
        val top = ((picture.height - side) * FACE_FOCUS).toInt().coerceIn(0, max(0, picture.height - side))
        return Bitmap.createBitmap(picture, left, top, side, side)
    }

    /** How much [picture] must be enlarged to cover [width] × [height]. */
    fun upscale(picture: Bitmap, width: Int, height: Int): Float =
        max(width.toFloat() / picture.width, height.toFloat() / picture.height)

    private suspend fun decodeAsset(context: Context, name: String, width: Int, height: Int): Entry? = withContext(Dispatchers.IO) {
        runCatchingUnlessCancelled {
            val path = "${BrandWelcome.IMAGE_FOLDER}/$name"
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.assets.open(path).use { BitmapFactory.decodeStream(it, null, bounds) }
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= width && bounds.outHeight / (sample * 2) >= height) sample *= 2
            val bitmap = context.assets.open(path).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
            bitmap?.let { Entry(it, full = sample == 1) }
        }.getOrNull()
    }

    private suspend fun fetch(context: Context, url: String, width: Int, height: Int): Entry? = runCatchingUnlessCancelled {
        val key = ImageLoading.cacheKey(url)
        val request = ImageRequest.Builder(context)
            .data(url)
            .memoryCacheKey("$key#${width}x$height")
            .diskCacheKey(key)
            .size(width, height)
            .scale(Scale.FILL)
            .precision(Precision.INEXACT)
            .allowHardware(false)
            .build()
        val bitmap = (ImageLoading.loader(context).execute(request) as? SuccessResult)?.image?.toBitmap() ?: return@runCatchingUnlessCancelled null
        // Inexact decoding never enlarges: a result smaller than asked for is the whole picture.
        Entry(bitmap, full = bitmap.width < width - 1 || bitmap.height < height - 1)
    }.getOrNull()

    /** Where a face sits in a portrait: this share of the spare height lies above the square. */
    private const val FACE_FOCUS = 0.3f

    private const val MAX_CACHE_BYTES = 32L * 1024 * 1024
}

/** What a welcome hero draws. */
sealed interface WelcomeArt {
    /** Pictures are on their way: nothing in their place yet. */
    data object Loading : WelcomeArt

    /** No picture to show: the hero's design without pictures. */
    data object None : WelcomeArt

    data class Faces(val faces: List<ImageBitmap>) : WelcomeArt

    data class Photo(val bitmap: ImageBitmap) : WelcomeArt
}

/**
 * The face orbit's faces as [size] px squares, in the pictures' order (the
 * first in the middle), from the first set of [sources] that loads at all:
 * the config's, else the brand's own. [WelcomeArt.None] at once when there
 * are no pictures; faces already on screen stay when none of a new set loads.
 */
@Composable
fun rememberOrbitFaces(sources: WelcomeSources, size: Int): WelcomeArt {
    val context = LocalContext.current
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current
    val initial = remember(sources, size) { orbitAtOnce(sources, size) }
    val art by produceState(initial, sources, size, remote) {
        if (initial !is WelcomeArt.Loading) {
            value = initial
            WelcomeFaces.settled()
            return@produceState
        }
        val found = withContext(Dispatchers.Default) {
            sources.sets.firstNotNullOfOrNull { set ->
                set.take(WelcomeFaces.ORBIT)
                    .mapNotNull { WelcomeFaces.load(context.applicationContext, it, remote, size, size) }
                    .takeIf { it.isNotEmpty() }
                    ?.map { WelcomeFaces.faceSquare(it).asImageBitmap() }
            }
        }
        value = when {
            found != null -> WelcomeArt.Faces(found)
            value is WelcomeArt.Faces -> value
            else -> WelcomeArt.None
        }
        WelcomeFaces.settled()
    }
    return art
}

/**
 * The framed welcome's photo: the first of [sources] (the config's, else the
 * brand's own) that covers a [width] × [height] px frame without being blown
 * up more than [WelcomeFaces.MAX_UPSCALE] times. [WelcomeArt.None] when none
 * does (a face crop would turn soft in the frame); a photo already on screen
 * stays when none of a new set loads.
 */
@Composable
fun rememberWelcomePhoto(sources: WelcomeSources, width: Int, height: Int): WelcomeArt {
    val context = LocalContext.current
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current
    val initial = remember(sources, width, height) { photoAtOnce(sources, width, height) }
    val art by produceState(initial, sources, width, height, remote) {
        if (initial !is WelcomeArt.Loading) {
            value = initial
            WelcomeFaces.settled()
            return@produceState
        }
        val found = withContext(Dispatchers.Default) {
            sources.sets.asSequence().flatten().firstNotNullOfOrNull { source ->
                WelcomeFaces.load(context.applicationContext, source, remote, width, height)
                    ?.takeIf { WelcomeFaces.upscale(it, width, height) <= WelcomeFaces.MAX_UPSCALE }
            }
        }
        value = when {
            found != null -> WelcomeArt.Photo(found.asImageBitmap())
            value is WelcomeArt.Photo -> value
            else -> WelcomeArt.None
        }
        WelcomeFaces.settled()
    }
    return art
}

/** What the orbit can draw without waiting: nothing to load, or every face already decoded; else [WelcomeArt.Loading]. */
private fun orbitAtOnce(sources: WelcomeSources, size: Int): WelcomeArt {
    if (sources.isEmpty) return WelcomeArt.None
    val first = sources.sets.first().take(WelcomeFaces.ORBIT)
    val cached = first.map { WelcomeFaces.cached(it, size, size) ?: return WelcomeArt.Loading }
    return WelcomeArt.Faces(cached.map { WelcomeFaces.faceSquare(it).asImageBitmap() })
}

/** What the frame can draw without waiting: nothing to load, or the first picture already decoded and large enough. */
private fun photoAtOnce(sources: WelcomeSources, width: Int, height: Int): WelcomeArt {
    if (sources.isEmpty) return WelcomeArt.None
    val cached = sources.sets.first().firstOrNull()?.let { WelcomeFaces.cached(it, width, height) } ?: return WelcomeArt.Loading
    return if (WelcomeFaces.upscale(cached, width, height) <= WelcomeFaces.MAX_UPSCALE) WelcomeArt.Photo(cached.asImageBitmap()) else WelcomeArt.Loading
}
