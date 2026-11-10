package app.core.feature.paywall

import app.core.billing.PlanGroup
import app.core.billing.PlanOption
import app.core.i18n.AppLanguage
import app.core.model.BillingPeriod
import app.core.store.ProductType
import app.core.store.StoreProduct
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The store's own price, written for the reader: a toman price regrouped in
 * the reader's digits and separator (never a Latin comma in Persian) with
 * its word apart; any other currency exactly as the store writes it, except
 * in Persian, where its number is in Persian digits with «٫» and «٬» and the
 * store's symbol after it; and the saving per month rounded half up.
 */
class StorePricesTest {

    @Test
    fun aTomanPriceIsReadWhateverDigitsAndGroupingTheStoreUses() {
        assertEquals(450_000L, StorePrices.toman("۴۵۰٬۰۰۰ تومان"))
        assertEquals(450_000L, StorePrices.toman("۴۵۰,۰۰۰ تومان"))
        assertEquals(1_200_000L, StorePrices.toman("1,200,000 Toman"))
        assertEquals(1_200_000L, StorePrices.toman("تومان ۱٬۲۰۰٬۰۰۰"))
        assertEquals(90_000L, StorePrices.toman("90000 IRT"))
        assertNull("another currency", StorePrices.toman("€4.99"))
        assertNull("a rial price is not a toman one", StorePrices.toman("۴۵۰٬۰۰۰ ریال"))
        assertNull("two numbers", StorePrices.toman("۱۲۰٬۰۰۰ تومان / ۳ ماه"))
        assertNull("no digits", StorePrices.toman("تومان"))
    }

    @Test
    fun aTomanPriceIsWrittenInTheReadersStyle() {
        assertEquals(PriceText("۴۵۰٬۰۰۰", "تومان"), StorePrices.display("450,000 Toman", AppLanguage.FA, "تومان"))
        assertEquals(PriceText("450,000", "Toman"), StorePrices.display("۴۵۰٬۰۰۰ تومان", AppLanguage.EN, "Toman"))
        assertEquals(PriceText("1.200.000", "Toman"), StorePrices.display("۱٬۲۰۰٬۰۰۰ تومان", AppLanguage.TR, "Toman"))
        assertEquals("۴۵۰٬۰۰۰ تومان", StorePrices.display("۴۵۰,۰۰۰ تومان", AppLanguage.FA, "تومان").full)
        // Any other currency is the store's own string, untouched, in English and Turkish.
        assertEquals(PriceText("€4.99", null), StorePrices.display("€4.99", AppLanguage.EN, "Toman"))
        assertEquals("US$4.99", StorePrices.display("US$4.99", AppLanguage.EN, "Toman").full)
        assertEquals("₺149,99", StorePrices.display("₺149,99", AppLanguage.TR, "Toman").full)
    }

    @Test
    fun anotherCurrencyInPersianIsWrittenInPersianDigitsWithItsSymbolAfterIt() {
        val euro = "\u2068€\u2069"
        // From the store's micros, with the currency's own decimals.
        assertEquals(PriceText("۱۲٫۴۹", euro), StorePrices.display("€12.49", AppLanguage.FA, "تومان", 12_490_000, "EUR"))
        assertEquals(PriceText("۱٬۲۳۴٫۵۰", euro), StorePrices.display("€1,234.50", AppLanguage.FA, "تومان", 1_234_500_000, "EUR"))
        assertEquals(PriceText("۵۰۰", "\u2068¥\u2069"), StorePrices.display("¥500", AppLanguage.FA, "تومان", 500_000_000, "JPY"))
        assertEquals("the store's own symbol", PriceText("۴٫۹۹", "\u2068US$\u2069"), StorePrices.display("US$4.99", AppLanguage.FA, "تومان", 4_990_000, "USD"))
        // Without micros, read from the string: the last mark followed by one or two digits is the decimal point.
        assertEquals(PriceText("۱۲٫۴۹", euro), StorePrices.display("12,49 €", AppLanguage.FA, "تومان"))
        assertEquals(PriceText("۱٬۲۳۴٫۵۶", euro), StorePrices.display("1.234,56 €", AppLanguage.FA, "تومان"))
        assertEquals(PriceText("۱٬۲۳۴", euro), StorePrices.display("€1,234", AppLanguage.FA, "تومان"))
        assertEquals("bidi marks are not the symbol", PriceText("۱۲٫۴۹", euro), StorePrices.display("\u200F€\u200E12.49", AppLanguage.FA, "تومان"))
        // Never a Latin digit, comma or point.
        val written = StorePrices.display("€1,234.50", AppLanguage.FA, "تومان", 1_234_500_000, "EUR").full
        assertTrue(written, written.none { it in '0'..'9' || it == ',' || it == '.' })
        // Not one number: the store's string as it is.
        assertEquals(PriceText("€4.99 / €9.99", null), StorePrices.display("€4.99 / €9.99", AppLanguage.FA, "تومان"))
    }

