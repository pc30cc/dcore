package app.core.i18n

import org.junit.Assert.assertEquals
import org.junit.Test

/** One number format per language: Persian digits with «٬» and «٪», English and Turkish their own. */
class NumeralsTest {

    @Test
    fun `prices group thousands in each language's way`() {
        assertEquals("۱٬۲۰۰٬۰۰۰", Numerals.format(1_200_000, AppLanguage.FA))
        assertEquals("1,200,000", Numerals.format(1_200_000, AppLanguage.EN))
        assertEquals("1.200.000", Numerals.format(1_200_000, AppLanguage.TR))
        assertEquals("۹۹۹", Numerals.format(999, AppLanguage.FA))
        assertEquals("-1,000", Numerals.format(-1000, AppLanguage.EN))
    }

    @Test
    fun `percentages put the sign where each language does`() {
        assertEquals("۴۴٪", Numerals.percent(44, AppLanguage.FA))
        assertEquals("44%", Numerals.percent(44, AppLanguage.EN))
        assertEquals("%44", Numerals.percent(44, AppLanguage.TR))
    }

    @Test
    fun `section numbers have two digits`() {
        assertEquals("۰۱", Numerals.twoDigits(1, AppLanguage.FA))
        assertEquals("12", Numerals.twoDigits(12, AppLanguage.EN))
        assertEquals("۴ / ۲۰", Numerals.digits("4 / 20", AppLanguage.FA))
    }
}
