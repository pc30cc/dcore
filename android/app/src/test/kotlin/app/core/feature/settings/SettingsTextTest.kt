package app.core.feature.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.ResolvedTextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.i18n.AppLanguage
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Settings' texts: the version in the reader's digits, the licences left to right in a Persian screen. */
@RunWith(AndroidJUnit4::class)
class SettingsTextTest {

    @get:Rule val compose = createComposeRule()

    @Test
    fun `the version is written in Persian digits with the Persian separator`() {
        assertEquals("۱٫۰٫۰", versionLabel("1.0.0", AppLanguage.FA))
        assertEquals("۰٫۱۲٫۳", versionLabel("0.12.3", AppLanguage.FA))
        // No Latin digit is left in a Persian version.
        assertTrue(versionLabel("2.10.4", AppLanguage.FA).none { it in '0'..'9' })
        assertEquals("1.0.0", versionLabel("1.0.0", AppLanguage.EN))
        assertEquals("1.0.0", versionLabel("1.0.0", AppLanguage.TR))
    }

    @Test
    @Config(qualifiers = "+fa")
    fun `a licence is laid out left to right from the left edge in a Persian screen`() {
        val licence = "Copyright 2021 The Authors. This Font Software is licensed under the SIL Open Font License."
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    Box(Modifier.width(360.dp)) { LicenceText(licence) }
                }
            }
        }
        compose.waitForIdle()
        val layout = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(licence).fetchSemanticsNode().config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layout)
        val result = layout.single()
        assertEquals(ResolvedTextDirection.Ltr, result.getParagraphDirection(0))
        // The first line starts at the left edge, as English text does.
        assertEquals(0f, result.getLineLeft(0), 1f)
    }

    @Test
    fun `a licence file reads as paragraphs, its headings kept and its dashed lines as rules`() {
        val raw = """
            Copyright 2021 The Authors (https://example.com/fonts),

            This Font Software is licensed under the SIL Open Font License, Version 1.1.
            This license is copied below, and is also available with a FAQ at:
            https://openfontlicense.org


            -----------------------------------------------------------
            SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
            -----------------------------------------------------------

            PREAMBLE
            The goals of the Open Font License (OFL) are to stimulate worldwide
            development of collaborative font projects.
        """.trimIndent()
        val blocks = licenceBlocks(raw)
        assertEquals(
            listOf(
                LicenceBlock.Paragraph("Copyright 2021 The Authors (https://example.com/fonts),"),
                LicenceBlock.Paragraph(
                    "This Font Software is licensed under the SIL Open Font License, Version 1.1. " +
                        "This license is copied below, and is also available with a FAQ at: https://openfontlicense.org",
                ),
                LicenceBlock.Rule,
                LicenceBlock.Paragraph("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007"),
                LicenceBlock.Rule,
                // The heading keeps its line; the wrapped sentence under it is one again.
                LicenceBlock.Paragraph("PREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects."),
            ),
            blocks,
        )
    }
}
