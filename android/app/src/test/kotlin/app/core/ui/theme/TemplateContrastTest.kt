package app.core.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The templates' own contrast table, recomputed from the live template
 * objects: every text role passes WCAG AA (4.5:1; 3:1 for large text), every
 * icon, control edge, progress fill and focus mark 3:1, in `neon` and
 * `white`, with this build's brand, with the design's own colours and with
 * a brand unlike the design. No shortfall is allowed. Photo cases assume
 * the worst: a pure white photo pixel under the layer.
 */
class TemplateContrastTest {

    private val failures = mutableListOf<String>()

    private fun pair(name: String, foreground: Color, background: Color, min: Double = Contrast.AA) {
        val ratio = Contrast.ratio(foreground.compositeOver(background), background)
        if (ratio < min) failures += "$name: ${"%.2f".format(ratio)}:1 is below ${"%.1f".format(min)}:1"
    }

    private fun assertNoFailures() = assertTrue(failures.joinToString("\n"), failures.isEmpty())

    /** Every colour a paint passes through (its stops; a solid paint's one colour). */
    private fun Brush.colors(): List<Color> = when (this) {
        is androidx.compose.ui.graphics.SolidColor -> listOf(value)
        is CssLinearGradient -> colors
        is IconGradient -> colors
        else -> listOf(representative)
    }

    /** A vertical gradient's colour at [f] (0 at its first stop, 1 at its last). */
    private fun Brush.at(f: Float): Color {
        val g = this as? CssLinearGradient ?: return representative
        val i = g.stops.indexOfLast { it <= f }.coerceIn(0, g.stops.lastIndex - 1)
        val span = (g.stops[i + 1] - g.stops[i]).takeIf { it > 0f } ?: 1f
        return lerp(g.colors[i], g.colors[i + 1], ((f - g.stops[i]) / span).coerceIn(0f, 1f))
    }

    private val white = Color.White

