package app.core.feature.auth.welcome

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.media.LocalRemoteImages
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.lang.management.ManagementFactory
import kotlin.math.sqrt

/**
 * The bubbles' art: the faces painted once, off the main thread, with the
 * glass alone until then; the word bubble's word readable (13 sp or more at
 * the phone's text size) and inside its bubble; a frame that allocates nothing.
 * Real text measurement (native graphics).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BubbleArtTest {

    @get:Rule val compose = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val persian = listOf("لایک", "مچ", "چت")
    private val turkish = listOf("BEĞEN", "EŞLEŞ", "SOHBET")
    private val english = listOf("LIKE", "MATCH", "CHAT")

    private fun persianFace(): Typeface = ResourcesCompat.getFont(context, R.font.brand_fa_bold)!!
    private fun sans(): Typeface = Typeface.create("sans-serif", Typeface.BOLD)

    @Before fun firstLaunch() = WelcomeFaces.forgetForTest()

    @After fun clean() = WelcomeFaces.forgetForTest()

    @Test
    fun theFacesArePaintedOffTheMainThreadOnceAndTheGlassShowsUntilThen() {
        var firstFrameFaces = -1
        var art: BubbleArt? = null
        compose.setContent {
            val remembered = rememberBubbleArt(emptyList(), persian, persian = true)
            SideEffect {
                if (firstFrameFaces < 0) firstFrameFaces = remembered.faces.size
                art = remembered
            }
        }
        compose.waitUntil(10_000) { art?.faces?.size == 16 }
        assertEquals("the first frame has the empty glass only", 0, firstFrameFaces)
        val painter = WelcomeFaces.paintedOn
        assertNotNull(painter)
        assertNotSame("painted off the main thread", Looper.getMainLooper().thread, painter)
        // Cached for the process: a second screen has them at its first frame, the same bitmaps.
        val cached = WelcomeFaces.generatedIfReady()
        assertSame(cached, WelcomeFaces.generated())
        val shown = art!!
        assertSame(cached, shown.faces)
        assertTrue(shown.faces.all { it.width == BubbleArt.FACE && it.height == BubbleArt.FACE })
    }

    @Test
    fun picturesThatArriveLaterAndFailToLoadLeaveTheFacesOnScreen() {
        // The brand's six pictures, already cut (a test build has no asset files for them).
        val brand = List(6) { WelcomePicture.Asset("face-$it.webp") }
        val sprites = brand.map { source ->
            Bitmap.createBitmap(BubbleArt.FACE, BubbleArt.FACE, Bitmap.Config.ARGB_8888).also { WelcomeFaces.keepForTest(source, it) }
        }
        var pictures by mutableStateOf<List<WelcomePicture>>(brand)
        var art: BubbleArt? = null
        compose.setContent {
            CompositionLocalProvider(LocalRemoteImages provides false) {
                val remembered = rememberBubbleArt(pictures, english, persian = false)
                SideEffect { art = remembered }
            }
        }
        compose.waitUntil(10_000) { art?.faces == sprites }
        val scene = art!!
        val shown = scene.faces

        // The server's config arrives naming its own pictures, and none of them
        // load (offline here: remote images are off). The brand's faces stay;
        // they never turn into the generated figures.
        pictures = listOf(WelcomePicture.Remote("https://cdn.example.test/welcome/1.webp"))
        compose.waitForIdle()
        val changed = runCatching { compose.waitUntil(2_000) { scene.faces !== shown } }.isSuccess
        assertFalse("replaced (by the generated figures: ${scene.faces === WelcomeFaces.generatedIfReady()})", changed)
        assertSame(shown, scene.faces)
        assertSame("the same scene", scene, art)
    }

    /** The widest reach of [words]' ink from the middle, at the art's share, as a share of the bubble's radius. */
    private fun reach(art: BubbleArt, words: List<String>, typeface: Typeface, tracking: Float): Float {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.typeface = typeface
            letterSpacing = tracking
            textSize = BubbleArt.LABEL * art.labelShare
        }
        val bounds = Rect()
        return words.maxOf { word ->
            paint.getTextBounds(word, 0, word.length, bounds)
            val w = maxOf(paint.measureText(word), bounds.width().toFloat()) / 2f
            val h = bounds.height() / 2f
            sqrt(w * w + h * h) / (BubbleArt.LABEL / 2f)
        }
    }

    private fun checkReadableAndInside(words: List<String>, typeface: Typeface, tracking: Float, size: Float = BubbleArt.LABEL_SHARE) {
        val art = BubbleArt(words, typeface, tracking, labelSize = size)
        assertTrue("${art.labelShare}", art.labelShare <= size)
        assertTrue("$words reach ${reach(art, words, typeface, tracking)}", reach(art, words, typeface, tracking) <= BubbleArt.LABEL_REACH + 0.005f)
        val dp = 2f
        for (fontScale in listOf(1f, 1.3f, 1.5f, 2f)) {
            val minText = 13f * dp * fontScale
            val field = BubbleField(dp).apply {
                wordMinRadius = art.wordRadiusFor(minText)
                layout(411 * dp, 891 * dp, 260 * dp, 700 * dp, floatArrayOf(24 * dp, 30 * dp, 387 * dp, 245 * dp), startIntro = false)
            }
            val onScreen = art.labelShare * 2f * field.wordRadius
            assertTrue("$words at ${fontScale}x: ${onScreen / dp} dp text", onScreen >= minText - 0.01f)
        }
    }

    @Test
    fun persianWordsAreAtLeast13SpAndInsideTheirBubble() = checkReadableAndInside(persian, persianFace(), 0f, BubbleArt.PERSIAN_LABEL_SHARE)

    @Test
    fun longTurkishWordsGrowTheBubbleRatherThanShrinkBelow13Sp() {
        checkReadableAndInside(turkish, sans(), 0.06f)
        val art = BubbleArt(turkish, sans(), 0.06f)
        assertTrue("a long word takes a smaller share of a larger bubble", art.labelShare < BubbleArt.LABEL_SHARE)
    }

    @Test
    fun englishWordsAreAtLeast13SpAndInsideTheirBubble() = checkReadableAndInside(english, sans(), 0.06f)

    @Test
    fun theWordIsMuchLargerThanBefore() {
        // It was 0.135 of the diameter (about 8 sp in the 31 dp bubble); Persian is now 16 sp there.
        val share = BubbleArt(persian, persianFace(), 0f, labelSize = BubbleArt.PERSIAN_LABEL_SHARE).labelShare
        assertEquals("the short Persian words fit at their full size", BubbleArt.PERSIAN_LABEL_SHARE, share, 0.0001f)
        assertTrue(share * 62f >= 16f)
    }

    @Test
    fun aFrameAllocatesNothing() {
        val art = BubbleArt(persian, persianFace(), 0f, WelcomeFaces.generated())
        val dp = 2f
        val field = BubbleField(dp).apply { layout(411 * dp, 891 * dp, 260 * dp, 700 * dp, floatArrayOf(0f, 0f, 1f, 1f), startIntro = true) }
        val canvas = Canvas(Bitmap.createBitmap(411, 891, Bitmap.Config.ARGB_8888))
        canvas.scale(0.5f, 0.5f)
        repeat(120) { field.step(1f / 60f); art.draw(canvas, field, dp) }
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        val thread = Thread.currentThread().threadId()
        val before = bean.getThreadAllocatedBytes(thread)
        repeat(600) { field.step(1f / 60f); art.draw(canvas, field, dp) }
        val allocated = bean.getThreadAllocatedBytes(thread) - before
        assertTrue("600 frames allocated $allocated bytes", allocated < 64 * 1024)
    }
}
