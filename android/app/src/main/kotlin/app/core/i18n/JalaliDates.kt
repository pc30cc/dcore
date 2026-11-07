package app.core.i18n

import java.time.LocalDate

/** A day in the Solar Hijri (Jalali) calendar: month 1 is Farvardin. */
data class JalaliDate(val year: Int, val month: Int, val day: Int)

/**
 * The Solar Hijri calendar, to and from the ISO dates the API speaks. The
 * arithmetic is the well-known 33-year-cycle algorithm; the tests check
 * every day from 1925 to 2030 both ways, which covers every birth date.
 */
object JalaliDates {

    fun toJalali(date: LocalDate): JalaliDate {
        val gy = date.year
        val gm = date.monthValue
        val gd = date.dayOfMonth
        val gdm = intArrayOf(0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
        val gy2 = if (gm > 2) gy + 1 else gy
        var days = 355666 + 365 * gy + (gy2 + 3) / 4 - (gy2 + 99) / 100 + (gy2 + 399) / 400 + gd + gdm[gm - 1]
        var jy = -1595 + 33 * (days / 12053)
        days %= 12053
        jy += 4 * (days / 1461)
        days %= 1461
        if (days > 365) {
            jy += (days - 1) / 365
            days = (days - 1) % 365
        }
        val jm: Int
        val jd: Int
        if (days < 186) {
            jm = 1 + days / 31
            jd = 1 + days % 31
        } else {
            jm = 7 + (days - 186) / 30
            jd = 1 + (days - 186) % 30
        }
        return JalaliDate(jy, jm, jd)
    }

    fun toGregorian(date: JalaliDate): LocalDate {
        val jy = date.year + 1595
        var days = -355668 + 365 * jy + (jy / 33) * 8 + ((jy % 33) + 3) / 4 + date.day +
            if (date.month < 7) (date.month - 1) * 31 else (date.month - 7) * 30 + 186
        var gy = 400 * (days / 146097)
        days %= 146097
        if (days > 36524) {
            gy += 100 * (--days / 36524)
            days %= 36524
            if (days >= 365) days++
        }
        gy += 4 * (days / 1461)
        days %= 1461
        if (days > 365) {
            gy += (days - 1) / 365
            days = (days - 1) % 365
        }
        var gd = days + 1
        val leap = (gy % 4 == 0 && gy % 100 != 0) || gy % 400 == 0
        val monthDays = intArrayOf(0, 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
        var gm = 1
        while (gm <= 12 && gd > monthDays[gm]) {
            gd -= monthDays[gm]
            gm++
        }
        return LocalDate.of(gy, gm, gd)
    }

    /** 29 or 30 for Esfand by the leap rule, 31 for the first six months, 30 for the rest. */
    fun monthLength(year: Int, month: Int): Int = when {
        month <= 6 -> 31
        month <= 11 -> 30
        else -> if (isLeap(year)) 30 else 29
    }

    /** A Jalali year is leap when its Esfand has 30 days (checked through the conversion). */
    fun isLeap(year: Int): Boolean =
        toJalali(toGregorian(JalaliDate(year, 12, 29)).plusDays(1)).let { it.month == 12 && it.day == 30 }
}

/** Digits as the language writes them: Persian digits in Persian, ASCII otherwise. */
object Digits {
    fun localize(text: String, language: AppLanguage): String =
        if (language != AppLanguage.FA) text else buildString(text.length) {
            for (c in text) append(if (c in '0'..'9') '۰' + (c - '0') else c)
        }

    /** ASCII digits for anything a person typed in any of the three scripts. */
    fun ascii(text: String): String = buildString(text.length) {
        for (c in text) {
            append(
                when (c) {
                    in '۰'..'۹' -> '0' + (c - '۰')
                    in '٠'..'٩' -> '0' + (c - '٠')
                    else -> c
                },
            )
        }
    }
}
