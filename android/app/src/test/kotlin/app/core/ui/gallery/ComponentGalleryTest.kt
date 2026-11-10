package app.core.ui.gallery

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.Modifier
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
import app.core.ui.theme.AppTemplate
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Locale

/**
 * The component library on [ComponentGallery]'s sheet, in each template
 * (`neon`, `white`), in Persian and English, for this build's brand (its
 * colours and fonts). Whatever can be tapped must be at least 48 × 48 dp
 * and say what it is.
 *
 * With `SCREENS_DIR` set, each sheet is written there as a PNG
 * (`<store>-<language>-<template>-sheet.png`); without it nothing is. The
 * images are for looking at, never committed.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w1240dp-h2800dp-xhdpi")
class ComponentGalleryTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val outDir: File? = System.getenv("SCREENS_DIR")?.takeIf { it.isNotBlank() }?.let(::File)

    @Test @Config(qualifiers = "+fa") fun persianNeon() = gallery(AppLanguage.FA, Templates.Neon)
    @Test @Config(qualifiers = "+fa") fun persianWhite() = gallery(AppLanguage.FA, Templates.White)
    @Test @Config(qualifiers = "+en") fun englishNeon() = gallery(AppLanguage.EN, Templates.of(Templates.NEON))
    @Test @Config(qualifiers = "+en") fun englishWhite() = gallery(AppLanguage.EN, Templates.White)

    private fun gallery(language: AppLanguage, template: AppTemplate) {
        compose.setContent {
            AppTheme(template = template) {
                Box(Modifier.horizontalScroll(rememberScrollState())) { ComponentGallery.Sheet(language) }
            }
        }
        compose.waitForIdle()
        val problems = mutableListOf<String>()
        checkTouchTargets(problems)
        capture(language, template.id)
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }

    /** Every tappable thing: 48 dp at least each way, and a text or a content description. */
    private fun checkTouchTargets(problems: MutableList<String>) {
        val density = compose.activity.resources.displayMetrics.density
        val min = 48f * density - 1f
        for (node in compose.onAllNodes(hasClickAction()).fetchSemanticsNodes()) {
            val config = node.config
            val label = config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString()
                ?: config.getOrNull(SemanticsProperties.Text)?.joinToString()
                ?: config.getOrNull(SemanticsProperties.EditableText)?.text
            if (node.size.width < min || node.size.height < min) {
                problems += "\"$label\" is ${node.size.width / density} × ${node.size.height / density} dp"
            }
            if (label.isNullOrBlank()) problems += "a tappable node at ${node.boundsInRoot} says nothing"
        }
    }

    private fun capture(language: AppLanguage, template: String) {
        val dir = outDir ?: return
        dir.mkdirs()
        val bitmap = compose.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap()
        val file = File(dir, String.format(Locale.ROOT, "%s-%s-%s-sheet.png", BuildConfig.STORE, language.tag, template))
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
