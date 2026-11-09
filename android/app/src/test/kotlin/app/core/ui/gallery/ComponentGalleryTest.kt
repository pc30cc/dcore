package app.core.ui.gallery

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.i18n.AppLanguage
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Locale

/**
 * The component library on [ComponentGallery]'s pages, in the dark theme
 * (the default look) and the light one, in Persian and English, for this
 * build's brand (its colours and fonts). Every page checks that whatever
 * can be tapped is at least 48 × 48 dp and says what it is.
 *
 * With `SCREENS_DIR` set, each page is written there as a PNG
 * (`<store>-<language>-<theme>-g<nn>.png`); without it nothing is. The
 * images are for looking at, never committed.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h1900dp-xhdpi")
class ComponentGalleryTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val outDir: File? = System.getenv("SCREENS_DIR")?.takeIf { it.isNotBlank() }?.let(::File)

    @Test @Config(qualifiers = "+fa") fun persianDark() = gallery(AppLanguage.FA, dark = true)
    @Test @Config(qualifiers = "+fa") fun persianLight() = gallery(AppLanguage.FA, dark = false)
    @Test @Config(qualifiers = "+en") fun englishDark() = gallery(AppLanguage.EN, dark = true)
    @Test @Config(qualifiers = "+en") fun englishLight() = gallery(AppLanguage.EN, dark = false)

    private fun gallery(language: AppLanguage, dark: Boolean) {
        var page by mutableIntStateOf(1)
        compose.setContent {
            AppTheme(dark = dark) { ComponentGallery.Page(page, language) }
        }
        val problems = mutableListOf<String>()
        for (p in 1..ComponentGallery.PAGES) {
            page = p
            compose.waitForIdle()
            checkTouchTargets(p, problems)
            capture(language, dark, p)
        }
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }

    /** Every tappable thing: 48 dp at least each way, and a text or a content description. */
    private fun checkTouchTargets(page: Int, problems: MutableList<String>) {
        val density = compose.activity.resources.displayMetrics.density
        val min = 48f * density - 1f
        for (node in compose.onAllNodes(hasClickAction()).fetchSemanticsNodes()) {
            val config = node.config
            val label = config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString()
                ?: config.getOrNull(SemanticsProperties.Text)?.joinToString()
            if (node.size.width < min || node.size.height < min) {
                problems += "page $page: \"$label\" is ${node.size.width / density} × ${node.size.height / density} dp"
            }
            if (label.isNullOrBlank()) problems += "page $page: a tappable node at ${node.boundsInRoot} says nothing"
        }
    }

    private fun capture(language: AppLanguage, dark: Boolean, page: Int) {
        val dir = outDir ?: return
        dir.mkdirs()
        val bitmap = compose.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap()
        val theme = if (dark) "dark" else "light"
        val file = File(dir, String.format(Locale.ROOT, "%s-%s-%s-g%02d.png", BuildConfig.STORE, language.tag, theme, page))
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
