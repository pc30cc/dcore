package app.core.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class BlurHashTest {

    private val hash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj"

    @Test
    fun decodesToTheRequestedSizeOpaque() {
        val pixels = BlurHash.decode(hash, 32, 40)
        assertNotNull(pixels)
        assertEquals(32 * 40, pixels!!.size)
        assertTrue(pixels.all { (it ushr 24) == 0xFF })
    }

    @Test
    fun theImageAveragesToTheDcColour() {
        val pixels = BlurHash.decode(hash, 32, 32)!!
        val dc = BlurHash.averageColour(hash)!!
        fun channel(c: Int, shift: Int) = (c shr shift) and 0xFF
        for (shift in listOf(16, 8, 0)) {
            val mean = pixels.map { channel(it, shift) }.average()
            assertTrue("channel $shift: mean $mean vs dc ${channel(dc, shift)}", abs(mean - channel(dc, shift)) < 24)
        }
    }

    @Test
    fun invalidHashesDecodeToNothing() {
        assertNull(BlurHash.decode("", 8, 8))
        assertNull(BlurHash.decode("short", 8, 8))
        // A wrong length for its component count.
        assertNull(BlurHash.decode(hash.dropLast(2), 8, 8))
        // A character outside the alphabet.
        assertNull(BlurHash.decode(hash.replaceRange(5, 6, "\""), 8, 8))
        assertNull(BlurHash.decode(hash, 0, 8))
    }

    @Test
    fun everySampleHashDecodes() {
        listOf(
            "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
            "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
            "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
            "LKN]Rv%2Tw=w]~RBVZRi};RPxuwH",
            "LPODnIj[~qof-;ayWBj[~qj[M{ay",
            "L9AB*A%LPqys8_H=yDR5nMMeVXR5",
        ).forEach { assertNotNull(it, BlurHash.decode(it, 16, 20)) }
    }
}
