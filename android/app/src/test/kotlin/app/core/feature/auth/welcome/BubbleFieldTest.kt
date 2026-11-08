package app.core.feature.auth.welcome

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.management.ManagementFactory
import kotlin.math.hypot

/** The welcome's bubbles on a 411 x 891 dp phone at xhdpi (2 px per dp). */
class BubbleFieldTest {

    private val dp = 2f
    private val width = 411 * dp
    private val height = 891 * dp
    private val bandTop = 230 * dp
    private val bandBottom = 700 * dp
    private val text = floatArrayOf(24 * dp, 30 * dp, width - 24 * dp, 215 * dp)
    // Only the text is kept clear; the bubbles may pass behind the buttons.
    private val keepOut = text

    private fun field(intro: Boolean, top: Float = bandTop, bottom: Float = bandBottom) =
        BubbleField(dp).apply { layout(width, height, top, bottom, keepOut, startIntro = intro) }

    private fun BubbleField.run(seconds: Float, frame: Float = 1f / 60f) {
        var t = 0f
        while (t < seconds) {
            step(frame)
            t += frame
        }
    }

    private fun BubbleField.label(i: Int) = BubbleField.labelIn(kind[i]) >= 0

    private fun BubbleField.inside(i: Int, rect: FloatArray, at: Int): Boolean {
        val l = rect[at]
        val t = rect[at + 1]
        val r = rect[at + 2]
        val b = rect[at + 3]
        val cx = x[i].coerceIn(l, r)
        val cy = y[i].coerceIn(t, b)
        return hypot(x[i] - cx, y[i] - cy) < this.r[i] * 0.5f
    }

    @Test
    fun `a phone-sized band holds 20 to 28 bubbles, with one word bubble and some empty glass`() {
        val f = field(intro = false)
        assertTrue("${f.count}", f.count in 20..28)
        assertEquals(1, (0 until f.count).count { f.label(it) })
        assertTrue((0 until f.count).any { f.kind[it] == BubbleField.EMPTY })
        // Back to front by size.
        for (k in 1 until f.count) assertTrue(f.baseR[f.order[k - 1]] <= f.baseR[f.order[k]])
    }

    @Test
    fun `a smaller band (large text) holds fewer, smaller bubbles`() {
        val big = field(intro = false)
        val small = field(intro = false, top = 400 * dp, bottom = 690 * dp)
        assertTrue(small.count < big.count)
        assertTrue(small.baseR[0] < big.baseR[0])
    }

    @Test
    fun `homes lie in the band, words whole on screen, faces at most two thirds past a side`() {
        val f = field(intro = false)
        for (i in 0 until f.count) {
            assertTrue("bubble $i above the band", f.homeY[i] - f.baseR[i] * 0.8f >= bandTop - 1f)
            assertTrue("bubble $i below the band", f.homeY[i] + f.baseR[i] <= bandBottom + 1f)
            val margin = if (f.label(i)) f.baseR[i] else f.baseR[i] * 0.35f
            assertTrue("bubble $i past the left", f.homeX[i] >= margin - 1f)
            assertTrue("bubble $i past the right", f.homeX[i] <= width - margin + 1f)
        }
        // The word bubble lives near the cluster's middle.
        val word = (0 until f.count).single { f.label(it) }
        val middleY = (bandTop + bandBottom) / 2f
        assertTrue(hypot(f.homeX[word] - width / 2f, f.homeY[word] - middleY) <= 58 * dp)
    }

    @Test
    fun `the cluster gathers toward the middle, and a few faces are cut by the sides`() {
        val f = field(intro = false)
        val middleY = (bandTop + bandBottom) / 2f
        val near = (0 until f.count).count { hypot(f.homeX[it] - width / 2f, f.homeY[it] - middleY) < 150 * dp }
        assertTrue("$near of ${f.count} within 150 dp of the middle", near >= f.count / 2)
        val cut = (0 until f.count).count { !f.label(it) && (f.homeX[it] - f.baseR[it] < 0f || f.homeX[it] + f.baseR[it] > width) }
        assertTrue("$cut faces cut by the sides", cut in 1..6)
    }

