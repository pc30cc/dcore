package app.core.feature.auth

import java.util.Locale

/**
 * A country in the phone number picker: its calling code and how long its
 * national numbers are (without the trunk `0`). The display name comes from
 * the platform in the app's language ([displayName]), never from this file.
 */
data class DialCountry(
    /** ISO 3166-1 alpha-2, upper case. */
    val iso: String,
    /** Without the `+`. */
    val dialCode: String,
    val nationalLengths: IntRange,
    /** Digit groups for display, e.g. `3, 3, 4`. */
    val groups: List<Int> = listOf(3, 3, 4),
    /** What a mobile number starts with, when every one does (`9` under +98, `5` under +90). */
    val mobileStart: Char? = null,
) {
    fun displayName(language: Locale): String =
        Locale.Builder().setRegion(iso).build().getDisplayCountry(language).ifBlank { iso }

    /** The flag, from the regional indicator symbols of [iso]. */
    val flag: String
        get() = iso.uppercase().map { Character.toChars(0x1F1E6 + (it - 'A')).concatToString() }.joinToString("")

    /** An example of a national number, for the field's hint (digits only). */
    val example: String
        get() = buildString {
            append(mobileStart ?: '1')
            var next = 2
            while (length < nationalLengths.last.coerceAtMost(10)) {
                append(('0' + next % 10))
                next++
            }
        }
}

/** What the number field holds, read as a phone number. */
sealed interface PhoneParse {
    /** A complete number in E.164 (`+989121234567`). */
    data class Valid(val e164: String, val country: DialCountry?) : PhoneParse

    /** Not enough digits yet. */
    data object Incomplete : PhoneParse

    /** Cannot be a number of the chosen country (too long, wrong start). */
    data object Invalid : PhoneParse
}

/**
 * Phone numbers as the sign-in screen needs them: digits from any keyboard,
 * the trunk prefix dropped, the country recognised from a typed `+` or `00`,
 * and a light length check so the button can wait for a whole number.
 *
 * The server is the judge (`phone_invalid`, `phone_not_allowed`): this only
 * keeps obviously incomplete numbers from being sent.
 */
object PhoneNumbers {