    private fun roles(name: String, t: AppTemplate) {
        val c = t.colors
        val p = t.paints
        // Text on the page and the surfaces.
        for ((surface, fill) in listOf("page" to c.bg, "surface-1" to c.surface1, "surface-2" to c.surface2, "surface-3" to c.surface3, "sheet" to c.surfaceSheet, "dialog" to c.surfaceDialog, "field" to c.surfaceField)) {
            pair("$name text/$surface", c.text, fill)
            pair("$name text-2/$surface", c.text2, fill)
        }
        for ((surface, fill) in listOf("page" to c.bg, "surface-1" to c.surface1, "surface-2" to c.surface2, "empty slot" to c.surfaceEmpty.compositeOver(c.bg))) {
            pair("$name text-3/$surface", c.text3, fill)
        }
        // The accent as text.
        pair("$name accent/page", c.primary, c.bg)
        pair("$name accent/surface-1", c.primary, c.surface1)
        pair("$name accent/surface-2", c.primary, c.surface2)
        pair("$name accent/selected tint over surface-1", c.primary, c.primaryTint.compositeOver(c.surface1))
        pair("$name text/selected tint over surface-1", c.text, c.primaryTint.compositeOver(c.surface1))
        // Fills and what is on them, at every stop of a gradient.
        for (stop in p.primaryFill.colors()) pair("$name on-primary/primary-fill", c.onPrimary, stop)
        for (stop in p.tagFill.colors()) pair("$name on-tag/tag-fill", c.onTag, stop)
        for (stop in p.badgeFill.colors()) pair("$name on-badge/badge-fill", c.onBadge, stop)
        for (stop in p.unreadFill.colors()) pair("$name on-unread/unread-fill", c.onUnread, stop)
        for (stop in p.bubbleOut.colors()) {
            pair("$name on-bubble-out/bubble-out", c.onBubbleOut, stop)
            pair("$name on-bubble-out-2/bubble-out", c.onBubbleOut2, stop)
        }
        pair("$name on-bubble-in/bubble-in", c.onBubbleIn, c.bubbleIn)
        for (stop in p.verified.colors()) pair("$name on-verified/verified (icon)", c.onVerified, stop, Contrast.AA_LARGE)
        for (stop in p.likeFill.colors()) pair("$name on-like/like-fill (icon)", c.onLike, stop, Contrast.AA_LARGE)
        pair("$name on-seg-thumb/seg-thumb", c.onSegThumb, c.segThumb)
        pair("$name on-inverse/inverse (snackbar)", c.onInverse, c.inverse)
        pair("$name inverse-action/inverse", c.inverseAction, c.inverse)
        pair("$name error/page", c.error, c.bg)
        pair("$name error/error tint", c.error, c.errorTint.compositeOver(c.bg))
        pair("$name online word/page", c.onlineText, c.bg)
        // Controls, marks and focus (3:1).
        pair("$name online dot/page", c.online, c.bg, Contrast.AA_LARGE)
        pair("$name caret/field", c.caret, c.surfaceField, Contrast.AA_LARGE)
        for (stop in p.primaryRing.colors()) pair("$name focus and selected ring/page", stop, c.bg, Contrast.AA_LARGE)
        for (stop in p.progressFill.colors()) pair("$name progress/its track", stop, c.progressTrack, Contrast.AA_LARGE)
        for (stop in p.sliderFill.colors()) pair("$name slider fill/its track", stop, c.sliderTrack, Contrast.AA_LARGE)
        for (stop in p.switchOn.colors()) pair("$name switch thumb/switch on", c.switchThumb, stop, Contrast.AA_LARGE)
        pair("$name field edge/page", t.shadows.fieldLine.first().color, c.bg, Contrast.AA_LARGE)
        pair("$name radio ring/page", c.outline, c.bg, Contrast.AA_LARGE)
        pair("$name switch off ring/page", c.switchOffRing, c.bg, Contrast.AA_LARGE)
        // The tab bar.
        pair("$name tab label/bar", c.tabColor, c.tabbarFill.compositeOver(c.bg))
        pair("$name tab label active/bar", c.tabActiveColor, c.tabbarFill.compositeOver(c.bg))
        // Deck actions: on the photo in neon (worst case white under the fill), on the page in white.
        val actUnder = c.actFill.compositeOver(white)
        pair("$name pass and rewind icon/act-fill", c.actIcon, actUnder, Contrast.AA_LARGE)
        pair("$name boost icon/act-fill", c.boostIcon, actUnder, Contrast.AA_LARGE)
        pair("$name super icon/super-fill", c.superIcon, c.superFill.compositeOver(white), Contrast.AA_LARGE)
        pair("$name header button icon/glass solid", c.onGlass, c.glassSolid.compositeOver(white), Contrast.AA_LARGE)
        // Text on photos, a white pixel under the layer.
        pair("$name chip, pill and toast/photo-chip-fill", c.onPhoto, c.photoChipFill.compositeOver(white))
        pair("$name like note/note-fill", c.onPhoto, c.noteFill.compositeOver(white))
        pair("$name video call timer/call scrim", c.onPhoto, p.callScrimTop.at(0.55f).compositeOver(white))
        pair("$name status bar over match photos/match scrim", c.onPhoto, p.matchScrimTop.at(0f).compositeOver(white))
        pair("$name name on the deck photo/bottom scrim (large)", c.onPhoto, p.photoScrimBottom.at(0.6f).compositeOver(white), Contrast.AA_LARGE)
        pair("$name meta on the deck photo/bottom scrim", c.onPhoto2.compositeOver(p.photoScrimBottom.at(0.75f).compositeOver(white)), p.photoScrimBottom.at(0.75f).compositeOver(white))
        // Calls: the same in every template.
        pair("$name call button icon at rest/call-btn-fill", c.onCallBtn, c.callBtnFill.compositeOver(white), Contrast.AA_LARGE)
        pair("$name call button icon toggled", c.onCallBtnOn, c.callBtnOnFill, Contrast.AA_LARGE)
        pair("$name call end icon", c.onCallEnd, c.callEnd, Contrast.AA_LARGE)
        for (stop in p.callAccept.colors()) pair("$name call accept icon", c.onCallAccept, stop, Contrast.AA_LARGE)
        // The system keyboard as drawn.
        pair("$name key label/key", c.kbOn, c.kbKey)
        pair("$name key label/function key", c.kbOn, c.kbFn)
        pair("$name action key icon", c.kbOnAct, c.kbAct, Contrast.AA_LARGE)
        pair("$name suggestion text/keyboard", c.kbSug, c.kbBg)
    }