    @Test
    fun `the opening holds every bubble inside one, bursts it, and sends them home`() {
        val f = field(intro = true)
        f.run(0.5f)
        assertTrue(f.coreAlpha > 0.9f && f.coreR > 0f)
        for (i in 0 until f.count) {
            assertEquals(BubbleField.HELD, f.state[i])
            assertTrue(hypot(f.x[i] - f.coreX, f.y[i] - f.coreY) + f.r[i] <= f.coreR * 1.02f)
            // The word bubble waits in the very middle, where the large bubble shows its word.
            if (f.label(i)) assertEquals(0f, hypot(f.x[i] - f.coreX, f.y[i] - f.coreY), 0.01f)
        }
        f.run(BubbleField.BURST_AT - 0.5f + 0.05f)
        assertEquals(0f, f.coreR)
        assertTrue((0 until f.count).none { f.state[it] == BubbleField.HELD })
        assertTrue("droplets of the burst", (0 until BubbleField.PARTICLES).any { f.particleLife[it] > 0f })
        val word = (0 until f.count).single { f.label(it) }
        assertTrue("the word bubble starts where the word was", hypot(f.x[word] - f.coreX, f.y[word] - f.coreY) < 12 * dp)
        assertEquals(0, f.wordFrom)

        f.run(5f)
        for (i in 0 until f.count) {
            // Some homes reach the top while rising and come back from below: those are on their way.
            if (f.state[i] != BubbleField.FREE) continue
            val away = hypot(f.x[i] - f.homeX[i], f.y[i] - f.homeY[i])
            assertTrue("bubble $i is ${away / dp} dp from home", away < 48 * dp)
            assertTrue("bubble $i stays out of the text", !f.inside(i, text, 0))
            if (f.label(i)) assertTrue("word $i is cut by the edge", f.x[i] - f.r[i] >= -2 * dp && f.x[i] + f.r[i] <= width + 2 * dp)
        }
    }

    @Test
    fun `floating bubbles touch and overlap a little, never one inside another`() {
        val f = field(intro = true)
        f.run(8f)
        for (i in 0 until f.count) for (j in i + 1 until f.count) {
            if (f.state[i] != BubbleField.FREE || f.state[j] != BubbleField.FREE) continue
            val d = hypot(f.x[i] - f.x[j], f.y[i] - f.y[j])
            val overlap = f.r[i] + f.r[j] - d
            assertTrue("$i and $j overlap by ${overlap / dp} dp", overlap < 0.15f * (f.r[i] + f.r[j]) + minOf(f.r[i], f.r[j]) * 0.25f)
        }
    }

    @Test
    fun `the homes rise, and a bubble whose home reaches the top fades out and comes back from below`() {
        val f = field(intro = false)
        val i = (0 until f.count).filter { !f.label(it) }.minBy { f.homeY[it] }
        val start = f.homeY[i]
        f.run(1f)
        assertTrue("its home rose", f.homeY[i] < start - 2 * dp)
        var t = 0f
        while (f.state[i] != BubbleField.LEAVING && t < 30f) {
            f.step(1f / 60f)
            t += 1f / 60f
        }
        assertEquals(BubbleField.LEAVING, f.state[i])
        assertTrue("its home is at the top", f.homeY[i] < bandTop + f.baseR[i])
        while (f.state[i] != BubbleField.FREE && t < 40f) {
            f.step(1f / 60f)
            t += 1f / 60f
        }
        assertEquals(BubbleField.FREE, f.state[i])
        assertTrue("it comes back from below the screen", f.y[i] >= height)
        assertTrue("to a home near the bottom of the band", f.homeY[i] > bandBottom - 80 * dp - f.baseR[i])
        assertTrue("no droplets for a quiet exit", (0 until BubbleField.PARTICLES).none { f.particleLife[it] > 0f })
    }

    @Test
    fun `the word bubble shows its words in turn, and a pop brings the next one`() {
        val f = field(intro = false)
        val word = (0 until f.count).single { f.label(it) }
        assertEquals(0, f.wordFrom)
        f.run(BubbleField.WORD_EVERY + BubbleField.WORD_FADE / 2f)
        assertEquals(0, f.wordFrom)
        assertEquals(1, f.wordTo)
        assertTrue("${f.wordMix}", f.wordMix in 0.2f..0.8f)
        f.run(BubbleField.WORD_FADE)
        assertEquals(1, f.wordFrom)
        assertEquals(0f, f.wordMix)
        assertTrue(f.pop(word))
        f.run(5f)
        assertEquals(BubbleField.FREE, f.state[word])
        assertEquals(2, f.wordFrom)
    }