    /** The countries offered in the picker. A number typed with `+` may be from any other one. */
    val countries: List<DialCountry> = listOf(
        DialCountry("IR", "98", 10..10, listOf(3, 3, 4), mobileStart = '9'),
        DialCountry("TR", "90", 10..10, listOf(3, 3, 2, 2), mobileStart = '5'),
        DialCountry("AF", "93", 9..9, listOf(2, 3, 4)),
        DialCountry("AE", "971", 9..9, listOf(2, 3, 4)),
        DialCountry("AM", "374", 8..8, listOf(2, 3, 3)),
        DialCountry("AR", "54", 10..11, listOf(3, 3, 4)),
        DialCountry("AT", "43", 10..13, listOf(3, 4, 4)),
        DialCountry("AU", "61", 9..9, listOf(3, 3, 3)),
        DialCountry("AZ", "994", 9..9, listOf(2, 3, 2, 2)),
        DialCountry("BE", "32", 9..9, listOf(3, 2, 2, 2)),
        DialCountry("BG", "359", 8..9, listOf(3, 3, 3)),
        DialCountry("BH", "973", 8..8, listOf(4, 4)),
        DialCountry("BR", "55", 10..11, listOf(2, 5, 4)),
        DialCountry("CA", "1", 10..10, listOf(3, 3, 4)),
        DialCountry("CH", "41", 9..9, listOf(2, 3, 2, 2)),
        DialCountry("CN", "86", 11..11, listOf(3, 4, 4)),
        DialCountry("CY", "357", 8..8, listOf(2, 6)),
        DialCountry("CZ", "420", 9..9, listOf(3, 3, 3)),
        DialCountry("DE", "49", 10..11, listOf(3, 4, 4)),
        DialCountry("DK", "45", 8..8, listOf(2, 2, 2, 2)),
        DialCountry("EG", "20", 10..10, listOf(3, 3, 4)),
        DialCountry("ES", "34", 9..9, listOf(3, 3, 3)),
        DialCountry("FI", "358", 6..10, listOf(2, 3, 5)),
        DialCountry("FR", "33", 9..9, listOf(1, 2, 2, 2, 2)),
        DialCountry("GB", "44", 10..10, listOf(4, 6), mobileStart = '7'),
        DialCountry("GE", "995", 9..9, listOf(3, 3, 3)),
        DialCountry("GR", "30", 10..10, listOf(3, 3, 4)),
        DialCountry("HK", "852", 8..8, listOf(4, 4)),
        DialCountry("HR", "385", 8..9, listOf(2, 3, 4)),
        DialCountry("HU", "36", 9..9, listOf(2, 3, 4)),
        DialCountry("ID", "62", 9..12, listOf(3, 4, 5)),
        DialCountry("IE", "353", 9..9, listOf(2, 3, 4)),
        DialCountry("IN", "91", 10..10, listOf(5, 5)),
        DialCountry("IQ", "964", 10..10, listOf(3, 3, 4)),
        DialCountry("IT", "39", 9..10, listOf(3, 3, 4)),
        DialCountry("JO", "962", 9..9, listOf(1, 4, 4)),
        DialCountry("JP", "81", 10..10, listOf(2, 4, 4)),
        DialCountry("KE", "254", 9..9, listOf(3, 3, 3)),
        DialCountry("KR", "82", 9..10, listOf(2, 4, 4)),
        DialCountry("KW", "965", 8..8, listOf(4, 4)),
        DialCountry("LB", "961", 7..8, listOf(2, 3, 3)),
        DialCountry("LU", "352", 6..11, listOf(3, 3, 3)),
        DialCountry("MA", "212", 9..9, listOf(3, 2, 2, 2)),
        DialCountry("MX", "52", 10..10, listOf(3, 3, 4)),
        DialCountry("MY", "60", 9..10, listOf(2, 4, 4)),
        DialCountry("NG", "234", 10..10, listOf(3, 3, 4)),
        DialCountry("NL", "31", 9..9, listOf(1, 4, 4)),
        DialCountry("NO", "47", 8..8, listOf(3, 2, 3)),
        DialCountry("NZ", "64", 8..10, listOf(2, 3, 4)),
        DialCountry("OM", "968", 8..8, listOf(4, 4)),
        DialCountry("PH", "63", 10..10, listOf(3, 3, 4)),
        DialCountry("PK", "92", 10..10, listOf(3, 7)),
        DialCountry("PL", "48", 9..9, listOf(3, 3, 3)),
        DialCountry("PT", "351", 9..9, listOf(3, 3, 3)),
        DialCountry("QA", "974", 8..8, listOf(4, 4)),
        DialCountry("RO", "40", 9..9, listOf(3, 3, 3)),
        DialCountry("RS", "381", 8..9, listOf(2, 3, 4)),
        DialCountry("RU", "7", 10..10, listOf(3, 3, 2, 2)),
        DialCountry("SA", "966", 9..9, listOf(2, 3, 4)),
        DialCountry("SE", "46", 7..9, listOf(2, 3, 2, 2)),
        DialCountry("SG", "65", 8..8, listOf(4, 4)),
        DialCountry("TH", "66", 9..9, listOf(2, 3, 4)),
        DialCountry("TJ", "992", 9..9, listOf(2, 3, 4)),
        DialCountry("TM", "993", 8..8, listOf(2, 6)),
        DialCountry("UA", "380", 9..9, listOf(2, 3, 2, 2)),
        DialCountry("US", "1", 10..10, listOf(3, 3, 4)),
        DialCountry("UZ", "998", 9..9, listOf(2, 3, 2, 2)),
        DialCountry("VN", "84", 9..10, listOf(3, 3, 4)),
        DialCountry("ZA", "27", 9..9, listOf(2, 3, 4)),
    )

    private val byIso = countries.associateBy { it.iso }

    /** When two countries share a calling code (`+1`, `+7`), the one a number names by default. */
    private val primaryFor = mapOf("1" to "US", "7" to "RU")

    fun country(iso: String?): DialCountry? = iso?.uppercase()?.let(byIso::get)

    /** E.164 allows 15 digits after the `+`, at least 8 in practice. */
    private val E164 = 8..15

