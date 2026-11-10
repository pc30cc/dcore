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
import java.io.File

/**
 * Test plumbing for the screen tours (never part of the app):
 * - `GALLERY_PHOTOS`: a folder of photos (searched recursively). When set,
 *   every photo URL the sample backend hands out is answered with one of
 *   them (the same URL always gets the same photo), so the tours show real
 *   faces instead of BlurHash placeholders.
 * - `SCREENS_TEMPLATE`: `neon` or `white`. When set, every tour runs in
 *   that template whatever the night qualifier of the test says.
 */
object TourPhotos {
    private val files: List<File> by lazy {
        val dir = System.getenv("GALLERY_PHOTOS")?.takeIf { it.isNotBlank() }?.let(::File)?.takeIf { it.isDirectory }
        dir?.walkTopDown()?.filter { it.isFile && it.extension.lowercase() in setOf("jpg", "jpeg", "png") }?.sortedBy { it.path }?.toList().orEmpty()
    }

    /** Whether real photos are drawn (the screens then load photos as on a phone). */
    val enabled: Boolean get() = files.isNotEmpty()

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

    private fun bitmap(url: String): Bitmap = synchronized(decoded) {
        val file = files[(url.substringBefore('?').hashCode() and Int.MAX_VALUE) % files.size]
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
