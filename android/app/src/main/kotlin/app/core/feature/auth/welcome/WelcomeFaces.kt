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

    /** The thread that painted [generated] (tests: never the main one). */
    @Volatile internal var paintedOn: Thread? = null
        private set

    /** The generated figures as bubble sprites if this process painted them already, else null. Cheap: for the first frame. */
    fun generatedIfReady(): List<Bitmap>? = generated

    /**
     * The generated figures as bubble sprites ([BubbleArt.faceSprite]),
     * painted once per process. Sixteen canvases of figures and their circles:
     * call it off the main thread ([rememberBubbleArt] does, on
     * [Dispatchers.Default]).
     */
    fun generated(): List<Bitmap> = generated ?: synchronized(this) {
        generated ?: List(GENERATED) { i ->
            val figure = GeneratedFaces.paint(i, BubbleArt.FACE)
            BubbleArt.faceSprite(figure).also { figure.recycle() }
        }.also {
            paintedOn = Thread.currentThread()
            generated = it
        }
    }

    /** Forgets what was painted, so a test sees a first launch. */
    internal fun forgetForTest() = synchronized(this) {
        generated = null
        paintedOn = null
        synchronized(pictures) { pictures.clear() }
    }

    /** A picture already decoded and cut, as [load] keeps it (tests: a brand picture without an asset file). */
    internal fun keepForTest(source: WelcomePicture, sprite: Bitmap) = synchronized(pictures) { pictures[source] = sprite }

    /**
     * The brand's pictures as bubble sprites, decoded (or fetched) and cut
     * once and kept for the process; off the main thread. With [remote] off
     * (previews, screen tests) config URLs are skipped. Fewer than
     * [MIN_PICTURES] are mixed with generated figures, so a short list does
     * not repeat the same few faces.
     */
    suspend fun load(context: Context, sources: List<WelcomePicture>, remote: Boolean): List<Bitmap> {
        if (sources.isEmpty()) return emptyList()
        val loaded = sources.mapNotNull { source ->
            synchronized(pictures) { pictures[source] }?.let { return@mapNotNull it }
            val bitmap = when (source) {
                is WelcomePicture.Asset -> decodeAsset(context, source.name)
                is WelcomePicture.Remote -> if (remote) fetch(context, source.url) else null
            }
            bitmap?.let(BubbleArt::portrait)?.let(BubbleArt::faceSprite)?.also { synchronized(pictures) { pictures[source] = it } }
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

    private const val GENERATED = 16
    private const val MIN_PICTURES = 6
}

/**
 * The bubbles' art for this screen: the action [labels] drawn in the
 * screen's script; the faces painted on [Dispatchers.Default] (once per
 * process: a second visit has them from the first frame), the bubbles
 * showing their empty glass until then; the brand's pictures once loaded.
 * When [pictures] change (the server's config arriving after the brand's
 * own list was shown) the faces on screen stay until the new ones are
 * ready, and stay for good if none of the new ones load: the generated
 * figures stand in only while the bubbles have no face at all.
 */
@Composable
fun rememberBubbleArt(pictures: List<WelcomePicture>, labels: List<String>, persian: Boolean): BubbleArt {
    val context = LocalContext.current
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current
    val art = remember(labels, persian) {
        val typeface = if (persian) {
            runCatching { ResourcesCompat.getFont(context, R.font.brand_fa_bold) }.getOrNull() ?: Typeface.DEFAULT_BOLD
        } else {
            Typeface.create("sans-serif", Typeface.BOLD)
        }
        BubbleArt(
            labels,
            typeface,
            labelTracking = if (persian) 0f else 0.06f,
            faceSprites = WelcomeFaces.generatedIfReady().orEmpty(),
            labelSize = if (persian) BubbleArt.PERSIAN_LABEL_SHARE else BubbleArt.LABEL_SHARE,
        )
    }
    LaunchedEffect(art, pictures, remote) {
        if (art.faces.isEmpty()) art.replaceFaces(withContext(Dispatchers.Default) { WelcomeFaces.generated() })
        val loaded = withContext(Dispatchers.Default) { WelcomeFaces.load(context.applicationContext, pictures, remote) }
        art.replaceFaces(loaded)
    }
    return art
}