    @Test
    fun `without the opening every bubble rests at home, and stays still when not stepped`() {
        val f = field(intro = false)
        for (i in 0 until f.count) {
            assertEquals(BubbleField.FREE, f.state[i])
            assertEquals(f.homeX[i], f.x[i])
            assertEquals(f.homeY[i], f.y[i])
            assertEquals(f.baseR[i], f.r[i])
        }
        assertEquals(0f, f.coreR)
    }

    @Test
    fun `the bubbles keep moving while they float`() {
        val f = field(intro = false)
        f.run(1f)
        val before = f.x.copyOf()
        f.run(2f)
        assertTrue((0 until f.count).any { kotlin.math.abs(f.x[it] - before[it]) > 2 * dp })
    }

    @Test
    fun `a tap finds the front bubble, a pop sprays droplets, and the bubble forms again at the bottom`() {
        val f = field(intro = false)
        val front = f.order[f.count - 1]
        assertEquals(front, f.hit(f.x[front], f.y[front]))
        assertEquals(-1, f.hit(width / 2f, 20 * dp))
        assertTrue(f.pop(front))
        assertEquals(BubbleField.POPPED, f.state[front])
        assertEquals(-1, f.hit(f.x[front], f.y[front]).takeIf { it == front } ?: -1)
        f.run(0.05f)
        assertTrue((0 until BubbleField.PARTICLES).any { f.particleLife[it] > 0f })
        assertTrue((0 until BubbleField.RINGS).any { f.ringAge[it] >= 0f })
        var t = 0f
        while (f.state[front] != BubbleField.FREE && t < 6f) {
            f.step(1f / 60f)
            t += 1f / 60f
        }
        assertEquals(BubbleField.FREE, f.state[front])
        assertTrue("it rises in from below the screen", f.y[front] >= height)
        f.run(6f)
        assertTrue(hypot(f.x[front] - f.homeX[front], f.y[front] - f.homeY[front]) < 48 * dp)
        assertTrue((0 until BubbleField.PARTICLES).none { f.particleLife[it] > 0f })
    }

    @Test
    fun `a dragged bubble follows the finger, a fling throws it, and it floats back`() {
        val f = field(intro = false)
        // A large one low in the band (its home will not reach the top while this runs).
        val i = (0 until f.count).filter { !f.label(it) && f.homeY[it] > (bandTop + bandBottom) / 2f }.maxBy { f.baseR[it] }
        val home = f.homeX[i] to f.homeY[i]
        f.grab(i, f.x[i], f.y[i])
        assertEquals(BubbleField.DRAGGED, f.state[i])
        f.dragTo(f.x[i] + 60 * dp, f.y[i] + 40 * dp)
        f.run(0.3f)
        assertTrue(hypot(f.x[i] - home.first - 60 * dp, f.y[i] - home.second - 40 * dp) < 6 * dp)
        val x0 = f.x[i]
        f.release(-1500 * dp, 0f)
        assertEquals(BubbleField.FREE, f.state[i])
        f.run(0.2f)
        assertTrue("flung to the left", f.x[i] < x0 - 40 * dp)
        f.run(8f)
        assertEquals(BubbleField.FREE, f.state[i])
        assertTrue(hypot(f.x[i] - f.homeX[i], f.y[i] - f.homeY[i]) < 48 * dp)
    }

    @Test
    fun `a new measure moves the homes without starting over`() {
        val f = field(intro = false)
        val count = f.count
        f.layout(width, height, bandTop + 40 * dp, bandBottom, keepOut, startIntro = true)
        assertEquals(count, f.count)
        assertEquals(0f, f.coreR)
        assertTrue((0 until f.count).none { f.state[it] == BubbleField.HELD })
    }

    @Test
    fun `the same seed lays out the same scene`() {
        val a = field(intro = false)
        val b = field(intro = false)
        for (i in 0 until a.count) assertEquals(a.homeX[i], b.homeX[i])
        assertNotEquals(a.homeX[0], a.homeX[1])
    }

    @Test
    fun `a frame allocates nothing`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        val f = field(intro = true)
        // Warm up (class loading, the first pops).
        f.run(2f)
        f.pop(f.order[f.count - 1])
        f.grab(f.order[3], f.x[f.order[3]], f.y[f.order[3]])
        f.run(0.5f)
        val thread = Thread.currentThread().id
        val before = bean.getThreadAllocatedBytes(thread)
        for (k in 0 until 3_000) {
            f.dragTo(300f + k % 50, 900f)
            f.step(1f / 60f)
        }
        val allocated = bean.getThreadAllocatedBytes(thread) - before
        assertTrue("3000 frames allocated $allocated bytes", allocated < 2_048)
    }
}
