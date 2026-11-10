package app.core.ui.gallery

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import androidx.annotation.ColorInt
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.createBitmap

/**
 * Illustrated stand-ins for the component gallery when it runs without
 * photos (`GALLERY_PHOTOS` unset): a warm gradient behind a simple figure
 * (head, hair, shoulders), drawn with shapes on a canvas and framed close.
 * Test code only: the app never draws them.
 *
 * Drawn on a 100 x 100 grid scaled to the bitmap; each index is a fixed
 * combination, so the same index always looks the same.
 */
object GeneratedFaces {

    /** How many different figures there are. */
    val count: Int get() = LOOKS.size

    fun paint(index: Int, size: Int): Bitmap {
        val look = LOOKS[Math.floorMod(index, LOOKS.size)]
        val bitmap = createBitmap(size, size)
        val canvas = Canvas(bitmap)
        canvas.scale(size / 100f, size / 100f)
        Figure(canvas, look).draw()
        return bitmap
    }

    private class Look(
        val background: Int,
        val skin: Int,
        val hair: Int,
        val style: Int,
        val shirt: Int,
    )

    private class Figure(private val canvas: Canvas, look: Look) {
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
        private val path = Path()
        private val oval = RectF()
        private val bg = BACKGROUNDS[look.background]
        private val skin = SKINS[look.skin]
        private val hair = HAIRS[look.hair]
        private val style = look.style
        private val shirt = SHIRTS[look.shirt]

        fun draw() {
            background()
            // Close up, as a portrait in a circle: the head about half the square, the shoulders cut by the edge.
            canvas.translate(50f, 47f)
            canvas.scale(ZOOM, ZOOM)
            canvas.translate(-50f, -47f)
            backHair()
            body()
            head()
            frontHair()
            features()
        }

        private fun background() {
            fill.shader = LinearGradient(0f, 0f, 100f, 100f, bg[0], bg[1], Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, 100f, 100f, fill)
            fill.shader = RadialGradient(32f, 22f, 70f, 0x3DFFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, 100f, 100f, fill)
            fill.shader = null
        }

        private fun backHair() {
            fill.color = hair
            when (style) {
                LONG -> roundRect(27f, 27f, 73f, 94f, 20f)
                BOB -> roundRect(27f, 25f, 73f, 67f, 17f)
                WAVY -> {
                    roundRect(26f, 26f, 74f, 86f, 22f)
                    for (k in 0..3) {
                        canvas.drawCircle(27f, 48f + k * 10f, 6f, fill)
                        canvas.drawCircle(73f, 48f + k * 10f, 6f, fill)
                    }
                }
                BUN -> canvas.drawCircle(50f, 18f, 10f, fill)
                CURLY -> for (k in 0..8) {
                    val a = Math.toRadians(180.0 + k * 22.5)
                    canvas.drawCircle(50f + 20f * Math.cos(a).toFloat(), 44f + 21f * Math.sin(a).toFloat(), 9.5f, fill)
                }
            }
        }

        private fun body() {
            val neck = shade(skin, 0.10f)
            fill.color = neck
            roundRect(42.5f, 56f, 57.5f, 82f, 6f)
            fill.color = shirt
            oval.set(12f, 75f, 88f, 140f)
            canvas.drawOval(oval, fill)
            // The neckline.
            fill.color = neck
            path.reset()
            path.moveTo(42f, 76.5f)
            path.quadTo(50f, 89f, 58f, 76.5f)
            path.close()
            canvas.drawPath(path, fill)
            // A soft fold of light on the shoulders.
            fill.shader = LinearGradient(0f, 75f, 0f, 100f, 0x26FFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP)
            canvas.drawOval(oval, fill)
            fill.shader = null
        }

        private fun head() {
            fill.color = shade(skin, 0.06f)
            canvas.drawCircle(33.6f, 46f, 3.8f, fill)
            canvas.drawCircle(66.4f, 46f, 3.8f, fill)
            fill.color = skin
            oval.set(34f, 25f, 66f, 64f)
            canvas.drawOval(oval, fill)
            fill.shader = RadialGradient(44f, 36f, 30f, 0x2EFFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP)
            canvas.drawOval(oval, fill)
            fill.shader = null
        }

        private fun frontHair() {
            fill.color = hair
            path.reset()
            when (style) {
                SHORT -> {
                    path.moveTo(32.5f, 45f)
                    path.cubicTo(29f, 19f, 71f, 17f, 67.5f, 45f)
                    path.lineTo(65.5f, 36f)
                    path.quadTo(52f, 29f, 35f, 37.5f)
                    path.close()
                }
                LONG, WAVY, BOB -> {
                    path.moveTo(33f, 50f)
                    path.cubicTo(30f, 18f, 70f, 18f, 67f, 50f)
                    path.quadTo(63f, 34f, 49f, 31.5f)
                    path.quadTo(39f, 35f, 33f, 50f)
                    path.close()
                }
                BUN -> {
                    path.moveTo(34f, 42f)
                    path.cubicTo(33f, 23f, 67f, 23f, 66f, 42f)
                    path.quadTo(50f, 30f, 34f, 42f)
                    path.close()
                }
                CURLY -> {
                    for ((cx, cy) in CURLS) canvas.drawCircle(cx, cy, 7.2f, fill)
                    return
                }
                else -> {
                    fill.color = ColorUtils.blendARGB(hair, skin, 0.35f)
                    path.moveTo(34.5f, 40f)
                    path.cubicTo(34f, 24f, 66f, 24f, 65.5f, 40f)
                    path.quadTo(50f, 31f, 34.5f, 40f)
                    path.close()
                }
            }
            canvas.drawPath(path, fill)
        }

