package app.core.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import app.core.R

/**
 * The brand's Persian face: `brand_fa_*`, copied at build time from the
 * brand's own files (brand.json `fonts.persianFiles`) or, without them, from
 * the bundled Vazirmatn (SIL OFL 1.1). Three weights only, 400, 500 and 700:
 * a SemiBold request is drawn Bold, never synthesised.
 *
 * Bundled rather than downloaded: downloadable fonts come through Google Play
 * services, which many phones that install from Cafe Bazaar do not have.
 */
val PersianFamily = FontFamily(
    Font(R.font.brand_fa_regular, FontWeight.Normal),
    Font(R.font.brand_fa_medium, FontWeight.Medium),
    Font(R.font.brand_fa_bold, FontWeight.SemiBold),
    Font(R.font.brand_fa_bold, FontWeight.Bold),
)

/**
 * The Latin face for English and Turkish: `brand_latin_*`, the brand's files
 * (`fonts.latinFiles`) or the bundled Be Vietnam Pro (SIL OFL 1.1), in four
 * weights; the Persian 700 roles are 600 here.
 */
val LatinFamily = FontFamily(
    Font(R.font.brand_latin_regular, FontWeight.Normal),
    Font(R.font.brand_latin_medium, FontWeight.Medium),
    Font(R.font.brand_latin_semibold, FontWeight.SemiBold),
    Font(R.font.brand_latin_bold, FontWeight.Bold),
)

/**
 * Trim the font's own padding and centre the line: Persian faces carry
 * generous metrics (room for diacritics), and without this a single line
 * sits visibly low in its box.
 */
private val Trimmed = PlatformTextStyle(includeFontPadding = false)
private val Centred = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.None)

private fun style(family: FontFamily, size: TextUnit, lineHeight: TextUnit, weight: FontWeight) =
    TextStyle(
        fontFamily = family,
        fontWeight = weight,
        fontSize = size,
        // In sp: the line grows with the reader's font scale, like the text.
        lineHeight = lineHeight,
        // Never letter-space Persian (it breaks the joined script); Latin keeps the face's own.
        letterSpacing = 0.sp,
        platformStyle = Trimmed,
        lineHeightStyle = Centred,
    )

/** One role: its Persian size, line and weight, and its Latin ones. */
private class Role(val fa: Triple<Int, Int, FontWeight>, val latin: Triple<Int, Int, FontWeight>) {
    fun style(persian: Boolean): TextStyle {
        val (size, line, weight) = if (persian) fa else latin
        return style(if (persian) PersianFamily else LatinFamily, size.sp, line.sp, weight)
    }
}

private val W400 = FontWeight.Normal
private val W500 = FontWeight.Medium
private val W600 = FontWeight.SemiBold
private val W700 = FontWeight.Bold

// tokens.json `typography.scale`: Persian first, then Latin.
private val DisplayLarge = Role(Triple(60, 80, W700), Triple(52, 60, W700))
private val DisplayMedium = Role(Triple(44, 62, W700), Triple(40, 48, W700))
private val DisplaySmall = Role(Triple(36, 50, W700), Triple(34, 42, W700))
private val HeadlineLarge = Role(Triple(32, 48, W700), Triple(30, 38, W600))
private val HeadlineMedium = Role(Triple(28, 42, W700), Triple(26, 34, W600))
private val HeadlineSmall = Role(Triple(24, 36, W700), Triple(22, 30, W600))
private val TitleLarge = Role(Triple(21, 34, W700), Triple(20, 28, W600))
private val TitleMedium = Role(Triple(18, 28, W700), Triple(17, 24, W600))
private val TitleSmall = Role(Triple(16, 26, W500), Triple(15, 22, W500))
private val BodyLarge = Role(Triple(17, 30, W400), Triple(16, 24, W400))
private val BodyMedium = Role(Triple(15, 26, W400), Triple(15, 22, W400))
private val BodySmall = Role(Triple(13, 22, W400), Triple(13, 18, W400))
private val LabelLarge = Role(Triple(16, 24, W700), Triple(15, 20, W600))
private val LabelMedium = Role(Triple(14, 22, W500), Triple(14, 20, W500))
private val LabelSmall = Role(Triple(12, 18, W500), Triple(12, 16, W500))
private val Kicker = Role(Triple(13, 20, W700), Triple(13, 18, W600))
private val Numeral = Role(Triple(26, 36, W700), Triple(26, 32, W600))
private val Price = Role(Triple(16, 22, W700), Triple(16, 22, W600))
private val PriceUnit = Role(Triple(12, 16, W500), Triple(12, 16, W500))
private val TabLabel = Role(Triple(12, 18, W500), Triple(12, 16, W500))

/** Material's type roles in the screen's script: the Persian sizes, or the Latin ones. */
fun appTypography(persian: Boolean): Typography =
    Typography(
        displayLarge = DisplayLarge.style(persian),
        displayMedium = DisplayMedium.style(persian),
        displaySmall = DisplaySmall.style(persian),
        headlineLarge = HeadlineLarge.style(persian),
        headlineMedium = HeadlineMedium.style(persian),
        headlineSmall = HeadlineSmall.style(persian),
        titleLarge = TitleLarge.style(persian),
        titleMedium = TitleMedium.style(persian),
        titleSmall = TitleSmall.style(persian),
        bodyLarge = BodyLarge.style(persian),
        bodyMedium = BodyMedium.style(persian),
        bodySmall = BodySmall.style(persian),
        labelLarge = LabelLarge.style(persian),
        labelMedium = LabelMedium.style(persian),
        labelSmall = LabelSmall.style(persian),
    )

/** The styles Material has no role for, read as `AppTheme.type.kicker`. */
@Immutable
data class AppType(
    /** «۰۱ ── درباره‌ی من»: section numbers and labels. */
    val kicker: TextStyle,
    /** OTP digits. */
    val numeral: TextStyle,
    /** A price: «۱٬۲۰۰٬۰۰۰». */
    val price: TextStyle,
    /** The currency word under a price: «تومان». */
    val priceUnit: TextStyle,
    /** Tab bar labels (12 sp at least; bold when selected). */
    val tabLabel: TextStyle,
) {
    companion object {
        fun of(persian: Boolean) = AppType(
            kicker = Kicker.style(persian),
            numeral = Numeral.style(persian),
            price = Price.style(persian),
            priceUnit = PriceUnit.style(persian),
            tabLabel = TabLabel.style(persian),
        )
    }
}

val LocalAppType = staticCompositionLocalOf { AppType.of(persian = false) }

/** The weight a Persian 700 role has in Latin: 600 (titles, buttons). Display sizes stay 700. */
fun boldFor(persian: Boolean): FontWeight = if (persian) FontWeight.Bold else FontWeight.SemiBold