    private fun option(period: BillingPeriod, price: String, micros: Long? = null, currency: String? = null) = PlanOption(
        plan = "premium",
        period = period,
        badge = null,
        sort = period.ordinal,
        product = StoreProduct("sub.premium.${period.wire}", ProductType.SUBSCRIPTION, "", "", price, micros, currency),
    )

    @Test
    fun theSavingIsPerMonthAgainstTheShortestPeriodRoundedHalfUp() {
        val month = option(BillingPeriod.Month, "۱۸۰٬۰۰۰ تومان")
        val three = option(BillingPeriod.ThreeMonths, "۴۵۰٬۰۰۰ تومان")
        val year = option(BillingPeriod.Year, "۱٬۲۰۰٬۰۰۰ تومان")
        val plan = PlanGroup("premium", listOf(month, three, year))
        assertNull("nothing to compare the base with", StorePrices.savingPercent(month, plan))
        assertEquals("16.7 % is said as 17, as the design writes it", 17, StorePrices.savingPercent(three, plan))
        assertEquals(44, StorePrices.savingPercent(year, plan))
        // 41.7 % (Plus's year in the design) reads 42; 15.4 % (Platinum's three months) reads 15.
        val plusMonth = option(BillingPeriod.Month, "۱۲۰٬۰۰۰ تومان")
        val plusYear = option(BillingPeriod.Year, "۸۴۰٬۰۰۰ تومان")
        assertEquals(42, StorePrices.savingPercent(plusYear, PlanGroup("plus", listOf(plusMonth, plusYear))))
        val platMonth = option(BillingPeriod.Month, "۲۶۰٬۰۰۰ تومان")
        val platThree = option(BillingPeriod.ThreeMonths, "۶۶۰٬۰۰۰ تومان")
        assertEquals(15, StorePrices.savingPercent(platThree, PlanGroup("platinum", listOf(platMonth, platThree))))
    }

    @Test
    fun pricesThatCannotBeComparedSaveNothing() {
        val week = option(BillingPeriod.Week, "€1.99", 1_990_000, "EUR")
        val month = option(BillingPeriod.Month, "€4.99", 4_990_000, "EUR")
        val dollars = option(BillingPeriod.ThreeMonths, "$9.99", 9_990_000, "USD")
        val dearer = option(BillingPeriod.Year, "€99.99", 99_990_000, "EUR")
        val plan = PlanGroup("premium", listOf(week, month, dollars, dearer))
        assertNull("a week is not counted in months", StorePrices.savingPercent(week, plan))
        assertNull("another currency", StorePrices.savingPercent(dollars, plan))
        assertNull("dearer per month: no saving", StorePrices.savingPercent(dearer, plan))
        val noPrice = option(BillingPeriod.SixMonths, "six months")
        assertNull(StorePrices.savingPercent(noPrice, PlanGroup("premium", listOf(month, noPrice))))
        // Play's micros decide where the store gives them.
        val half = option(BillingPeriod.SixMonths, "€14.97", 14_970_000, "EUR")
        assertEquals(50, StorePrices.savingPercent(half, PlanGroup("premium", listOf(month, half))))
    }
}
