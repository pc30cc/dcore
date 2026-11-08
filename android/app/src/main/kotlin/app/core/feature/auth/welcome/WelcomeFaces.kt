package app.core.feature.auth.welcome

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Typeface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.core.content.res.ResourcesCompat
import app.core.R
import app.core.common.runCatchingUnlessCancelled
import app.core.media.ImageLoading
import app.core.media.LocalRemoteImages
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.toBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The faces in the bubbles. Never a member's photo: only the brand's own
 * pictures (shipped in the build, or named by the server's config and cached
 * like photos), and with none of those, [GeneratedFaces].
 */
object WelcomeFaces {

    @Volatile private var generated: List<Bitmap>? = null
    private val pictures = HashMap<WelcomePicture, Bitmap>()

    /** The generated figures, painted once per process. */
    fun generated(): List<Bitmap> = generated ?: synchronized(this) {
        generated ?: List(GENERATED) { GeneratedFaces.paint(it, BubbleArt.FACE) }.also { generated = it }
    }

    /**
     * The brand's pictures, decoded (or fetched) once and kept for the
     * process. With [remote] off (previews, screen tests) config URLs are
     * skipped. Fewer than [MIN_PICTURES] are mixed with generated figures,
     * so a short list does not repeat the same few faces.
     */
    suspend fun load(context: Context, sources: List<WelcomePicture>, remote: Boolean): List<Bitmap> {
        if (sources.isEmpty()) return emptyList()
        val loaded = sources.mapNotNull { source ->
            synchronized(pictures) { pictures[source] }?.let { return@mapNotNull it }
            val bitmap = when (source) {
                is WelcomePicture.Asset -> decodeAsset(context, source.name)
                is WelcomePicture.Remote -> if (remote) fetch(context, source.url) else null
            }
            bitmap?.also { synchronized(pictures) { pictures[source] = it } }
        }
        if (loaded.isEmpty()) return emptyList()
        return if (loaded.size >= MIN_PICTURES) loaded else loaded + generated()
    }

    private suspend fun decodeAsset(context: Context, name: String): Bitmap? = withContext(Dispatchers.IO) {
        runCatchingUnlessCancelled {
            val path = "${BrandWelcome.IMAGE_FOLDER}/$name"
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.assets.open(path).use { BitmapFactory.decodeStream(it, null, bounds) }
            var sample = 1
            while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= BubbleArt.FACE) sample *= 2
            context.assets.open(path).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
        }.getOrNull()
    }

    private suspend fun fetch(context: Context, url: String): Bitmap? = runCatchingUnlessCancelled {
        val key = ImageLoading.cacheKey(url)
        val request = ImageRequest.Builder(context)
            .data(url)
            .memoryCacheKey(key)
            .diskCacheKey(key)
            .size(BubbleArt.FACE)
            .allowHardware(false)
            .build()
        (ImageLoading.loader(context).execute(request) as? SuccessResult)?.image?.toBitmap()
    }.getOrNull()

    private const val GENERATED = 12
    private const val MIN_PICTURES = 6
}

/**
 * The bubbles' art for this screen: the action [labels] drawn in the
 * screen's script, generated faces at once, the brand's pictures once loaded.
 */
@Composable
fun rememberBubbleArt(pictures: List<WelcomePicture>, labels: List<String>, persian: Boolean): BubbleArt {
    val context = LocalContext.current
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current
    val art = remember(labels, persian) {
        val typeface = if (persian) {
            runCatching { ResourcesCompat.getFont(context, R.font.vazirmatn_bold) }.getOrNull() ?: Typeface.DEFAULT_BOLD
        } else {
            Typeface.create("sans-serif", Typeface.BOLD)
        }
        BubbleArt(labels, typeface, if (persian) 0f else 0.16f, WelcomeFaces.generated())
    }
    LaunchedEffect(art, pictures, remote) {
        val loaded = withContext(Dispatchers.Default) { WelcomeFaces.load(context.applicationContext, pictures, remote) }
        art.replaceFaces(loaded)
    }
    return art
}