    /**
     * Only the digits of [input], as ASCII: Persian (۰-۹) and Arabic-Indic
     * (٠-٩) digits are converted, everything else (spaces, dashes,
     * brackets) is dropped. A leading `+` is kept.
     */
    fun digits(input: String): String = buildString {
        input.forEachIndexed { index, c ->
            val digit = asciiDigit(c)
            when {
                digit != null -> append(digit)
                c == '+' && isEmpty() && input.substring(0, index).isBlank() -> append('+')
            }
        }
    }

    fun asciiDigit(c: Char): Char? = when (c) {
        in '0'..'9' -> c
        in '۰'..'۹' -> '0' + (c - '۰')
        in '٠'..'٩' -> '0' + (c - '٠')
        else -> null
    }

    /**
     * [input] typed with an international prefix (`+90…`, `0090…`): the
     * country it names and the national digits after the code. Null for a
     * national number.
     */
    fun international(input: String): Pair<DialCountry?, String>? {
        val raw = digits(input)
        val afterPlus = when {
            raw.startsWith("+") -> raw.substring(1)
            raw.startsWith("00") -> raw.substring(2)
            else -> return null
        }
        // Calling codes are prefix-free: the first match from 1 to 3 digits is the code.
        for (length in 1..3) {
            if (afterPlus.length < length) break
            val code = afterPlus.substring(0, length)
            val match = primaryFor[code]?.let(byIso::get) ?: countries.firstOrNull { it.dialCode == code }
            if (match != null) return match to afterPlus.substring(length)
        }
        return null to afterPlus
    }

    /** The national digits a person typed, without the trunk `0`. */
    fun national(input: String): String = digits(input).removePrefix("+").let { it.trimStart('0') }

    /**
     * Reads what the field holds against [country]: a number typed with `+`
     * or `00` is read on its own terms (and may name another country), any
     * other is national.
     */
    fun parse(country: DialCountry, input: String): PhoneParse {
        val international = international(input)
        if (international != null) {
            val (named, rest) = international
            if (named != null) return check(named, rest.trimStart('0'))
            // A calling code this picker does not list: any plausible E.164 length goes to the server.
            val all = digits(input).removePrefix("+").removePrefix("00")
            return when {
                all.length < E164.first -> PhoneParse.Incomplete
                all.length > E164.last -> PhoneParse.Invalid
                else -> PhoneParse.Valid("+$all", null)
            }
        }
        return check(country, national(input))
    }

    private fun check(country: DialCountry, national: String): PhoneParse = when {
        national.isEmpty() -> PhoneParse.Incomplete
        country.mobileStart != null && national.first() != country.mobileStart -> PhoneParse.Invalid
        national.length < country.nationalLengths.first -> PhoneParse.Incomplete
        national.length > country.nationalLengths.last -> PhoneParse.Invalid
        else -> PhoneParse.Valid("+${country.dialCode}$national", country)
    }

    /** [national] in the country's groups, `912 123 4567`; digits past the groups stay together at the end. */
    fun group(country: DialCountry?, national: String): String {
        val groups = country?.groups ?: listOf(3, 3, 4)
        val out = StringBuilder()
        var index = 0
        for (size in groups) {
            if (index >= national.length) break
            if (out.isNotEmpty()) out.append(' ')
            val end = (index + size).coerceAtMost(national.length)
            out.append(national, index, end)
            index = end
        }
        if (index < national.length) out.append(national, index, national.length)
        return out.toString()
    }

    /** `+98 912 123 4567`, for showing a number back to its holder. */
    fun display(e164: String): String {
        val international = international(e164) ?: return e164
        val (country, rest) = international
        return if (country == null) e164 else "+${country.dialCode} ${group(country, rest)}"
    }

    /**
     * The country to start the picker on: the store's home for the Bazaar
     * build, else the SIM's or network's country, else the language's.
     */
    fun defaultCountry(storeDefault: String?, simIso: String?, networkIso: String?, language: String?): DialCountry =
        country(storeDefault)
            ?: country(simIso)
            ?: country(networkIso)
            ?: when (language) {
                "fa" -> country("IR")
                "tr" -> country("TR")
                else -> null
            }
            ?: country("US")!!
}
