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
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SweepGradient
import android.graphics.Typeface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.core.graphics.createBitmap
import androidx.core.graphics.withTranslation
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The bubbles' pictures, made once and drawn scaled: the glass (a thin
 * iridescent film at the rim with a soft halo outside it, rotated per bubble
 * so no two shimmer alike), the light on it (always from the top left), the
 * action words, and the faces cut to circles. The large opening bubble's rim
 * is stroked with shaders made once at unit size, so it stays crisp at any
 * size. A frame only positions bitmaps and transforms the canvas, with paints
 * kept here, so drawing allocates nothing.
 */
class BubbleArt(
    /** The word bubble's words, already in the screen's language and case. */
    labels: List<String>,
    labelTypeface: Typeface,
    /** Letter spacing for the words (em); 0 for scripts that join. */
    labelTracking: Float,
    /**
     * The faces, already cut to circles ([faceSprite], made off the main
     * thread). Empty until they are ready: the bubbles show their glass alone.
     */
    faceSprites: List<Bitmap> = emptyList(),
    /**
     * The words' wanted size as a share of the bubble's diameter, before a
     * long word makes it smaller: [LABEL_SHARE] for Latin capitals, more
     * for a script whose letters stand lower at the same font size (Persian).
     */
    labelSize: Float = LABEL_SHARE,
) {
    private val rim: Bitmap = paintRim(GLASS)
    private val light: Bitmap = paintLight(GLASS)

    /**
     * The words' size as a share of the word bubble's diameter: [labelSize]
     * ([LABEL_SHARE]: 13 sp in the 31 dp bubble), smaller for a long word so
     * every word's ink stays inside [LABEL_REACH] of the radius. All words
     * share it, so the crossfade does not change size.
     */
    val labelShare: Float = fitLabels(labels, labelTypeface, labelTracking, labelSize)
    private val labelSprites: List<Bitmap> = labels.map { paintLabel(it, labelTypeface, labelTracking, labelShare, filled = true) }
    private val coreWord: Bitmap? = labels.firstOrNull()?.let { paintLabel(it, labelTypeface, labelTracking, labelShare, filled = false) }

    /** The faces as circles; empty until the first ones are ready, replaced when pictures arrive. */
    @Volatile var faces: List<Bitmap> = faceSprites
        private set

    /** Bumped when [faces] changes, and read by [draw]: a still scene redraws with the new faces too. */
    private var facesVersion by mutableIntStateOf(0)

    /** On the main thread, with sprites made elsewhere ([faceSprite]): nothing is painted here. */
    fun replaceFaces(sprites: List<Bitmap>) {
        if (sprites.isEmpty() || sprites === faces) return
        faces = sprites
        facesVersion++
    }

    /** The word bubble's radius (px) at which its words are [minTextPx] high (font size): [BubbleField.wordMinRadius]. */
    fun wordRadiusFor(minTextPx: Float): Float = minTextPx / (2f * labelShare)

    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dst = RectF()

    // The opening bubble's glass, at unit size: the canvas is scaled to its radius.
    private val coreFilm = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        shader = SweepGradient(0f, 0f, FILM, null)
    }
    private val coreEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 0.006f
        color = 0xB0FFFFFF.toInt()
    }
    private val coreBody = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        shader = RadialGradient(0f, 0f, 1f, BODY_COLORS, BODY_STOPS, Shader.TileMode.CLAMP)
    }
    private val coreHalo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        shader = RadialGradient(0f, 0f, HALO, HALO_COLORS, HALO_STOPS, Shader.TileMode.CLAMP)
    }

    /**
     * Draws [field] onto [canvas] (scene pixels): the opening bubble's back,
     * the bubbles from the smallest up (the ones it still holds faint, as if
     * seen through its glass), the opening bubble's glass over them, then
     * droplets and flashes.
     */
    fun draw(canvas: Canvas, field: BubbleField, density: Float) {
        val t = field.time
        val core = field.coreAlpha > 0f && field.coreR > 0f
        if (core) drawCoreBack(canvas, field)
        facesVersion
        val faceList = faces
        for (k in 0 until field.count) {
            val i = field.order[k]
            val state = field.state[i]
            if (state == BubbleField.POPPED) continue
            val radius = field.r[i]
            if (radius < 0.5f) continue
            val kind = field.kind[i]
            val label = BubbleField.labelIn(kind) >= 0
            // The word bubble waits unseen in the opening bubble's middle, where its word shows.
            if (label && state == BubbleField.HELD) continue
            val alpha = if (state == BubbleField.HELD) HELD_ALPHA else 255
            val squash = field.wobble[i] * sin(t * 17f + field.phase[i])
            canvas.withTranslation(field.x[i], field.y[i]) {
                scale(1f + squash, 1f - squash)
                when {
                    label -> drawWord(this, field, radius)
                    // No faces yet (still being painted): the glass alone.
                    kind >= 0 && faceList.isNotEmpty() -> blit(this, faceList[kind % faceList.size], radius * FACE_SHARE, alpha)
                }
                val spin = field.phase[i] * 57.3f + t * 9f
                rotate(spin)
                blit(this, rim, radius * HALO, alpha)
                rotate(-spin)
                blit(this, light, radius, alpha)
            }
        }
        if (core) drawCoreFront(canvas, field, density)
        drawDroplets(canvas, field, density)
    }

    /** The word bubble: its word, crossfading into the next one when the field says so. */
    private fun drawWord(canvas: Canvas, field: BubbleField, radius: Float) {
        if (labelSprites.isEmpty()) return
        val from = labelSprites[field.wordFrom % labelSprites.size]
        val to = labelSprites[field.wordTo % labelSprites.size]
        val mix = field.wordMix
        if (mix <= 0f || from === to) {
            blit(canvas, from, radius, 255)
        } else {
            val a = (mix * 255f).toInt()
            blit(canvas, from, radius, 255 - a)
            blit(canvas, to, radius, a)
        }
    }

    private fun drawCoreBack(canvas: Canvas, field: BubbleField) {
        val a = (field.coreAlpha * 255).toInt()
        corePaint.color = Color.argb((a * 0.10f).toInt(), 255, 236, 228)
        canvas.drawCircle(field.coreX, field.coreY, field.coreR, corePaint)
    }

    private fun drawCoreFront(canvas: Canvas, field: BubbleField, density: Float) {
        val a = (field.coreAlpha * 255).toInt()
        val r = field.coreR
        canvas.save()
        canvas.translate(field.coreX, field.coreY)
        // The word, as large as the word bubble's: the opening bubble is that bubble, grown.
        coreWord?.let { blit(canvas, it, if (field.wordRadius > 0f) field.wordRadius else LABEL_DP * density, a) }
        canvas.save()
        canvas.scale(r, r)
        canvas.rotate(field.time * 14f + 30f)
        coreHalo.alpha = a
        canvas.drawCircle(0f, 0f, HALO, coreHalo)
        coreBody.alpha = a
        canvas.drawCircle(0f, 0f, 1f, coreBody)
        // The film: a soft wide band and a bright narrow one inside the edge, then the edge itself.
        coreFilm.strokeWidth = 0.060f
        coreFilm.alpha = (a * 0.25f).toInt()
        canvas.drawCircle(0f, 0f, 1f - 0.035f, coreFilm)
        coreFilm.strokeWidth = 0.035f
        coreFilm.alpha = (a * 0.75f).toInt()
        canvas.drawCircle(0f, 0f, 1f - 0.022f, coreFilm)
        coreEdge.alpha = (a * 0xB0) / 255
        canvas.drawCircle(0f, 0f, 1f - 0.003f, coreEdge)
        canvas.restore()
        blit(canvas, light, r, a)
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
        canvas.withTranslation(cx, cy) {
            if (faceList.isNotEmpty()) blit(this, faceList[Math.floorMod(face, faceList.size)], radius * FACE_SHARE, 255)
            rotate(spin)
            blit(this, rim, radius * HALO, 255)
            rotate(-spin)
            blit(this, light, radius, 255)
        }
    }

    companion object {
        /** Sprite sizes in pixels: the glass is drawn up to the largest bubble's size, words and faces smaller. */
        const val GLASS = 384
        const val LABEL = 320
        const val FACE = 224

        /**
         * The words' font size as a share of the word bubble's diameter: 13 sp
         * in the 31 dp bubble (it was 0.135, about 8 sp). The bubble grows for
         * larger text ([wordRadiusFor]), so the share holds at any text size.
         */
        const val LABEL_SHARE = 13f / 62f

        /**
         * Persian letters stand lower than Latin capitals at the same font
         * size: its words are a quarter larger (16 sp in the 31 dp bubble),
         * which its short words leave room for.
         */
        const val PERSIAN_LABEL_SHARE = LABEL_SHARE * 1.25f

        /** How far from the middle a word's ink may reach, as a share of the radius (the dark glass ends at 1). */
        const val LABEL_REACH = 0.82f

        /** How much of a bubble its face fills: nearly all, the film is thin. */
        const val FACE_SHARE = 0.965f

        /** The halo outside the film: the rim's sprite reaches this far past the bubble's edge. */
        private const val HALO = 1.06f

        /** The word bubble's radius (dp): the opening bubble's word is drawn at this size too. */
        const val LABEL_DP = 31f

        /** The bubbles still inside the opening bubble, seen through its glass. */
        private const val HELD_ALPHA = 140

        /** The thin film's colours: pink, gold, a pale warm white, sky, lilac, rose, honey. */
        private val FILM = intArrayOf(
            0xFFFF7EB6.toInt(), 0xFFFFC56B.toInt(), 0xFFFFF1D6.toInt(), 0xFF8FD3FF.toInt(), 0xFFB596FF.toInt(),
            0xFFFF9EC2.toInt(), 0xFFFFD98A.toInt(), 0xFFFF7EB6.toInt(),
        )

        /** The droplets: the film's colours. */
        private val TINTS = intArrayOf(
            0xFFFF7EB6.toInt(), 0xFFFFC56B.toInt(), 0xFFFFF1D6.toInt(), 0xFF8FD3FF.toInt(), 0xFFB596FF.toInt(), 0xFFFF9EC2.toInt(),
        )

        /** The glass body: clear almost to the edge, a breath of white just inside it. */
        private val BODY_COLORS = intArrayOf(0x00FFFFFF, 0x00FFFFFF, 0x10FFFFFF, 0x26FFFFFF, 0x00FFFFFF)
        private val BODY_STOPS = floatArrayOf(0f, 0.80f, 0.93f, 0.985f, 1f)

        /** The halo, as stops of [HALO]: nothing inside the bubble, a soft white just outside it, fading out. */
        private val HALO_COLORS = intArrayOf(0x00FFFFFF, 0x00FFFFFF, 0x38FFFFFF, 0x00FFFFFF)
        private val HALO_STOPS = floatArrayOf(0f, 1f / HALO - 0.004f, 1f / HALO, 1f)

        private fun paintRim(size: Int): Bitmap {
            val bitmap = createBitmap(size, size)
            val canvas = Canvas(bitmap)
            val c = size / 2f
            // The bubble's own radius in the sprite; the rest, out to its edge, is the halo.
            val r = c / HALO - 1f
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            paint.shader = RadialGradient(c, c, c, HALO_COLORS, HALO_STOPS, Shader.TileMode.CLAMP)
            canvas.drawCircle(c, c, c, paint)
            paint.shader = RadialGradient(c, c, r, BODY_COLORS, BODY_STOPS, Shader.TileMode.CLAMP)
            canvas.drawCircle(c, c, r, paint)
            // The thin film: its colours through a narrow ring-shaped mask just inside the edge.
            val layer = canvas.saveLayer(0f, 0f, size.toFloat(), size.toFloat(), null)
            paint.shader = RadialGradient(
                c, c, r,
                intArrayOf(0x00FFFFFF, 0x00FFFFFF, 0x70FFFFFF, 0xF0FFFFFF.toInt(), 0x00FFFFFF),
                floatArrayOf(0f, 0.88f, 0.95f, 0.985f, 1f),
                Shader.TileMode.CLAMP,
            )
            canvas.drawCircle(c, c, r, paint)
            paint.shader = SweepGradient(c, c, FILM, null)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), paint)
            paint.xfermode = null
            canvas.restoreToCount(layer)
            // A crisp edge.
            paint.shader = null
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = size / 220f
            paint.color = 0xB0FFFFFF.toInt()
            canvas.drawCircle(c, c, r - paint.strokeWidth / 2f, paint)
            return bitmap
        }

        private fun paintLight(size: Int): Bitmap {
            val bitmap = createBitmap(size, size)
            val canvas = Canvas(bitmap)
            val c = size / 2f
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            fun glint(cx: Float, cy: Float, rx: Float, ry: Float, angle: Float, alpha: Int) {
                canvas.withTranslation(c + cx * c, c + cy * c) {
                    rotate(angle)
                    scale(1f, ry / rx)
                    paint.shader = RadialGradient(
                        0f, 0f, rx * c,
                        intArrayOf(Color.argb(alpha, 255, 255, 255), Color.argb(alpha / 2, 255, 255, 255), 0x00FFFFFF),
                        floatArrayOf(0f, 0.45f, 1f),
                        Shader.TileMode.CLAMP,
                    )
                    drawCircle(0f, 0f, rx * c, paint)
                }
            }
            // A soft bloom where the light comes in, top left, and its small bright point.
            glint(-0.40f, -0.46f, 0.40f, 0.24f, -38f, 0x8C)
            glint(-0.52f, -0.28f, 0.045f, 0.045f, 0f, 0xE0)
            // The answering reflection, bottom right, faint.
            glint(0.42f, 0.52f, 0.30f, 0.09f, -40f, 0x2E)
            return bitmap
        }

        /** A paint for the words at [share] of the sprite's size. */
        private fun labelPaint(typeface: Typeface, tracking: Float, share: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            this.typeface = typeface
            letterSpacing = tracking
            textAlign = Paint.Align.CENTER
            textSize = LABEL * share
        }

        /**
         * The words' share of the diameter: [LABEL_SHARE], or less when a word's
         * ink at that size would reach past [LABEL_REACH] of the radius (its
         * box's half-diagonal: the corners stay inside the round glass).
         */
        internal fun fitLabels(words: List<String>, typeface: Typeface, tracking: Float, wanted: Float = LABEL_SHARE): Float {
            val paint = labelPaint(typeface, tracking, wanted)
            val bounds = Rect()
            var reach = 0f
            for (word in words) {
                if (word.isEmpty()) continue
                paint.getTextBounds(word, 0, word.length, bounds)
                val halfWidth = max(paint.measureText(word), bounds.width().toFloat()) / 2f
                val halfHeight = bounds.height() / 2f
                reach = max(reach, sqrt(halfWidth * halfWidth + halfHeight * halfHeight))
            }
            val allowed = LABEL / 2f * LABEL_REACH
            return if (reach <= allowed || reach <= 0f) wanted else wanted * allowed / reach
        }

        private fun paintLabel(word: String, typeface: Typeface, tracking: Float, share: Float, filled: Boolean): Bitmap {
            val size = LABEL
            val bitmap = createBitmap(size, size)
            val canvas = Canvas(bitmap)
            val c = size / 2f
            if (filled) {
                // Translucent dark glass, lit from a little above, so the white word reads on any background.
                val glass = Paint(Paint.ANTI_ALIAS_FLAG)
                glass.shader = RadialGradient(
                    c, c * 0.8f, c,
                    intArrayOf(0x8C6A2430.toInt(), 0xA63A0C16.toInt(), 0xC02A070D.toInt()),
                    floatArrayOf(0f, 0.7f, 1f),
                    Shader.TileMode.CLAMP,
                )
                canvas.drawCircle(c, c, c - 1f, glass)
            }
            val paint = labelPaint(typeface, tracking, share)
            paint.setShadowLayer(size * 0.02f, 0f, size * 0.006f, 0x66000000)
            // Centred on its ink, not on the font's line: a script with tall
            // line metrics (Persian) would otherwise sit high or low.
            val bounds = Rect()
            paint.getTextBounds(word, 0, word.length, bounds)
            canvas.drawText(word, c, c - (bounds.top + bounds.bottom) / 2f, paint)
            return bitmap
        }

        /**
         * A portrait cropped close to the face: a square of 80 % of its short
         * side, centred a little above its middle, where faces sit in a
         * portrait. For the brand's pictures; the generated figures are
         * drawn close already.
         */
        fun portrait(picture: Bitmap): Bitmap {
            val side = (min(picture.width, picture.height) * 0.8f).toInt().coerceAtLeast(1)
            val left = (picture.width - side) / 2
            val top = (picture.height * 0.42f - side / 2f).toInt().coerceIn(0, max(0, picture.height - side))
            return Bitmap.createBitmap(picture, left, top, side, side)
        }

        /** [picture] cropped to its centre square, as a circle that brightens toward its rim. */
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
                intArrayOf(0x00FFFFFF, 0x00FFFFFF, 0x33FFFFFF),
                floatArrayOf(0f, 0.78f, 1f),
                Shader.TileMode.CLAMP,
            )
            canvas.drawCircle(c, c, c, paint)
            return bitmap
        }
    }
}
