package app.core.media

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class PhotoCropMathTest {

    private fun near(expected: Float, actual: Float) = assertEquals(expected, actual, 0.0001f)

    @Test
    fun `use as is takes the largest centred 3 by 4 frame`() {
        // A landscape picture: full height, a centred band of the width.
        val wide = CropFrame.centred(4000, 3000, PhotoPrep.ASPECT)
        near(0f, wide.top)
        near(1f, wide.bottom)
        near(0.5625f, wide.width)
        near(0.21875f, wide.left)
        // A tall picture: full width, a centred band of the height.
        val tall = CropFrame.centred(1000, 2000, PhotoPrep.ASPECT)
        near(0f, tall.left)
        near(2f / 3f, tall.height)
        near(1f / 6f, tall.top)
    }

    @Test
    fun `the view's zoom and offset give the frame, never outside the picture`() {
        // A window of the profile's shape (3:4) over a landscape picture.
        val centred = CropFrame.forView(4000, 3000, 300f, 400f, zoom = 1f, dx = 0f, dy = 0f)
        near(CropFrame.centred(4000, 3000, PhotoPrep.ASPECT).left, centred.left)
        near(1f, centred.height)
        // Twice the zoom: half the frame, still centred.
        val zoomed = CropFrame.forView(4000, 3000, 300f, 400f, zoom = 2f, dx = 0f, dy = 0f)
        near(centred.width / 2, zoomed.width)
        near(0.25f, zoomed.top)
        // Moving the picture right shows more of its left side; too far is clamped at the edge.
        val moved = CropFrame.forView(4000, 3000, 300f, 400f, zoom = 1f, dx = 10_000f, dy = 0f)
        near(0f, moved.left)
        val (maxX, maxY) = CropFrame.maxOffset(4000, 3000, 300f, 400f, 1f)
        near(0f, maxY)
        near((4000 * (400f / 3000) - 300f) / 2, maxX)
    }

    @Test
    fun `crop pixels stay inside the picture and are never empty`() {
        assertArrayEquals(intArrayOf(0, 0, 100, 100), PhotoPrep.pixels(100, 100, CropFrame(-0.2f, -0.1f, 1.3f, 1.2f)))
        assertArrayEquals(intArrayOf(99, 99, 1, 1), PhotoPrep.pixels(100, 100, CropFrame(1f, 1f, 1f, 1f)))
        assertArrayEquals(intArrayOf(35, 0, 30, 100), PhotoPrep.pixels(100, 100, CropFrame(0.35f, 0f, 0.65f, 1f)))
    }

    @Test
    fun `decoding samples down by powers of two to just above the target`() {
        assertEquals(1, PhotoPrep.sampleSize(2000, 1500, 2400))
        assertEquals(2, PhotoPrep.sampleSize(4000, 3000, 1600))
        assertEquals(4, PhotoPrep.sampleSize(12000, 9000, 2400))
    }
}
