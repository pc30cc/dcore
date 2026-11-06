package app.core.media

import android.content.Context
import android.graphics.Bitmap
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import app.core.model.Photo
import app.core.ui.theme.LocalReducedMotion
import coil3.ImageLoader
import coil3.compose.AsyncImage
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.ImageRequest
import coil3.request.crossfade
import coil3.size.Size
import okhttp3.OkHttpClient
import okio.Path.Companion.toOkioPath

/**
 * The app's one image loader (Coil): a memory cache sized to the phone, a
 * 256 MB disk cache, and photos fetched on a client of their own, with no API
 * header or session on it (photo URLs are signed CDN links).
 *
 * Cache keys are the URL without its query: the signature in the query
 * changes every time the server signs the link again, the path (photo id,
 * blob version, size) does not. A photo seen yesterday is therefore read from
 * disk today, not downloaded again.
 */
object ImageLoading {

    /** A fixed neutral folder name under the app's cache directory. */
    private const val DISK_FOLDER = "images"
    private const val DISK_BYTES = 256L * 1024 * 1024
    private const val MEMORY_SHARE = 0.20

    @Volatile private var loader: ImageLoader? = null

    fun loader(context: Context): ImageLoader =
        loader ?: synchronized(this) {
            loader ?: build(context.applicationContext).also { loader = it }
        }

    private fun build(context: Context): ImageLoader {
        val client = OkHttpClient.Builder().build()
        return ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { client })) }
            .memoryCache { MemoryCache.Builder().maxSizePercent(context, MEMORY_SHARE).build() }
            .diskCache {
                DiskCache.Builder()
                    .directory(context.cacheDir.resolve(DISK_FOLDER).toOkioPath())
                    .maxSizeBytes(DISK_BYTES)
                    .build()
            }
            .build()
    }

    /** The cache key of a photo URL: its path, never its signature. */
    fun cacheKey(url: String): String = url.substringBefore('?')

    /**
     * The request for [url]. The size is the variant the URL names (the
     * server picks 320, 640 or 1080), decoded as is, so a preloaded copy and
     * the one a card draws are the same memory-cache entry.
     */
    fun request(context: Context, url: String, crossfade: Boolean = false): ImageRequest {
        val key = cacheKey(url)
        return ImageRequest.Builder(context)
            .data(url)
            .memoryCacheKey(key)
            .diskCacheKey(key)
            .size(Size.ORIGINAL)
            .crossfade(crossfade)
            .build()
    }
}

/**
 * Fetches photos before they are on screen, so the next card never shows a
 * placeholder for long. Remembers what it already asked for (a bounded set),
 * so calling it on every state change costs nothing.
 */
fun interface PhotoPreloader {
    fun preload(urls: List<String>)

    companion object {
        val None = PhotoPreloader { }
    }
}

class CoilPhotoPreloader(context: Context) : PhotoPreloader {
    private val context = context.applicationContext
    private val asked = object : LinkedHashMap<String, Unit>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?): Boolean = size > MAX_REMEMBERED
    }

    override fun preload(urls: List<String>) {
        if (urls.isEmpty()) return
        val loader = ImageLoading.loader(context)
        synchronized(asked) {
            for (url in urls) {
                val key = ImageLoading.cacheKey(url)
                if (asked.containsKey(key)) continue
                asked[key] = Unit
                loader.enqueue(ImageLoading.request(context, url))
            }
        }
    }

    private companion object {
        const val MAX_REMEMBERED = 200
    }
}

/**
 * Whether composables fetch photos over the network. Off in previews and in
 * screen tests, which then show the BlurHash placeholders only.
 */
val LocalRemoteImages = staticCompositionLocalOf { true }

private val placeholders = LruCache<String, ImageBitmap>(96)

/** A BlurHash as a small bitmap, decoded once per hash (cached), or null when the hash is invalid. */
fun blurHashBitmap(hash: String): ImageBitmap? {
    if (hash.isEmpty()) return null
    placeholders.get(hash)?.let { return it }
    val pixels = BlurHash.decode(hash, PLACEHOLDER_W, PLACEHOLDER_H) ?: return null
    val bitmap = Bitmap.createBitmap(pixels, PLACEHOLDER_W, PLACEHOLDER_H, Bitmap.Config.ARGB_8888).asImageBitmap()
    placeholders.put(hash, bitmap)
    return bitmap
}

private const val PLACEHOLDER_W = 32
private const val PLACEHOLDER_H = 40

/** A BlurHash filling its bounds (cropped), or a flat surface colour when the hash is missing or invalid. */
@Composable
fun BlurHashImage(hash: String?, modifier: Modifier = Modifier) {
    val bitmap = remember(hash) { hash?.let(::blurHashBitmap) }
    if (bitmap == null) {
        Box(modifier.background(MaterialTheme.colorScheme.surfaceContainerHighest))
    } else {
        Image(
            bitmap = bitmap,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            filterQuality = FilterQuality.Low,
            modifier = modifier,
        )
    }
}

/**
 * A photo: its BlurHash at once, the image over it as soon as it is in a
 * cache or arrives (crossfaded, unless the system asks for less motion).
 *
 * [blurredOnly] draws the placeholder and never fetches the image: the free
 * plan's view of who liked them.
 */
@Composable
fun PhotoImage(
    photo: Photo?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    blurredOnly: Boolean = false,
    scrim: Color = Color.Transparent,
) {
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current && !blurredOnly
    val reduced = LocalReducedMotion.current
    val context = LocalContext.current
    Box(modifier) {
        BlurHashImage(photo?.blurhash, Modifier.fillMaxSize())
        if (remote && photo != null && photo.url.isNotBlank()) {
            val request = remember(photo.url, reduced) { ImageLoading.request(context, photo.url, crossfade = !reduced) }
            AsyncImage(
                model = request,
                contentDescription = contentDescription,
                imageLoader = ImageLoading.loader(context),
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (scrim != Color.Transparent) Box(Modifier.fillMaxSize().background(scrim))
    }
}
