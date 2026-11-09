package app.core.feature.call

import android.content.res.Resources
import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import android.icu.util.ULocale
import androidx.annotation.PluralsRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalResources
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import java.util.Locale

/** One part of a length: so many hours, minutes or seconds. */
data class LengthPart(val unit: LengthUnit, val amount: Long)

enum class LengthUnit(@PluralsRes val plural: Int) {
    HOUR(R.plurals.call_length_hours),
    MINUTE(R.plurals.call_length_minutes),
    SECOND(R.plurals.call_length_seconds),
}

/**
 * What a length is said in: seconds under a minute; minutes and seconds
 * under an hour; hours and minutes from an hour on. A zero part is left out
 * ("2 min", not "2 min, 0 sec"); nothing for no length.
 */
fun lengthParts(seconds: Long): List<LengthPart> {
    if (seconds <= 0) return emptyList()
    if (seconds < 60) return listOf(LengthPart(LengthUnit.SECOND, seconds))
    if (seconds < 3600) {
        return listOfNotNull(
            LengthPart(LengthUnit.MINUTE, seconds / 60),
            (seconds % 60).takeIf { it > 0 }?.let { LengthPart(LengthUnit.SECOND, it) },
        )
    }
    return listOfNotNull(
        LengthPart(LengthUnit.HOUR, seconds / 3600),
        ((seconds % 3600) / 60).takeIf { it > 0 }?.let { LengthPart(LengthUnit.MINUTE, it) },
    )
}

/**
 * A call's length written as a length, never as a clock time: `m:ss` beside
 * the time the call was made read as two times. [line] is what the call line
 * shows ("2 min, 5 sec", «۲ دقیقه و ۵ ثانیه», "2 dk. 5 sn."), [spoken] what
 * TalkBack reads, every word spelt out ("2 minutes, 5 seconds").
 *
 * The platform's unit formats write it (`android.icu`, API 24+: the
 * language's own words, plurals and joiners). Persian uses the full form on
 * the line too: its short unit words are the same words, and the full form
 * joins them with «و» as people say it. Plural strings stand in if the
 * platform's formats ever fail. Digits are always the reader's.
 */
class CallLengthText(locale: Locale, private val resources: Resources) {

    private val language = AppLanguage.fromTag(locale.toLanguageTag()) ?: AppLanguage.EN
    private val uLocale = ULocale.forLocale(locale)
    private val lineFormat by lazy { format(if (language == AppLanguage.FA) MeasureFormat.FormatWidth.WIDE else MeasureFormat.FormatWidth.SHORT) }
    private val spokenFormat by lazy { format(MeasureFormat.FormatWidth.WIDE) }

    fun line(seconds: Long): String = write(lengthParts(seconds), lineFormat)

    fun spoken(seconds: Long): String = write(lengthParts(seconds), spokenFormat)

    /** The same length from the plural strings alone (what [line] and [spoken] fall back to). */
    fun fromStrings(seconds: Long): String = digits(plain(lengthParts(seconds)))

    private fun format(width: MeasureFormat.FormatWidth): MeasureFormat? =
        runCatching { MeasureFormat.getInstance(uLocale, width) }.getOrNull()

    private fun write(parts: List<LengthPart>, format: MeasureFormat?): String {
        if (parts.isEmpty()) return ""
        val text = format?.let { f ->
            runCatching { f.formatMeasures(*parts.map { Measure(it.amount, icuUnit(it.unit)) }.toTypedArray()) }.getOrNull()
        }?.takeIf { it.isNotBlank() } ?: plain(parts)
        return digits(text)
    }

    private fun plain(parts: List<LengthPart>): String =
        parts.joinToString(resources.getString(R.string.call_length_join)) { part ->
            resources.getQuantityString(part.unit.plural, part.amount.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), part.amount)
        }

    private fun digits(text: String): String = Digits.localize(Digits.ascii(text), language)

    private fun icuUnit(unit: LengthUnit): MeasureUnit = when (unit) {
        LengthUnit.HOUR -> MeasureUnit.HOUR
        LengthUnit.MINUTE -> MeasureUnit.MINUTE
        LengthUnit.SECOND -> MeasureUnit.SECOND
    }
}

/** The reader's [CallLengthText], made once per language. */
@Composable
fun rememberCallLengths(): CallLengthText {
    val configuration = LocalConfiguration.current
    val resources = LocalResources.current
    val locale = configuration.locales[0] ?: Locale.ROOT
    return remember(locale, resources) { CallLengthText(locale, resources) }
}
