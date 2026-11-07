package app.core.i18n

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class JalaliDatesTest {

    @Test
    fun `known days convert both ways`() {
        val pairs = listOf(
            LocalDate.of(2025, 3, 21) to JalaliDate(1404, 1, 1),
            LocalDate.of(2025, 3, 20) to JalaliDate(1403, 12, 30),
            LocalDate.of(2021, 3, 20) to JalaliDate(1399, 12, 30),
            LocalDate.of(1979, 2, 11) to JalaliDate(1357, 11, 22),
            LocalDate.of(2000, 1, 1) to JalaliDate(1378, 10, 11),
            LocalDate.of(2026, 11, 6) to JalaliDate(1405, 8, 15),
            LocalDate.of(1995, 4, 2) to JalaliDate(1374, 1, 13),
        )
        for ((gregorian, jalali) in pairs) {
            assertEquals("to Jalali: $gregorian", jalali, JalaliDates.toJalali(gregorian))
            assertEquals("to Gregorian: $jalali", gregorian, JalaliDates.toGregorian(jalali))
        }
    }

    @Test
    fun `every day of a century round-trips`() {
        var day = LocalDate.of(1925, 1, 1)
        val end = LocalDate.of(2030, 12, 31)
        while (!day.isAfter(end)) {
            assertEquals(day, JalaliDates.toGregorian(JalaliDates.toJalali(day)))
            day = day.plusDays(1)
        }
    }

    @Test
    fun `month lengths and leap years`() {
        assertEquals(31, JalaliDates.monthLength(1404, 1))
        assertEquals(30, JalaliDates.monthLength(1404, 7))
        assertTrue(JalaliDates.isLeap(1403))
        assertTrue(JalaliDates.isLeap(1399))
        assertFalse(JalaliDates.isLeap(1404))
        assertEquals(30, JalaliDates.monthLength(1403, 12))
        assertEquals(29, JalaliDates.monthLength(1404, 12))
    }

    @Test
    fun `digits follow the language`() {
        assertEquals("۱۴۰۵/۸/۱۵", Digits.localize("1405/8/15", AppLanguage.FA))
        assertEquals("1405/8/15", Digits.localize("1405/8/15", AppLanguage.TR))
        assertEquals("09121234567", Digits.ascii("۰۹۱۲۱۲۳٤٥٦٧"))
    }
}
