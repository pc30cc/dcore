@file:Suppress("ExifInterface")

package app.core.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A crop in fractions of the (upright) picture: 0..1 on both axes. */
data class CropFrame(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top

    companion object {
        /**
         * The largest [aspect] (width / height) frame centred in a picture of
         * [imageWidth] × [imageHeight]: what "use as is" crops to.
         */
        fun centred(imageWidth: Int, imageHeight: Int, aspect: Float): CropFrame {
            val imageAspect = imageWidth.toFloat() / imageHeight
            return if (imageAspect > aspect) {
                val w = aspect / imageAspect
                CropFrame((1 - w) / 2, 0f, (1 + w) / 2, 1f)
            } else {
                val h = imageAspect / aspect
                CropFrame(0f, (1 - h) / 2, 1f, (1 + h) / 2)
            }
        }

        /**
         * What a crop view shows, as a frame of the picture: a
         * [frameWidth] × [frameHeight] window over the picture scaled to
         * cover it, times [zoom] (≥ 1), moved by [dx], [dy] pixels from
         * centred. The offset is clamped so the window never leaves the picture.
         */
        fun forView(imageWidth: Int, imageHeight: Int, frameWidth: Float, frameHeight: Float, zoom: Float, dx: Float, dy: Float): CropFrame {
            val scale = max(frameWidth / imageWidth, frameHeight / imageHeight) * zoom.coerceAtLeast(1f)
            val shownW = imageWidth * scale
            val shownH = imageHeight * scale
            val x = dx.coerceIn(-(shownW - frameWidth) / 2, (shownW - frameWidth) / 2)
            val y = dy.coerceIn(-(shownH - frameHeight) / 2, (shownH - frameHeight) / 2)
            val left = (shownW / 2 - frameWidth / 2 - x) / shownW
            val top = (shownH / 2 - frameHeight / 2 - y) / shownH
            return CropFrame(left, top, left + frameWidth / shownW, top + frameHeight / shownH)
        }

        /** The largest offset either way that keeps the picture covering the frame. */
        fun maxOffset(imageWidth: Int, imageHeight: Int, frameWidth: Float, frameHeight: Float, zoom: Float): Pair<Float, Float> {
            val scale = max(frameWidth / imageWidth, frameHeight / imageHeight) * zoom.coerceAtLeast(1f)
            return ((imageWidth * scale - frameWidth) / 2).coerceAtLeast(0f) to ((imageHeight * scale - frameHeight) / 2).coerceAtLeast(0f)
        }
    }
}

/** A photo ready to upload: re-encoded (so it carries no EXIF, no GPS), cropped, scaled. */
class PreparedPhoto(val bytes: ByteArray, val width: Int, val height: Int) {
    val mime: String get() = MIME
    companion object {
        const val MIME = "image/jpeg"
    }
}

/**
 * Turns a picked picture into what is uploaded: upright (EXIF orientation
 * applied), cropped to the profile's 4:5, at most [TARGET_LONG_SIDE] tall,
 * JPEG. Decoding re-encodes the pixels only, so nothing of the original file
 * (camera, time, position) travels; the server strips again anyway.
 */
class PhotoPrep(private val context: Context) {

    /** The picture at [uri], upright and at most [PREVIEW_LONG_SIDE] on its long side: what the crop view shows. */
    suspend fun load(uri: Uri): Bitmap = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val size = info.size
                val factor = PREVIEW_LONG_SIDE.toFloat() / max(size.width, size.height)
                if (factor < 1f) decoder.setTargetSize((size.width * factor).roundToInt(), (size.height * factor).roundToInt())
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            loadLegacy(uri)
        }
    }

    /**
     * Android 7-8 only (9+ decodes upright through ImageDecoder): the
     * platform's ExifInterface reads the orientation from a stream there,
     * which is all this needs.
     */
    private fun loadLegacy(uri: Uri): Bitmap {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val sample = sampleSize(bounds.outWidth, bounds.outHeight, PREVIEW_LONG_SIDE)
        val decoded = resolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: error("not a picture")
        val orientation = resolver.openInputStream(uri)?.use {
            ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } ?: ExifInterface.ORIENTATION_NORMAL
        val matrix = orientationMatrix(orientation) ?: return decoded
        return Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).also {
            if (it != decoded) decoded.recycle()
        }
    }

    /** [bitmap] cut to [frame], scaled to fit [TARGET_LONG_SIDE], as JPEG. */
    suspend fun prepare(bitmap: Bitmap, frame: CropFrame): PreparedPhoto = withContext(Dispatchers.Default) {
        val (x, y, w, h) = pixels(bitmap.width, bitmap.height, frame)
        val factor = min(1f, TARGET_LONG_SIDE.toFloat() / max(w, h))
        val matrix = Matrix().apply { if (factor < 1f) setScale(factor, factor) }
        val cropped = Bitmap.createBitmap(bitmap, x, y, w, h, matrix, true)
        val out = ByteArrayOutputStream(256 * 1024)
        cropped.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
        val result = PreparedPhoto(out.toByteArray(), cropped.width, cropped.height)
        if (cropped != bitmap) cropped.recycle()
        result
    }

    companion object {
        /** Profile photos are 4:5, portrait. */
        const val ASPECT: Float = 4f / 5f
        const val TARGET_LONG_SIDE = 1600
        const val PREVIEW_LONG_SIDE = 2400
        const val QUALITY = 86

        /** The power-of-two sample size that keeps the long side at or above [target]. */
        fun sampleSize(width: Int, height: Int, target: Int): Int {
            var sample = 1
            val long = max(width, height)
            while (long / (sample * 2) >= target) sample *= 2
            return sample
        }

        /** [frame] in whole pixels of a [width] × [height] picture, never outside it, never empty. */
        fun pixels(width: Int, height: Int, frame: CropFrame): IntArray {
            val x = (frame.left * width).roundToInt().coerceIn(0, width - 1)
            val y = (frame.top * height).roundToInt().coerceIn(0, height - 1)
            val w = (frame.width * width).roundToInt().coerceIn(1, width - x)
            val h = (frame.height * height).roundToInt().coerceIn(1, height - y)
            return intArrayOf(x, y, w, h)
        }

        fun orientationMatrix(orientation: Int): Matrix? = when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> Matrix().apply { postRotate(90f) }
            ExifInterface.ORIENTATION_ROTATE_180 -> Matrix().apply { postRotate(180f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> Matrix().apply { postRotate(270f) }
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> Matrix().apply { postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> Matrix().apply { postScale(1f, -1f) }
            ExifInterface.ORIENTATION_TRANSPOSE -> Matrix().apply { postRotate(90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> Matrix().apply { postRotate(270f); postScale(-1f, 1f) }
            else -> null
        }
    }
}
