package app.core.feature.auth

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import app.core.i18n.AppLanguage

/**
 * Shows the number field's digits in the country's groups (`912 123 4567`,
 * a trunk `0` kept in front of the first group) and in the language's digits,
 * while the field itself holds only ASCII digits. A number typed with `+` is
 * shown as typed.
 */
class PhoneVisualTransformation(private val country: DialCountry, private val language: AppLanguage) : VisualTransformation {

    override fun filter(text: AnnotatedString): TransformedText {
        val raw = text.text
        val breaks = breaks(raw)
        val out = StringBuilder(raw.length + breaks.size)
        val originalToTransformed = IntArray(raw.length + 1)
        val transformedToOriginal = ArrayList<Int>(raw.length + breaks.size + 1)
        raw.forEachIndexed { index, c ->
            if (index in breaks) {
                out.append(' ')
                transformedToOriginal += index
            }
            originalToTransformed[index] = out.length
            out.append(if (language == AppLanguage.FA && c in '0'..'9') '۰' + (c - '0') else c)
            transformedToOriginal += index
        }
        originalToTransformed[raw.length] = out.length
        transformedToOriginal += raw.length
        return TransformedText(
            AnnotatedString(out.toString()),
            object : OffsetMapping {
                override fun originalToTransformed(offset: Int): Int = originalToTransformed[offset.coerceIn(0, raw.length)]
                override fun transformedToOriginal(offset: Int): Int = transformedToOriginal[offset.coerceIn(0, transformedToOriginal.lastIndex)]
            },
        )
    }

    /** The indices before which a space goes. */
    internal fun breaks(raw: String): Set<Int> {
        if (raw.startsWith("+") || raw.startsWith("00")) return emptySet()
        val prefix = if (raw.startsWith("0")) 1 else 0
        val positions = mutableSetOf<Int>()
        var at = prefix
        for (size in country.groups.dropLast(1)) {
            at += size
            if (at < raw.length) positions += at
        }
        return positions
    }

    override fun equals(other: Any?): Boolean =
        other is PhoneVisualTransformation && other.country == country && other.language == language

    override fun hashCode(): Int = country.hashCode() * 31 + language.hashCode()
}
