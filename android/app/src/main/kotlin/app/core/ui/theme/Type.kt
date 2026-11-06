package app.core.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import app.core.R

/**
 * Vazirmatn 33.0.3 (npm package `vazirmatn`, SIL OFL 1.1; the licence ships in
 * `res/raw/license_vazirmatn.txt` and is shown under Profile, Open-source
 * licences), in four static weights.
 *
 * Bundled rather than downloaded: downloadable fonts come through Google Play
 * services, which many phones that install from Cafe Bazaar do not have.
 * Static weights rather than the variable font, because the weight axis needs
 * API 26 and this app runs from 24.
 *
 * Latin text in English and Turkish uses the system font for now. brand.json's
 * `fonts.latin` (Inter in the template) is not bundled yet: that needs the
 * brand's font files under `brands/<id>/` and a build step to copy them.
 */
val Vazirmatn = FontFamily(
    Font(R.font.vazirmatn_regular, FontWeight.Normal),
    Font(R.font.vazirmatn_medium, FontWeight.Medium),
    Font(R.font.vazirmatn_semibold, FontWeight.SemiBold),
    Font(R.font.vazirmatn_bold, FontWeight.Bold),
)

/**
 * Trim the font's own padding and centre the line: Vazirmatn's metrics are
 * generous (room for Persian diacritics), and without this a single line of
 * text sits visibly low in its box.
 */
private val Trimmed = PlatformTextStyle(includeFontPadding = false)
private val Centred = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.None)

private fun style(family: FontFamily, size: TextUnit, weight: FontWeight, lineHeight: Float, tracking: Float = 0f) =
    TextStyle(
        fontFamily = family,
        fontWeight = weight,
        fontSize = size,
        // Relative line heights follow the reader's font scale with the text.
        // Persian wants roughly 1.5x: a line with a diacritic above and a
        // descender below is taller than Latin ever gets.
        lineHeight = lineHeight.em,
        letterSpacing = tracking.em,
        platformStyle = Trimmed,
        lineHeightStyle = Centred,
    )

/**
 * Material's type roles on the eight sizes of [TypeScale], in [family].
 * Persian gets Vazirmatn and no letter spacing (it breaks joined script).
 */
fun appTypography(persian: Boolean): Typography {
    val family = if (persian) Vazirmatn else FontFamily.Default
    val tight = if (persian) 0f else -0.01f
    val open = if (persian) 0f else 0.01f
    val lh = if (persian) 1.6f else 1.4f
    return Typography(
        displayLarge = style(family, TypeScale.hero, FontWeight.Bold, 1.2f, tight),
        displayMedium = style(family, TypeScale.display, FontWeight.Bold, 1.25f, tight),
        displaySmall = style(family, TypeScale.xxl, FontWeight.Bold, 1.3f),
        headlineLarge = style(family, TypeScale.display, FontWeight.Bold, 1.25f, tight),
        headlineMedium = style(family, TypeScale.xxl, FontWeight.Bold, 1.3f),
        headlineSmall = style(family, TypeScale.xl, FontWeight.SemiBold, 1.35f),
        titleLarge = style(family, TypeScale.xl, FontWeight.SemiBold, 1.35f),
        titleMedium = style(family, TypeScale.lg, FontWeight.SemiBold, lh),
        titleSmall = style(family, TypeScale.md, FontWeight.SemiBold, lh),
        bodyLarge = style(family, TypeScale.lg, FontWeight.Normal, lh, open),
        bodyMedium = style(family, TypeScale.md, FontWeight.Normal, lh, open),
        bodySmall = style(family, TypeScale.sm, FontWeight.Normal, lh, open),
        labelLarge = style(family, TypeScale.md, FontWeight.SemiBold, 1.4f, open),
        labelMedium = style(family, TypeScale.sm, FontWeight.Medium, 1.35f, open),
        labelSmall = style(family, TypeScale.xs, FontWeight.Medium, 1.35f, open),
    )
}
