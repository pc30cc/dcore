package app.core.push

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import androidx.core.graphics.PathParser
import androidx.core.graphics.createBitmap
import app.core.common.runCatchingUnlessCancelled
import app.core.media.ImageLoading
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.toBitmap
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The match's face for a call's notifications: their photo in a circle, or,
 * without one (or one that will not load in time), a person silhouette on a
 * quiet circle. Never left to the system, which draws a `Person` without an
 * icon as a letter on a coloured disc.
 */
internal object CallerFace {

    /**
     * The photo through the app's own image loader (its memory and disk
     * caches first, where a match's face usually already is), within
     * [timeoutMillis]: a ring does not wait for a slow network.
     */
    suspend fun photo(context: Context, url: String?, timeoutMillis: Long = PHOTO_TIMEOUT_MS): Bitmap? {
        if (url == null) return null
        return withTimeoutOrNull(timeoutMillis) {
            runCatchingUnlessCancelled {
                val request = ImageRequest.Builder(context)
                    .data(url)
                    .memoryCacheKey(ImageLoading.cacheKey(url))
                    .diskCacheKey(ImageLoading.cacheKey(url))
                    .size(FACE_PX)
                    // A notification is drawn by another process, which a
                    // hardware bitmap cannot be handed to.
                    .allowHardware(false)
                    .build()
                (ImageLoading.loader(context).execute(request) as? SuccessResult)?.image?.toBitmap()
            }.getOrNull()
        }
    }

    /** The face itself: [photo] cropped to a circle, or the silhouette. */
    fun face(photo: Bitmap?): Bitmap {
        val face = createBitmap(FACE_PX, FACE_PX)
        val canvas = Canvas(face)
        val radius = FACE_PX / 2f
        if (photo != null && photo.width > 0 && photo.height > 0) {
            val scale = maxOf(FACE_PX.toFloat() / photo.width, FACE_PX.toFloat() / photo.height)
            val matrix = Matrix().apply {
                setScale(scale, scale)
                postTranslate((FACE_PX - photo.width * scale) / 2f, (FACE_PX - photo.height * scale) / 2f)
            }
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
                shader = BitmapShader(photo, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
            }
            canvas.drawCircle(radius, radius, radius, paint)
            return face
        }
        canvas.drawCircle(radius, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = QUIET_FILL })
        val box = FACE_PX * PERSON_BOX
        val glyph = PathParser.createPathFromPathData(PERSON_PATH)
        glyph.transform(
            Matrix().apply {
                setScale(box / GRID, box / GRID)
                postTranslate((FACE_PX - box) / 2f, (FACE_PX - box) / 2f)
            },
        )
        canvas.drawPath(glyph, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = QUIET_GLYPH })
        return face
    }

    /** Large enough for the full-screen ring, small enough to travel to the system in a notification. */
    private const val FACE_PX = 192

    private const val PHOTO_TIMEOUT_MS = 2_000L

    /** The silhouette's 24-unit grid, and its share of the circle. */
    private const val GRID = 24f
    private const val PERSON_BOX = 0.62f

    /** A head and shoulders on a 24-unit grid (Material's "person", Apache 2.0). */
    private const val PERSON_PATH =
        "M12,12c2.21,0 4,-1.79 4,-4s-1.79,-4 -4,-4 -4,1.79 -4,4 1.79,4 4,4zM12,14c-2.67,0 -8,1.34 -8,4v2h16v-2c0,-2.66 -5.33,-4 -8,-4z"

    /**
     * Two fixed greys: the system draws a call notification in its own light
     * or dark, which this cannot read, and a mid grey under a lighter figure
     * reads on both.
     */
    private const val QUIET_FILL = 0xFF8E939C.toInt()
    private const val QUIET_GLYPH = 0xFFE8EAEE.toInt()
}