    private fun material(name: String, s: ColorScheme) {
        pair("$name onPrimary/primary", s.onPrimary, s.primary)
        pair("$name onPrimaryContainer/primaryContainer", s.onPrimaryContainer, s.primaryContainer)
        pair("$name onSecondary/secondary", s.onSecondary, s.secondary)
        pair("$name onSecondaryContainer/secondaryContainer", s.onSecondaryContainer, s.secondaryContainer)
        pair("$name onTertiary/tertiary", s.onTertiary, s.tertiary)
        pair("$name onTertiaryContainer/tertiaryContainer", s.onTertiaryContainer, s.tertiaryContainer)
        pair("$name onError/error", s.onError, s.error)
        pair("$name onErrorContainer/errorContainer", s.onErrorContainer, s.errorContainer)
        pair("$name onBackground/background", s.onBackground, s.background)
        pair("$name onSurface/surface", s.onSurface, s.surface)
        pair("$name onSurfaceVariant/surfaceVariant", s.onSurfaceVariant, s.surfaceVariant)
        pair("$name onSurfaceVariant/surface", s.onSurfaceVariant, s.surface)
        pair("$name inverseOnSurface/inverseSurface", s.inverseOnSurface, s.inverseSurface)
        pair("$name inversePrimary/inverseSurface", s.inversePrimary, s.inverseSurface)
        pair("$name onSurface/surfaceContainerHighest", s.onSurface, s.surfaceContainerHighest)
        pair("$name onSurfaceVariant/surfaceContainerHighest", s.onSurfaceVariant, s.surfaceContainerHighest)
        pair("$name tertiary/surface", s.tertiary, s.surface)
        pair("$name primary/surface", s.primary, s.surface)
        pair("$name error/surface", s.error, s.surface)
        pair("$name outline/surface", s.outline, s.surface, Contrast.AA_LARGE)
    }

    @Test
    fun `neon passes for this build's brand`() {
        val t = Templates.of(Templates.NEON, BrandColors.Build)
        roles("neon", t)
        material("neon", templateColorScheme(t))
        assertNoFailures()
    }

    @Test
    fun `neon passes with the design's own gradient`() {
        roles("neon (design)", Templates.Neon)
        material("neon (design)", templateColorScheme(Templates.Neon))
        assertNoFailures()
    }

    @Test
    fun `white passes`() {
        roles("white", Templates.White)
        material("white", templateColorScheme(Templates.White))
        // White's Material fixed roles.
        val s = templateColorScheme(Templates.White)
        pair("white onPrimaryFixed/primaryFixed", s.onPrimaryFixed, s.primaryFixed)
        pair("white onPrimaryFixedVariant/primaryFixedDim", s.onPrimaryFixedVariant, s.primaryFixedDim)
        pair("white onSecondaryFixed/secondaryFixed", s.onSecondaryFixed, s.secondaryFixed)
        pair("white onSecondaryFixedVariant/secondaryFixedDim", s.onSecondaryFixedVariant, s.secondaryFixedDim)
        pair("white onTertiaryFixed/tertiaryFixed", s.onTertiaryFixed, s.tertiaryFixed)
        pair("white onTertiaryFixedVariant/tertiaryFixedDim", s.onTertiaryFixedVariant, s.tertiaryFixedDim)
        assertNoFailures()
    }

