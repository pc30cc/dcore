package app.core.feature.auth.welcome

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import app.core.R

/**
 * The welcome's emphasis faces.
 *
 * Latin: Instrument Serif Italic (npm `@expo-google-fonts/instrument-serif`
 * 0.4.1, SIL OFL 1.1; the licence is `res/raw/license_instrument_serif.txt`,
 * shown with the others under Profile, Open-source licences).
 *
 * Persian has no italics: the emphasis is Lalezar (npm
 * `@expo-google-fonts/lalezar` 0.4.1, SIL OFL 1.1, `res/raw/license_lalezar.txt`),
 * a Persian display face, filled with a warm light gradient. Next to
 * Vazirmatn it is a different design, as the serif is next to the sans, and
 * it needs no slant. (Vazirmatn Black with the same fill was tried and read
 * as the same headline, only bolder.)
 */
object WelcomeType {

    val Serif = FontFamily(Font(R.font.instrument_serif_italic, FontWeight.Normal, FontStyle.Italic))

    val PersianDisplay = FontFamily(Font(R.font.lalezar_regular, FontWeight.Normal))

    /** Where the Persian emphasis fill ends: its least bright colour, which the scrim is measured against. */
    val WarmEnd = Color(0xFFFFD2B0)

    /** The Persian emphasis fill: white into a warm peach. */
    private val warmFill = Brush.linearGradient(listOf(Color(0xFFFFFFFF), Color(0xFFFFE7C7), WarmEnd))

    fun emphasis(persian: Boolean, size: TextUnit): SpanStyle =
        if (persian) {
            SpanStyle(fontFamily = PersianDisplay, fontWeight = FontWeight.Normal, brush = warmFill, fontSize = size)
        } else {
            SpanStyle(fontFamily = Serif, fontStyle = FontStyle.Italic, fontWeight = FontWeight.Normal, fontSize = size, letterSpacing = 0.em)
        }

    /** [source] (with its asterisks) as styled text: plain runs as they are, emphasised runs in [emphasis]. */
    fun headline(source: String, emphasis: SpanStyle): AnnotatedString = buildAnnotatedString {
        Headline.parse(source).forEach { run ->
            if (run.emphasis) withStyle(emphasis) { append(run.text) } else append(run.text)
        }
    }
}
