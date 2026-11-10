package app.core.screens

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import app.core.media.ImageLoading
import app.core.ui.theme.AppTemplate
import app.core.ui.theme.Templates
import coil3.ImageLoader
import coil3.asImage
import coil3.decode.DataSource
import coil3.intercept.Interceptor
import coil3.request.ImageResult
import coil3.request.SuccessResult
import coil3.request.crossfade
import kotlinx.coroutines.Dispatchers
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runners.model.Statement
import org.robolectric.RuntimeEnvironment
import java.io.File

/**
 * Test plumbing for the screen tours (never part of the app):
 * - `GALLERY_PHOTOS`: a folder of photos (searched recursively). When set,
 *   every photo URL the sample backend hands out is answered with one of
 *   them (the same URL always gets the same photo; a URL whose path ends
 *   with a file's path under the folder gets that file), so the tours show
 *   real faces instead of BlurHash placeholders.
 * - `SCREENS_TEMPLATE`: `neon` or `white`. When set, every tour runs in
 *   that template whatever the night qualifier of the test says.
 * - `SCREENS_FONT_SCALE`: a font scale such as `1.3`. When set, every tour
 *   runs at that scale whatever its `@Config` says ([TourFontScale]).
 */
object TourPhotos {
    private val files: List<File> by lazy {
        val dir = System.getenv("GALLERY_PHOTOS")?.takeIf { it.isNotBlank() }?.let(::File)?.takeIf { it.isDirectory }
        dir?.walkTopDown()?.filter { it.isFile && it.extension.lowercase() in setOf("jpg", "jpeg", "png") }?.sortedBy { it.path }?.toList().orEmpty()
    }

    /** The pictures of people under `GALLERY_PHOTOS` (its `people/`, `photos/` and `faces/` folders). */
    private val portraits: List<File> by lazy {
        files.filter { file -> file.invariantSeparatorsPath.split('/').any { it in PORTRAIT_FOLDERS } }
    }

    private val PORTRAIT_FOLDERS = setOf("people", "photos", "faces")

    /** Whether real photos are drawn (the screens then load photos as on a phone). */
    val enabled: Boolean get() = files.isNotEmpty()

    /**
     * The welcome's pictures for the sample config, one list for every
     * template as `/v1/config` sends it: the design's seven orbit faces (the
     * middle one first; 320 px crops, too small for the framed photo), then
     * the design's portrait, the first picture large enough for white's
     * frame. Nothing without `GALLERY_PHOTOS`.
     */
    fun welcomeImages(): List<String> {
        if (!enabled) return emptyList()
        val names = listOf("faces/w1.jpg", "faces/m2.jpg", "faces/w8.jpg", "faces/m4.jpg", "faces/w11.jpg", "faces/w12.jpg", "faces/m11.jpg") +
            "photos/hd-1623577840329-201565179c92.jpg"
        return names.map { "https://media.example.com/welcome/$it" }
    }

    /** The bytes of [paths] under `GALLERY_PHOTOS` (a person's own photos to pick), or null unless every one is there. */
    fun files(vararg paths: String): List<ByteArray>? {
        val dir = root ?: return null
        val found = paths.map { File(dir, it) }
        return if (found.all { it.isFile }) found.map { it.readBytes() } else null
    }

    /** Only the design's orbit faces: what white shows when no picture fits its frame. */
    fun welcomeFacesOnly(): List<String> = welcomeImages().take(7)

    /**
     * Sample photo ids a tour shows as given files under `GALLERY_PHOTOS`
     * (the design's own people), so a screen can be laid next to its
     * mockup; tours reset it in their `@After`.
     */
    @Volatile var photoAliases: Map<String, String> = emptyMap()

    /** The font scale asked for by `SCREENS_FONT_SCALE`, or null. */
    val fontScale: Float? = System.getenv("SCREENS_FONT_SCALE")?.toFloatOrNull()?.takeIf { it > 0f }

    /** The template asked for by `SCREENS_TEMPLATE`, or null. */
    val template: AppTemplate? = System.getenv("SCREENS_TEMPLATE")?.takeIf { it in Templates.ids }?.let { Templates.of(it) }

    private val decoded = HashMap<String, Bitmap>()

    /** Puts the local-photo loader in place of the app's (the app reads it through [ImageLoading.loader]). */
    fun install(context: Context) {
        if (!enabled) return
        val loader = ImageLoader.Builder(context.applicationContext)
            .components { add(LocalPhotos()) }
            .coroutineContext(Dispatchers.Unconfined)
            .build()
        val field = ImageLoading::class.java.getDeclaredField("loader")
        field.isAccessible = true
        field.set(ImageLoading, loader)
    }

    private val root: File? get() = System.getenv("GALLERY_PHOTOS")?.takeIf { it.isNotBlank() }?.let(::File)

    /**
     * The photo a URL stands for: the file under `GALLERY_PHOTOS` its path
     * ends with (`…/welcome/faces/w1.jpg` → `faces/w1.jpg`), so a tour can
     * name the design's own pictures; else one picked by the URL's hash.
     */
    private fun fileFor(url: String): File {
        val segments = url.substringBefore('?').substringAfter("://").split('/').drop(1)
        val dir = root
        if (dir != null) {
            // A sample photo a tour named ([photoAliases]): `…/p/<id>/…` gets that file.
            val id = segments.getOrNull(segments.indexOf("p") + 1)
            photoAliases[id]?.let { File(dir, it) }?.takeIf { it.isFile }?.let { return it }
            for (start in segments.indices) {
                val candidate = File(dir, segments.drop(start).joinToString("/"))
                if (candidate.isFile) return candidate
            }
        }
        // Any other URL: a picture of a person (never a design asset such as a template swatch).
        val people = portraits.ifEmpty { files }
        return people[(url.substringBefore('?').hashCode() and Int.MAX_VALUE) % people.size]
    }

    /**
     * The blurhash of the file a tour named for sample photo [id]
     * ([photoAliases]), so a blurred tile shows that picture blurred; null
     * without one.
     */
    fun blurhashFor(id: String): String? {
        val file = root?.let { dir -> photoAliases[id]?.let { File(dir, it) } }?.takeIf { it.isFile } ?: return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        val sample = maxOf(1, minOf(bounds.outWidth, bounds.outHeight) / 64)
        val small = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        return TourBlurHash.encode(small, xComponents = 4, yComponents = 5)
    }

    private fun bitmap(url: String): Bitmap = synchronized(decoded) {
        val file = fileFor(url)
        decoded.getOrPut(file.path) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            val sample = maxOf(1, minOf(bounds.outWidth, bounds.outHeight) / 720)
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    }

    /**
     * Answers every request at once with a local photo: no network, no disk
     * cache, and no crossfade (it runs on the wall clock, which a test's
     * frame clock does not move, so a captured screen would show the photo
     * still transparent).
     */
    private class LocalPhotos : Interceptor {
        override suspend fun intercept(chain: Interceptor.Chain): ImageResult =
            SuccessResult(
                image = bitmap(chain.request.data.toString()).asImage(),
                request = chain.request.newBuilder().crossfade(false).build(),
                dataSource = DataSource.MEMORY,
            )
    }
}

/**
 * Applies [TourPhotos.fontScale] before the activity starts: ordered before
 * the compose rule, so the activity, its dialogs and its sheets are created
 * with that configuration. Does nothing without `SCREENS_FONT_SCALE`.
 */
class TourFontScale : TestRule {
    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
        override fun evaluate() {
            TourPhotos.fontScale?.let(RuntimeEnvironment::setFontScale)
            base.evaluate()
        }
    }
}