    /** Brands unlike the design: light and dark accents, warm and cold gradients. */
    private val brands = listOf(
        BrandColors.Design.copy(
            brandLight = Color(0xFF0B7A4B),
            brandDark = Color(0xFF5FD39A),
            gradientLight = GradientStops(Color(0xFF0B7A4B), Color(0xFF0A7A50), Color(0xFF08875A)),
            gradientDark = GradientStops(Color(0xFF0B7A4B), Color(0xFF0A7A50), Color(0xFF08875A)),
        ),
        // A pale light accent, a dark dark accent and a pale light gradient, which the templates must move to read.
        BrandColors.Design.copy(
            brandLight = Color(0xFFFFC233),
            brandDark = Color(0xFF3A2A00),
            gradientLight = GradientStops(Color(0xFFFFD166), Color(0xFFFFB703), Color(0xFFFB8500)),
            gradientDark = GradientStops(Color(0xFF2563EB), Color(0xFF7C3AED), Color(0xFFC2410C)),
        ),
    )

    @Test
    fun `both templates pass for brands unlike the design`() {
        for ((i, brand) in brands.withIndex()) {
            val neon = Templates.of(Templates.NEON, brand)
            val white = Templates.of(Templates.WHITE, brand)
            roles("brand $i neon", neon)
            material("brand $i neon", templateColorScheme(neon))
            roles("brand $i white", white)
            material("brand $i white", templateColorScheme(white))
            val s = templateColorScheme(white)
            pair("brand $i white onTertiaryFixed/tertiaryFixed", s.onTertiaryFixed, s.tertiaryFixed)
            pair("brand $i white onTertiaryFixedVariant/tertiaryFixedDim", s.onTertiaryFixedVariant, s.tertiaryFixedDim)
        }
        assertNoFailures()
    }

    @Test
    fun `neon's progress and slider fills and its field edge read 3 to 1`() {
        val t = Templates.Neon
        for (stop in t.paints.progressFill.colors()) assertTrue(Contrast.ratio(stop, t.colors.progressTrack) >= Contrast.AA_LARGE)
        for (stop in t.paints.sliderFill.colors()) assertTrue(Contrast.ratio(stop, t.colors.sliderTrack) >= Contrast.AA_LARGE)
        assertEquals(3.52, Contrast.ratio(t.shadows.fieldLine.first().color, t.colors.bg), 0.01)
        // The violet stop is lifted just enough; the other two are the design's.
        assertEquals(Color(0xFFC21FD0), t.paints.progressFill.stop(1))
        assertEquals(Color(0xFFE0157A), t.paints.sliderFill.stop(2))
    }

    @Test
    fun `the published neon ratios hold`() {
        val c = Templates.Neon.colors
        // The neon values of this round, as published with the design (same method).
        assertEquals(7.05, Contrast.ratio(c.primary, c.bg), 0.01)
        assertEquals(6.67, Contrast.ratio(c.primary, c.surface1), 0.01)
        assertEquals(6.35, Contrast.ratio(c.error, c.bg), 0.01)
        assertEquals(9.85, Contrast.ratio(c.online, c.bg), 0.01)
        assertEquals(4.61, Contrast.ratio(Color.White, Color(0xFFE0157A)), 0.01)
        assertEquals(4.77, Contrast.ratio(Color.White, Color(0xFFC21FD0)), 0.01)
        assertEquals(5.78, Contrast.ratio(Color.White, Color(0xFF7B2BFF)), 0.01)
        // The fills are stored in 8 bits: .62 is 158/255, a hair under the published figure.
        assertEquals(5.39, Contrast.ratio(Color.White, c.noteFill.compositeOver(Color.White)), 0.05)
        assertEquals(5.74, Contrast.ratio(Color.White, Templates.Neon.paints.matchScrimTop.at(0f).compositeOver(Color.White)), 0.02)
        assertEquals(9.12, Contrast.ratio(c.kbOnAct, c.kbAct), 0.01)
    }

