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
internal val Trimmed = PlatformTextStyle(includeFontPadding = false)
internal val Centred = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.None)

/** Material's type roles of the `neon` template in the screen's script (Persian, or Latin for English and Turkish). */
fun appTypography(persian: Boolean): Typography = templateTypography(Templates.Neon.inScript(persian))