        private fun features() {
            fill.color = ColorUtils.blendARGB(hair, 0xFF000000.toInt(), 0.35f)
            oval.set(43f, 44.2f, 46.2f, 48.2f)
            canvas.drawOval(oval, fill)
            oval.set(53.8f, 44.2f, 57f, 48.2f)
            canvas.drawOval(oval, fill)
            fill.color = 0x40FF7F78
            canvas.drawCircle(40.5f, 52f, 3.4f, fill)
            canvas.drawCircle(59.5f, 52f, 3.4f, fill)
            val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                strokeWidth = 1.7f
                strokeCap = Paint.Cap.ROUND
                color = ColorUtils.setAlphaComponent(shade(skin, 0.55f), 0xD0)
            }
            path.reset()
            path.moveTo(45.5f, 53.5f)
            path.quadTo(50f, 57.5f, 54.5f, 53.5f)
            canvas.drawPath(path, stroke)
        }

        private fun roundRect(l: Float, t: Float, r: Float, b: Float, radius: Float) {
            oval.set(l, t, r, b)
            canvas.drawRoundRect(oval, radius, radius, fill)
        }

        @ColorInt
        private fun shade(@ColorInt color: Int, amount: Float): Int = ColorUtils.blendARGB(color, 0xFF3A1A10.toInt(), amount)
    }

    private const val ZOOM = 1.6f

    private const val SHORT = 0
    private const val LONG = 1
    private const val BUN = 2
    private const val CURLY = 3
    private const val BOB = 4
    private const val WAVY = 5
    private const val BUZZ = 6

    private val CURLS = listOf(
        35f to 38f, 37.5f to 30.5f, 43f to 25.5f, 50f to 24f, 57f to 25.5f, 62.5f to 30.5f, 65f to 38f,
    )

    private val BACKGROUNDS = arrayOf(
        intArrayOf(0xFFFFC7AE.toInt(), 0xFFF0775A.toInt()),
        intArrayOf(0xFFFFDDA6.toInt(), 0xFFEF9A42.toInt()),
        intArrayOf(0xFFFBBCD2.toInt(), 0xFFD65A82.toInt()),
        intArrayOf(0xFFF8D2E0.toInt(), 0xFFD27A9A.toInt()),
        intArrayOf(0xFFFFE2C6.toInt(), 0xFFF29A5E.toInt()),
        intArrayOf(0xFFFFD0C8.toInt(), 0xFFE0706A.toInt()),
        intArrayOf(0xFFF7CFDC.toInt(), 0xFFAA5A80.toInt()),
        intArrayOf(0xFFF6DBBB.toInt(), 0xFFC8734F.toInt()),
    )
    private val SKINS = intArrayOf(
        0xFFF7D9C4.toInt(), 0xFFEFC19E.toInt(), 0xFFDCA27A.toInt(), 0xFFBF8259.toInt(), 0xFF9A613F.toInt(), 0xFF6F4531.toInt(),
    )
    private val HAIRS = intArrayOf(
        0xFF2A1B15.toInt(), 0xFF4B2E20.toInt(), 0xFF7B4B2C.toInt(), 0xFFB5763E.toInt(), 0xFFD9B46F.toInt(), 0xFF1D1C22.toInt(), 0xFF8E3D2C.toInt(),
    )
    private val SHIRTS = intArrayOf(
        0xFFFFFBF7.toInt(), 0xFF302C50.toInt(), 0xFFF3E3C6.toInt(), 0xFF2F6F6A.toInt(), 0xFFE25D6E.toInt(), 0xFFF0B46E.toInt(), 0xFF3D5A8C.toInt(), 0xFF7A4E8C.toInt(),
    )

    /** Background, skin, hair, style and shirt: picked by hand so neighbours differ and nothing clashes. */
    private val LOOKS = listOf(
        Look(0, 1, 0, LONG, 1),
        Look(4, 3, 5, SHORT, 0),
        Look(2, 0, 3, BUN, 6),
        Look(1, 4, 0, CURLY, 3),
        Look(3, 2, 1, BOB, 5),
        Look(5, 1, 6, WAVY, 1),
        Look(7, 5, 5, BUZZ, 4),
        Look(6, 0, 4, LONG, 3),
        Look(0, 3, 1, SHORT, 7),
        Look(4, 1, 2, WAVY, 4),
        Look(1, 2, 0, BOB, 6),
        Look(2, 4, 5, SHORT, 2),
        Look(5, 0, 2, BUN, 1),
        Look(3, 5, 0, CURLY, 5),
        Look(7, 1, 3, LONG, 7),
        Look(6, 3, 1, BUZZ, 0),
    )
}
