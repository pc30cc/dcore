package app.core.feature.auth.welcome

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SweepGradient
import android.graphics.Typeface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.core.graphics.createBitmap
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The bubbles' pictures, made once and drawn scaled: the glass (an
 * iridescent rim, rotated per bubble so no two shimmer alike), the light on
 * it (always from the top left), the action words, and the faces cut to
 * circles. A frame only positions bitmaps, with paints kept here, so drawing
 * allocates nothing.
 */
class BubbleArt(
    /** The labelled bubbles' words, already in the screen's language and case. */
    labels: List<String>,
    labelTypeface: Typeface,
    /** Letter spacing for the words (em); 0 for scripts that join. */
    labelTracking: Float,
    faces: List<Bitmap>,
) {
    private val rim: Bitmap = paintRim(GLASS)
    private val light: Bitmap = paintLight(GLASS)
    private val labelSprites: List<Bitmap> = labels.map { paintLabel(it, labelTypeface, labelTracking, LABEL, filled = true) }
    private val coreWord: Bitmap? = labels.firstOrNull()?.let { paintLabel(it, labelTypeface, labelTracking, LABEL, filled = false) }

    /** The faces as circles; replaced when pictures arrive. */
    @Volatile var faces: List<Bitmap> = faces.map { faceSprite(it) }
        private set

    /** Bumped when [faces] changes, and read by [draw]: a still scene redraws with the new faces too. */
    private var facesVersion by mutableIntStateOf(0)

    /** On the main thread. */
    fun replaceFaces(pictures: List<Bitmap>) {
        if (pictures.isEmpty()) return
        faces = pictures.map { faceSprite(it) }
        facesVersion++
    }

    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dst = RectF()

    /**
     * Draws [field] onto [canvas] (scene pixels): the opening bubble's back,
     * the bubbles from the smallest up, the opening bubble's glass over the
     * ones it holds, then droplets and flashes.
     */
    fun draw(canvas: Canvas, field: BubbleField, density: Float) {
        val t = field.time
        if (field.coreAlpha > 0f && field.coreR > 0f) drawCoreBack(canvas, field)
        facesVersion
        val faceList = faces
        for (k in 0 until field.count) {
            val i = field.order[k]
            if (field.state[i] == BubbleField.POPPED) continue
            val radius = field.r[i]
            if (radius < 0.5f) continue
            val squash = field.wobble[i] * sin(t * 17f + field.phase[i])
            canvas.save()
            canvas.translate(field.x[i], field.y[i])
            canvas.scale(1f + squash, 1f - squash)
            val kind = field.kind[i]
            val label = BubbleField.labelIn(kind)
            when {
                label >= 0 && label < labelSprites.size -> blit(canvas, labelSprites[label], radius, 255)
                kind >= 0 && faceList.isNotEmpty() -> blit(canvas, faceList[kind % faceList.size], radius * FACE_SHARE, 255)
            }
            canvas.rotate(field.phase[i] * 57.3f + t * 9f)
            blit(canvas, rim, radius, 255)
            canvas.rotate(-(field.phase[i] * 57.3f + t * 9f))
            blit(canvas, light, radius, 255)
            canvas.restore()
        }
        if (field.coreAlpha > 0f && field.coreR > 0f) drawCoreFront(canvas, field)
        drawDroplets(canvas, field, density)
    }

    private fun drawCoreBack(canvas: Canvas, field: BubbleField) {
        val a = (field.coreAlpha * 255).toInt()
        corePaint.color = Color.argb((a * 0.10f).toInt(), 255, 236, 228)
        canvas.drawCircle(field.coreX, field.coreY, field.coreR, corePaint)
    }

    private fun drawCoreFront(canvas: Canvas, field: BubbleField) {
        val a = (field.coreAlpha * 255).toInt()
        canvas.save()
        canvas.translate(field.coreX, field.coreY)
        coreWord?.let { blit(canvas, it, field.coreR * 0.5f, a) }
        canvas.rotate(field.time * 14f + 30f)
        blit(canvas, rim, field.coreR, a)
        canvas.rotate(-(field.time * 14f + 30f))
        blit(canvas, light, field.coreR, a)
        canvas.restore()
    }

    private fun drawDroplets(canvas: Canvas, field: BubbleField, density: Float) {
        for (p in 0 until BubbleField.PARTICLES) {
            val life = field.particleLife[p]
            if (life <= 0f) continue
            val fade = min(1f, life / (BubbleField.PARTICLE_LIFE * 0.6f))
            dotPaint.color = TINTS[field.particleTint[p] % TINTS.size]
            dotPaint.alpha = (fade * 235).toInt()
            canvas.drawCircle(field.particleX[p], field.particleY[p], field.particleSize[p], dotPaint)
        }
        for (k in 0 until BubbleField.RINGS) {
            val age = field.ringAge[k]
            if (age < 0f) continue
            val f = age / BubbleField.RING_LIFE
            ringPaint.color = Color.WHITE
            ringPaint.alpha = ((1f - f) * 170).toInt()
            ringPaint.strokeWidth = max(1f, 2.2f * density * (1f - f))
            canvas.drawCircle(field.ringX[k], field.ringY[k], field.ringR[k] * (1f + 0.38f * f), ringPaint)
        }
    }

    private fun blit(canvas: Canvas, sprite: Bitmap, radius: Float, alpha: Int) {
        dst.set(-radius, -radius, radius, radius)
        bitmapPaint.alpha = alpha
        canvas.drawBitmap(sprite, null, dst, bitmapPaint)
    }

    /** Draws one bubble with face [face] at ([cx], [cy]): the sheet's little cluster uses it. */
    fun drawBadge(canvas: Canvas, cx: Float, cy: Float, radius: Float, face: Int, spin: Float) {
        facesVersion
        val faceList = faces
        canvas.save()
        canvas.translate(cx, cy)
        if (faceList.isNotEmpty()) blit(canvas, faceList[Math.floorMod(face, faceList.size)], radius * FACE_SHARE, 255)
        canvas.rotate(spin)
        blit(canvas, rim, radius, 255)
        canvas.rotate(-spin)
        blit(canvas, light, radius, 255)
        canvas.restore()
    }

    companion object {
        /** Sprite sizes in pixels: the glass is drawn up to the opening bubble's size, words and faces smaller. */
        const val GLASS = 384
        const val LABEL = 256
        const val FACE = 224

        /** How much of a bubble its face fills (the rest is glass). */
        const val FACE_SHARE = 0.9f

        /** The rim's thin-film colours, also the droplets'. */
        private val TINTS = intArrayOf(
            0xFFFF9AC8.toInt(), 0xFFFFD877.toInt(), 0xFF97F0CE.toInt(), 0xFF86C0FF.toInt(), 0xFFC1A1FF.toInt(), 0xFFFFB3A1.toInt(),
        )

        private fun paintRim(size: Int): Bitmap {
            val bitmap = createBitmap(size, size)
            val canvas = Canvas(bitmap)
            val c = size / 2f
            val r = c - 1f
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            // The glass body: clear in the middle, a little milky toward the edge.
            paint.shader = RadialGradient(
                c, c, r,
                intArrayOf(0x00FFFFFF, 0x00FFFFFF, 0x12FFFFFF, 0x30FFFFFF, 0x00FFFFFF),
                floatArrayOf(0f, 0.62f, 0.86f, 0.975f, 1f),
                Shader.TileMode.CLAMP,
            )
            canvas.drawCircle(c, c, r, paint)
            // The thin-film rim: rainbow colours through a ring-shaped mask.
            val layer = canvas.saveLayer(0f, 0f, size.toFloat(), size.toFloat(), null)
            paint.shader = RadialGradient(
                c, c, r,
                intArrayOf(0x00FFFFFF, 0x00FFFFFF, 0x99FFFFFF.toInt(), 0xF0FFFFFF.toInt(), 0x00FFFFFF),
                floatArrayOf(0f, 0.74f, 0.9f, 0.975f, 1f),
                Shader.TileMode.CLAMP,
            )
            canvas.drawCircle(c, c, r, paint)
            paint.shader = SweepGradient(
                c, c,
                intArrayOf(
                    0xFFFF8CC6.toInt(), 0xFFFFD36E.toInt(), 0xFFFFF4D6.toInt(), 0xFF8BEFC9.toInt(), 0xFF7DB8FF.toInt(),
                    0xFFB596FF.toInt(), 0xFFFF9EC2.toInt(), 0xFFFFE7B0.toInt(), 0xFFFF8CC6.toInt(),
                ),
                null,
            )
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), paint)
            paint.xfermode = null
            canvas.restoreToCount(layer)
            // A crisp edge.
            paint.shader = null
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = size / 160f
            paint.color = 0x80FFFFFF.toInt()
            canvas.drawCircle(c, c, r - paint.strokeWidth / 2f, paint)
            return bitmap
        }

        private fun paintLight(size: Int): Bitmap {
            val bitmap = createBitmap(size, size)
            val canvas = Canvas(bitmap)
            val c = size / 2f
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            fun glint(cx: Float, cy: Float, rx: Float, ry: Float, angle: Float, alpha: Int) {
                canvas.save()
                canvas.translate(c + cx * c, c + cy * c)
                canvas.rotate(angle)
                canvas.scale(1f, ry / rx)
                paint.shader = RadialGradient(
                    0f, 0f, rx * c,
                    intArrayOf(Color.argb(alpha, 255, 255, 255), Color.argb(alpha / 2, 255, 255, 255), 0x00FFFFFF),
                    floatArrayOf(0f, 0.45f, 1f),
                    Shader.TileMode.CLAMP,
                )
                canvas.drawCircle(0f, 0f, rx * c, paint)
                canvas.restore()
            }
            // The window the light comes through, top left, and its small hard core.
            glint(-0.40f, -0.46f, 0.36f, 0.17f, -38f, 0xE6)
            glint(-0.52f, -0.28f, 0.07f, 0.07f, 0f, 0xF2)
            // The answering reflection, bottom right, fainter.
            glint(0.42f, 0.52f, 0.30f, 0.09f, -40f, 0x5C)
            return bitmap
        }

        private fun paintLabel(word: String, typeface: Typeface, tracking: Float, size: Int, filled: Boolean): Bitmap {
            val bitmap = createBitmap(size, size)
            val canvas = Canvas(bitmap)
            val c = size / 2f
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            if (filled) {
                // Dark, smoky glass, so the white word reads on any background.
                paint.shader = RadialGradient(
                    c * 0.8f, c * 0.75f, c,
                    intArrayOf(0xB0521A1E.toInt(), 0xC83A0C12.toInt(), 0xD82A070B.toInt()),
                    floatArrayOf(0f, 0.7f, 1f),
                    Shader.TileMode.CLAMP,
                )
                canvas.drawCircle(c, c, c - 1f, paint)
                paint.shader = null
            }
            paint.color = Color.WHITE
            paint.typeface = typeface
            paint.letterSpacing = tracking
            paint.textAlign = Paint.Align.CENTER
            // As large as fits: at most a quarter of the bubble high, 70 % of it wide.
            var textSize = size * 0.20f
            paint.textSize = textSize
            val maxWidth = size * 0.70f
            val width = paint.measureText(word)
            if (width > maxWidth) {
                textSize *= maxWidth / width
                paint.textSize = textSize
            }
            paint.setShadowLayer(size * 0.02f, 0f, size * 0.006f, 0x66000000)
            val metrics = paint.fontMetrics
            canvas.drawText(word, c, c - (metrics.ascent + metrics.descent) / 2f, paint)
            return bitmap
        }

        /** [picture] cropped to its centre square, as a circle with a soft shade at the edge. */
        fun faceSprite(picture: Bitmap): Bitmap {
            val size = FACE
            val bitmap = createBitmap(size, size)
            val canvas = Canvas(bitmap)
            val side = min(picture.width, picture.height).toFloat()
            val scale = size / side
            val matrix = Matrix().apply {
                setScale(scale, scale)
                postTranslate(-(picture.width - side) / 2f * scale, -(picture.height - side) / 2f * scale)
            }
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            paint.shader = BitmapShader(picture, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
            val c = size / 2f
            canvas.drawCircle(c, c, c, paint)
            paint.shader = RadialGradient(
                c, c, c,
                intArrayOf(0x00000000, 0x00000000, 0x40200A08),
                floatArrayOf(0f, 0.72f, 1f),
                Shader.TileMode.CLAMP,
            )
            canvas.drawCircle(c, c, c, paint)
            return bitmap
        }
    }
}
