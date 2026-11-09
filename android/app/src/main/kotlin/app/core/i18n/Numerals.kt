package app.core.i18n

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalConfiguration

/**
 * Numbers as each language writes them, one format everywhere:
 * Persian digits with «٬» between thousands and «٪» after a percentage
 * («۱٬۲۰۰٬۰۰۰»، «۴۴٪»); English «1,200,000» and «44%»; Turkish «1.200.000»
 * and «%44». A price is the number and the currency word, never «۱۰۴ هزار».
 */
object Numerals {
    private const val PERSIAN_GROUP = '٬'
    private const val PERSIAN_PERCENT = '٪'

    /** [value] with thousands grouped, in [language]'s digits. */
    fun format(value: Long, language: AppLanguage): String {
        val negative = value < 0
        val digits = (if (negative) -value else value).toString()
        val separator = when (language) {
            AppLanguage.FA -> PERSIAN_GROUP
            AppLanguage.TR -> '.'
            AppLanguage.EN -> ','
        }
        val grouped = buildString {
            digits.forEachIndexed { index, c ->
                if (index > 0 && (digits.length - index) % 3 == 0) append(separator)
                append(c)
            }
        }
        return Digits.localize((if (negative) "-" else "") + grouped, language)
    }

    fun format(value: Int, language: AppLanguage): String = format(value.toLong(), language)

    /** [value] as a percentage: «۴۴٪», «44%», «%44». */
    fun percent(value: Int, language: AppLanguage): String = when (language) {
        AppLanguage.FA -> Digits.localize(value.toString(), language) + PERSIAN_PERCENT
        AppLanguage.TR -> "%$value"
        AppLanguage.EN -> "$value%"
    }

    /** Two digits, zero-padded: section and photo numbers («۰۱»). */
    fun twoDigits(value: Int, language: AppLanguage): String =
        Digits.localize(value.toString().padStart(2, '0'), language)

    /** Any text with its ASCII digits in [language]'s digits. */
    fun digits(text: String, language: AppLanguage): String = Digits.localize(text, language)
}

/** The language on screen (from the configuration's locale; English when unknown). */
@Composable
@ReadOnlyComposable
fun screenLanguage(): AppLanguage =
    AppLanguage.fromTag(LocalConfiguration.current.locales[0]?.toLanguageTag()) ?: AppLanguage.EN
