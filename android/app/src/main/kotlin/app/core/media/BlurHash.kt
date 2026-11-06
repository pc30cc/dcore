package app.core.media

import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.withSign

/**
 * Decodes a BlurHash (the compact placeholder string every [app.core.model.Photo]
 * carries) into ARGB pixels: what a photo shows before, or instead of, its
 * bytes.
 *
 * Pure Kotlin, no Android types, so it is unit-tested on the JVM. A tiny
 * image (32 × 40) is all a placeholder needs: it is scaled up with bilinear
 * filtering, which is exactly the softness a placeholder wants.
 */
object BlurHash {

    private const val CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"

    private val lookup: IntArray = IntArray(128) { -1 }.also { table ->
        CHARS.forEachIndexed { index, c -> table[c.code] = index }
    }

    /**
     * The pixels of [hash] at [width] × [height], row-major ARGB, or null when
     * [hash] is not a valid BlurHash (a placeholder then falls back to a flat
     * surface colour). [punch] above 1 strengthens the colour differences.
     */
    fun decode(hash: String, width: Int, height: Int, punch: Float = 1f): IntArray? {
        if (hash.length < 6 || width <= 0 || height <= 0) return null
        val sizeFlag = decode83(hash, 0, 1) ?: return null
        val numY = sizeFlag / 9 + 1
        val numX = sizeFlag % 9 + 1
        if (hash.length != 4 + 2 * numX * numY) return null
        val quantisedMax = decode83(hash, 1, 2) ?: return null
        val maxValue = (quantisedMax + 1) / 166f * punch

        val count = numX * numY
        val colours = FloatArray(count * 3)
        val dc = decode83(hash, 2, 6) ?: return null
        colours[0] = srgbToLinear(dc shr 16)
        colours[1] = srgbToLinear((dc shr 8) and 255)
        colours[2] = srgbToLinear(dc and 255)
        for (i in 1 until count) {
            val ac = decode83(hash, 4 + i * 2, 6 + i * 2) ?: return null
            colours[i * 3] = signedPow2(((ac / (19 * 19)) - 9) / 9f) * maxValue
            colours[i * 3 + 1] = signedPow2((((ac / 19) % 19) - 9) / 9f) * maxValue
            colours[i * 3 + 2] = signedPow2(((ac % 19) - 9) / 9f) * maxValue
        }

        // cos(pi * x * i / width) and cos(pi * y * j / height), once each.
        val cosX = FloatArray(width * numX) { k -> cos(Math.PI * (k / numX) * (k % numX) / width).toFloat() }
        val cosY = FloatArray(height * numY) { k -> cos(Math.PI * (k / numY) * (k % numY) / height).toFloat() }

        val pixels = IntArray(width * height)
        for (y in 0 until height) {
            for (x in 0 until width) {
                var r = 0f
                var g = 0f
                var b = 0f
                for (j in 0 until numY) {
                    val cy = cosY[y * numY + j]
                    for (i in 0 until numX) {
                        val basis = cosX[x * numX + i] * cy
                        val c = (j * numX + i) * 3
                        r += colours[c] * basis
                        g += colours[c + 1] * basis
                        b += colours[c + 2] * basis
                    }
                }
                pixels[y * width + x] = (0xFF shl 24) or (linearToSrgb(r) shl 16) or (linearToSrgb(g) shl 8) or linearToSrgb(b)
            }
        }
        return pixels
    }

    /** The hash's average colour (its DC term) as opaque ARGB, or null when invalid. Cheap: no image decode. */
    fun averageColour(hash: String): Int? {
        if (hash.length < 6) return null
        val dc = decode83(hash, 2, 6) ?: return null
        return (0xFF shl 24) or dc
    }

    private fun decode83(text: String, from: Int, to: Int): Int? {
        var value = 0
        for (index in from until to) {
            val code = text[index].code
            val digit = if (code < lookup.size) lookup[code] else -1
            if (digit < 0) return null
            value = value * 83 + digit
        }
        return value
    }

    private fun srgbToLinear(value: Int): Float {
        val v = value / 255f
        return if (v <= 0.04045f) v / 12.92f else ((v + 0.055f) / 1.055f).pow(2.4f)
    }

    private fun linearToSrgb(value: Float): Int {
        val v = value.coerceIn(0f, 1f)
        val s = if (v <= 0.0031308f) v * 12.92f else 1.055f * v.pow(1 / 2.4f) - 0.055f
        return (s * 255f + 0.5f).toInt().coerceIn(0, 255)
    }

    private fun signedPow2(value: Float): Float = (value * value).withSign(value)
}