    @Test
    fun `white's Material scheme is the template's mapping`() {
        val s = templateColorScheme(Templates.White)
        val expected = mapOf(
            "primary" to 0xFF111114, "onPrimary" to 0xFFFFFFFF, "primaryContainer" to 0xFFE7E7EB, "onPrimaryContainer" to 0xFF111114,
            "inversePrimary" to 0xFFB6A3FF, "secondary" to 0xFF55555D, "onSecondary" to 0xFFFFFFFF, "secondaryContainer" to 0xFFF3F3F5,
            "onSecondaryContainer" to 0xFF111114, "tertiary" to 0xFF5B2FD9, "onTertiary" to 0xFFFFFFFF, "tertiaryContainer" to 0xFFF0ECFC,
            "onTertiaryContainer" to 0xFF2E128A, "error" to 0xFFC8243C, "onError" to 0xFFFFFFFF, "errorContainer" to 0xFFFDECEE,
            "onErrorContainer" to 0xFF7A1022, "background" to 0xFFFFFFFF, "onBackground" to 0xFF111114, "surface" to 0xFFFFFFFF,
            "onSurface" to 0xFF111114, "surfaceVariant" to 0xFFF3F3F5, "onSurfaceVariant" to 0xFF55555D, "surfaceTint" to 0xFFFFFFFF,
            "inverseSurface" to 0xFF1C1C20, "inverseOnSurface" to 0xFFFFFFFF, "outline" to 0xFF8E8E96, "outlineVariant" to 0xFFE6E6EA,
            "scrim" to 0xFF111114, "surfaceDim" to 0xFFEDEDF0, "surfaceBright" to 0xFFFFFFFF, "surfaceContainerLowest" to 0xFFFFFFFF,
            "surfaceContainerLow" to 0xFFFAFAFB, "surfaceContainer" to 0xFFF3F3F5, "surfaceContainerHigh" to 0xFFEDEDF0,
            "surfaceContainerHighest" to 0xFFE7E7EB,
        )
        val actual = mapOf(
            "primary" to s.primary, "onPrimary" to s.onPrimary, "primaryContainer" to s.primaryContainer, "onPrimaryContainer" to s.onPrimaryContainer,
            "inversePrimary" to s.inversePrimary, "secondary" to s.secondary, "onSecondary" to s.onSecondary, "secondaryContainer" to s.secondaryContainer,
            "onSecondaryContainer" to s.onSecondaryContainer, "tertiary" to s.tertiary, "onTertiary" to s.onTertiary, "tertiaryContainer" to s.tertiaryContainer,
            "onTertiaryContainer" to s.onTertiaryContainer, "error" to s.error, "onError" to s.onError, "errorContainer" to s.errorContainer,
            "onErrorContainer" to s.onErrorContainer, "background" to s.background, "onBackground" to s.onBackground, "surface" to s.surface,
            "onSurface" to s.onSurface, "surfaceVariant" to s.surfaceVariant, "onSurfaceVariant" to s.onSurfaceVariant, "surfaceTint" to s.surfaceTint,
            "inverseSurface" to s.inverseSurface, "inverseOnSurface" to s.inverseOnSurface, "outline" to s.outline, "outlineVariant" to s.outlineVariant,
            "scrim" to s.scrim, "surfaceDim" to s.surfaceDim, "surfaceBright" to s.surfaceBright, "surfaceContainerLowest" to s.surfaceContainerLowest,
            "surfaceContainerLow" to s.surfaceContainerLow, "surfaceContainer" to s.surfaceContainer, "surfaceContainerHigh" to s.surfaceContainerHigh,
            "surfaceContainerHighest" to s.surfaceContainerHighest,
        )
        assertEquals(expected.mapValues { Color(it.value) }, actual)
    }

    @Test
    fun `neon's Material scheme keeps the dark structure on the template's colours`() {
        val s = templateColorScheme(Templates.Neon)
        val c = Templates.Neon.colors
        assertEquals(c.primary, s.primary)
        assertEquals(Color(0xFF7B2BFF), s.primaryContainer)
        assertEquals(c.bg, s.background)
        assertEquals(c.text, s.onSurface)
        assertEquals(c.text2, s.onSurfaceVariant)
        assertEquals(c.error, s.error)
        assertEquals(c.outline, s.outline)
        assertEquals(c.surface2, s.surfaceContainerHigh)
        assertTrue(Contrast.ratio(s.onPrimary, s.primary) >= Contrast.AA)
    }
}
