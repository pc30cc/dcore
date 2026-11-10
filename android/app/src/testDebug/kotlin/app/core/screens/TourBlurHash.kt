package app.core.screens

import android.graphics.Bitmap
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.withSign

/** A BlurHash encoder (the reference algorithm), for photos a tour stages as blurred tiles. */
object TourBlurHash {

    private const val CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"

    fun encode(bitmap: Bitmap, xComponents: Int, yComponents: Int): String {
        require(xComponents in 1..9 && yComponents in 1..9)
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
        val factors = Array(xComponents * yComponents) { DoubleArray(3) }
        for (j in 0 until yComponents) for (i in 0 until xComponents) {
            val norm = if (i == 0 && j == 0) 1.0 else 2.0
            var r = 0.0
            var g = 0.0
            var b = 0.0
            for (y in 0 until h) for (x in 0 until w) {
                val basis = norm * cos(PI * i * x / w) * cos(PI * j * y / h)
                val p = pixels[y * w + x]
                r += basis * toLinear((p shr 16) and 0xFF)
                g += basis * toLinear((p shr 8) and 0xFF)
                b += basis * toLinear(p and 0xFF)
            }
            val scale = 1.0 / (w * h)
            factors[j * xComponents + i] = doubleArrayOf(r * scale, g * scale, b * scale)
        }
        val out = StringBuilder()
        out.append(base83((xComponents - 1) + (yComponents - 1) * 9, 1))
        val ac = factors.drop(1)
        val maximum: Double
        if (ac.isNotEmpty()) {
            val actual = ac.maxOf { f -> f.maxOf { abs(it) } }
            val quantised = floor(max(0.0, min(82.0, floor(actual * 166 - 0.5)))).toInt()
            maximum = (quantised + 1) / 166.0
            out.append(base83(quantised, 1))
        } else {
            maximum = 1.0
            out.append(base83(0, 1))
        }
        val dc = factors[0]
        out.append(base83((toSrgb(dc[0]) shl 16) + (toSrgb(dc[1]) shl 8) + toSrgb(dc[2]), 4))
        for (f in ac) {
            fun q(v: Double) = floor(max(0.0, min(18.0, floor(signPow(v / maximum, 0.5) * 9 + 9.5)))).toInt()
            out.append(base83(q(f[0]) * 19 * 19 + q(f[1]) * 19 + q(f[2]), 2))
        }
        return out.toString()
    }

    private fun base83(value: Int, length: Int): String {
        val sb = StringBuilder()
        for (i in 1..length) {
            val digit = (value / 83.0.pow(length - i).toInt()) % 83
            sb.append(CHARS[digit])
        }
        return sb.toString()
    }

    private fun toLinear(c: Int): Double {
        val v = c / 255.0
        return if (v <= 0.04045) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
    }

    private fun toSrgb(v: Double): Int {
        val c = v.coerceIn(0.0, 1.0)
        return if (c <= 0.0031308) (c * 12.92 * 255 + 0.5).toInt() else ((1.055 * c.pow(1 / 2.4) - 0.055) * 255 + 0.5).toInt()
    }

    private fun signPow(v: Double, exp: Double): Double = abs(v).pow(exp).withSign(v)
}
