package app.core.feature.auth.welcome

import android.graphics.Bitmap
import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
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

/**
 * The welcome's pictures: decoded off the main thread; the config's first,
 * the brand's own when none of those load, and what is on screen kept when a
 * later set loads nothing; nothing at all (never a drawn stand-in) without
 * pictures; the framed photo never a small crop blown up.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WelcomeFacesTest {

    @get:Rule val compose = createComposeRule()

    @Before fun firstLaunch() = WelcomeFaces.forgetForTest()

    @After fun clean() = WelcomeFaces.forgetForTest()

    private val size = 64

    /** The brand's pictures, already decoded (a test build has no asset files for them). */
    private fun brandFaces(count: Int, side: Int = size): Map<WelcomePicture.Asset, Bitmap> =
        (0 until count).associate { i ->
            val source = WelcomePicture.Asset("face-$i.webp")
            source to Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888).also { WelcomeFaces.keepForTest(source, it) }
        }

    private val failing = listOf(WelcomePicture.Remote("https://cdn.example.test/welcome/1.webp"))

    @Test
    fun withoutPicturesTheOrbitIsEmptyFromItsFirstFrame() {
        var first: WelcomeArt? = null
        compose.setContent {
            val art = rememberOrbitFaces(WelcomeSources(), size)
            SideEffect { if (first == null) first = art }
        }
        compose.waitForIdle()
        assertEquals(WelcomeArt.None, first)
    }

    @Test
    fun picturesAreDecodedOffTheMainThread() {
        // An asset the build does not have: read (and failed) off the main thread, then nothing to draw.
        var art: WelcomeArt? = null
        compose.setContent {
            val shown = rememberOrbitFaces(WelcomeSources(brand = listOf(WelcomePicture.Asset("missing.webp"))), size)
            SideEffect { art = shown }
        }
        compose.waitUntil(10_000) { art == WelcomeArt.None }
        val reader = WelcomeFaces.loadedOn
        assertNotNull(reader)
        assertNotSame("read off the main thread", Looper.getMainLooper().thread, reader)
    }

    @Test
    fun configPicturesThatFailToLoadFallBackToTheBrandsOwn() {
        val brand = brandFaces(7)
        var art: WelcomeArt? = null
        compose.setContent {
            // Offline here: remote images are off, so none of the config's loads.
            CompositionLocalProvider(LocalRemoteImages provides false) {
                val shown = rememberOrbitFaces(WelcomeSources(remote = failing, brand = brand.keys.toList()), size)
                SideEffect { art = shown }
            }
        }
        compose.waitUntil(10_000) { art is WelcomeArt.Faces }
        val faces = (art as WelcomeArt.Faces).faces.map { it.asAndroidBitmap() }
        assertEquals(brand.values.toList(), faces)
    }

    @Test
    fun picturesThatArriveLaterAndFailToLoadLeaveTheFacesOnScreen() {
        val brand = brandFaces(7)
        var sources by mutableStateOf(WelcomeSources(brand = brand.keys.toList()))
        var art: WelcomeArt? = null
        compose.setContent {
            CompositionLocalProvider(LocalRemoteImages provides false) {
                val shown = rememberOrbitFaces(sources, size)
                SideEffect { art = shown }
            }
        }
        compose.waitUntil(10_000) { art is WelcomeArt.Faces }
        val shown = art

        // The config arrives naming its own pictures, none of them loads, and
        // (a brand whose files went missing) nothing behind them either: the
        // faces on screen stay; they never turn into the empty orbit.
        val settled = WelcomeFaces.settledCount
        sources = WelcomeSources(remote = failing)
        compose.waitForIdle()
        compose.waitUntil(10_000) { WelcomeFaces.settledCount > settled }
        compose.waitForIdle()
        assertSame(shown, art)
    }

    @Test
    fun theFramedPhotoIsTheFirstPictureLargeEnoughForItsFrame() {
        val small = WelcomePicture.Asset("face.webp")
        val large = WelcomePicture.Asset("portrait.webp")
        WelcomeFaces.keepForTest(small, Bitmap.createBitmap(80, 80, Bitmap.Config.ARGB_8888))
        val portrait = Bitmap.createBitmap(300, 420, Bitmap.Config.ARGB_8888).also { WelcomeFaces.keepForTest(large, it) }
        var art: WelcomeArt? = null
        compose.setContent {
            val shown = rememberWelcomePhoto(WelcomeSources(brand = listOf(small, large)), 280, 400)
            SideEffect { art = shown }
        }
        compose.waitUntil(10_000) { art is WelcomeArt.Photo }
        assertSame(portrait, (art as WelcomeArt.Photo).bitmap.asAndroidBitmap())
    }

    @Test
    fun withoutAPictureLargeEnoughTheFrameShowsNoPhoto() {
        val small = WelcomePicture.Asset("face.webp")
        WelcomeFaces.keepForTest(small, Bitmap.createBitmap(80, 80, Bitmap.Config.ARGB_8888))
        var art: WelcomeArt? = null
        compose.setContent {
            val shown = rememberWelcomePhoto(WelcomeSources(brand = listOf(small)), 280, 400)
            SideEffect { art = shown }
        }
        compose.waitUntil(10_000) { art == WelcomeArt.None }
        assertTrue(WelcomeFaces.upscale(Bitmap.createBitmap(80, 80, Bitmap.Config.ARGB_8888), 280, 400) > WelcomeFaces.MAX_UPSCALE)
    }

    @Test
    fun releaseLetsTheDecodedPicturesGo() {
        val brand = brandFaces(1)
        val source = brand.keys.single()
        assertNotNull(WelcomeFaces.cached(source, size, size))
        WelcomeFaces.release()
        assertFalse(WelcomeFaces.cached(source, size, size) != null)
    }
}
