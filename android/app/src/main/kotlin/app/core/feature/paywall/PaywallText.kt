package app.core.feature.paywall

import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import app.core.R
import app.core.billing.PlanGroup
import app.core.billing.PlanOption
import app.core.billing.PurchaseFailure
import app.core.feature.auth.brandPlural
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.model.BillingPeriod
import app.core.model.PlanQuotas
import app.core.model.WalletItem
import app.core.store.StoreProduct
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Currency
import kotlin.math.floor

/** The months a period bills for; null for a week (it is not counted in months). */
val BillingPeriod.months: Int?
    get() = when (this) {
        BillingPeriod.Month -> 1
        BillingPeriod.ThreeMonths -> 3
        BillingPeriod.SixMonths -> 6
        BillingPeriod.Year -> 12
        BillingPeriod.Week, BillingPeriod.Unknown -> null
    }

/** «۳ ماهه», "3 months", «۱ هفته»: a period row's name. */
@Composable
fun periodLabel(period: BillingPeriod, language: AppLanguage): String {
    val months = period.months
    return if (months != null) {
        brandPlural(R.plurals.paywall_months, months, Numerals.format(months, language))
    } else {
        brandPlural(R.plurals.paywall_weeks, 1, Numerals.format(1, language))
    }
}

/** The one store line under the button: how often it renews and where to cancel. */
@Composable
fun renewalLine(period: BillingPeriod, storeName: String, language: AppLanguage): String = when (period) {
    BillingPeriod.Week -> brandString(R.string.paywall_renew_week, storeName)
    BillingPeriod.Month -> brandString(R.string.paywall_renew_month, storeName)
    BillingPeriod.Year -> brandString(R.string.paywall_renew_year, storeName)
    else -> brandString(R.string.paywall_renew_months, Numerals.format(period.months ?: 1, language), storeName)
}

/** One line a plan can give, in the order a plan's lines are listed. */
private enum class Benefit {
    SEE_LIKES,
    UNLIMITED_LIKES,
    MESSAGES,
    SUPERLIKES,
    REWIND,
    BOOSTS,
    PRIORITY,
    READ_RECEIPTS,
    INCOGNITO,
    FILTERS,
    TRAVEL,
    PROFILE_VIEWS,
    SECOND_LOOK,
    ;

    fun givenBy(plan: PlanGroup): Boolean {
        val f = plan.features
        val q = plan.quotas
        return when (this) {
            SEE_LIKES -> f.seeLikes
            UNLIMITED_LIKES -> q.dailyLikes == PlanQuotas.UNLIMITED
            MESSAGES -> Quota.of(q.dailyDm) > 0
            SUPERLIKES -> Quota.of(q.weeklySuperlikes) > 0
            REWIND -> f.rewind
            BOOSTS -> Quota.of(q.monthlyBoosts) > 0
            PRIORITY -> f.priorityLikes
            READ_RECEIPTS -> f.readReceipts
            INCOGNITO -> f.incognito
            FILTERS -> f.advancedFilters
            TRAVEL -> f.travelMode
            PROFILE_VIEWS -> f.profileViews
            SECOND_LOOK -> f.secondLook
        }
    }

    /** What [plan] gives here beyond [lower]: something [lower] lacks, or a larger quota. */
    fun raisedOver(plan: PlanGroup, lower: PlanGroup): Boolean = givenBy(plan) && when (this) {
        MESSAGES -> Quota.of(plan.quotas.dailyDm) > Quota.of(lower.quotas.dailyDm)
        SUPERLIKES -> Quota.of(plan.quotas.weeklySuperlikes) > Quota.of(lower.quotas.weeklySuperlikes)
        BOOSTS -> Quota.of(plan.quotas.monthlyBoosts) > Quota.of(lower.quotas.monthlyBoosts)
        else -> !givenBy(lower)
    }
}

/** A quota as a comparable amount: unlimited above any number, none (or anything else negative) as 0. */
private object Quota {
    fun of(value: Int): Long = when {
        value == PlanQuotas.UNLIMITED -> Long.MAX_VALUE
        value < 0 -> 0
        else -> value.toLong()
    }
}

/** Whether [this] gives everything [lower] gives, at least as much of each quota. */
private fun PlanGroup.covers(lower: PlanGroup): Boolean {
    val a = features
    val b = lower.features
    val flags = listOf(
        a.seeLikes to b.seeLikes, a.rewind to b.rewind, a.readReceipts to b.readReceipts, a.incognito to b.incognito,
        a.travelMode to b.travelMode, a.advancedFilters to b.advancedFilters, a.profileViews to b.profileViews,
        a.secondLook to b.secondLook, a.priorityLikes to b.priorityLikes, a.audioCalls to b.audioCalls, a.videoCalls to b.videoCalls,
    )
    val q = quotas
    val r = lower.quotas
    val amounts = listOf(
        q.dailyLikes to r.dailyLikes, q.weeklySuperlikes to r.weeklySuperlikes, q.dailyDm to r.dailyDm,
        q.weeklyDmGift to r.weeklyDmGift, q.monthlyBoosts to r.monthlyBoosts,
    )
    return flags.all { (mine, theirs) -> mine || !theirs } && amounts.all { (mine, theirs) -> Quota.of(mine) >= Quota.of(theirs) }
}

/** The plan sold here ranked right below [plan], when the server ranks both. */
private fun List<PlanGroup>.below(plan: PlanGroup): PlanGroup? {
    val rank = plan.rank ?: return null
    return filter { it.plan != plan.plan && it.rank != null && it.rank < rank }.maxByOrNull { it.rank!! }
}

@Composable
private fun line(benefit: Benefit, plan: PlanGroup, language: AppLanguage): String {
    val q = plan.quotas
    fun n(value: Int) = Numerals.format(value, language)
    return when (benefit) {
        Benefit.SEE_LIKES -> brandString(R.string.paywall_benefit_see_likes)
        Benefit.UNLIMITED_LIKES -> brandString(R.string.paywall_benefit_unlimited_likes)
        Benefit.MESSAGES -> if (q.dailyDm == PlanQuotas.UNLIMITED) {
            brandString(R.string.paywall_benefit_messages)
        } else {
            brandPlural(R.plurals.paywall_benefit_messages_daily, q.dailyDm, n(q.dailyDm))
        }
        Benefit.SUPERLIKES -> if (q.weeklySuperlikes == PlanQuotas.UNLIMITED) {
            brandString(R.string.paywall_benefit_unlimited_superlikes)
        } else {
            brandPlural(R.plurals.paywall_benefit_superlikes, q.weeklySuperlikes, n(q.weeklySuperlikes))
        }
        Benefit.REWIND -> brandString(R.string.paywall_benefit_rewind)
        Benefit.BOOSTS -> if (q.monthlyBoosts == PlanQuotas.UNLIMITED) {
            brandString(R.string.paywall_benefit_unlimited_boosts)
        } else {
            brandPlural(R.plurals.paywall_benefit_boosts, q.monthlyBoosts, n(q.monthlyBoosts))
        }
        Benefit.PRIORITY -> brandString(R.string.paywall_benefit_priority)
        Benefit.READ_RECEIPTS -> brandString(R.string.paywall_benefit_read_receipts)
        Benefit.INCOGNITO -> brandString(R.string.paywall_benefit_incognito)
        Benefit.FILTERS -> brandString(R.string.paywall_benefit_filters)
        Benefit.TRAVEL -> brandString(R.string.paywall_benefit_travel)
        Benefit.PROFILE_VIEWS -> brandString(R.string.paywall_benefit_profile_views)
        Benefit.SECOND_LOOK -> brandString(R.string.paywall_benefit_second_look)
    }
}

/**
 * What a plan gives, at most [MAX_BENEFITS] lines, from the server's switches
 * and quotas in this order: see who likes you, unlimited likes, messages
 * before a match, super likes, undo, boosts, likes seen first, read
 * receipts, incognito, filters, travel, profile views, a second look.
 *
 * A plan that gives everything the plan sold right below it ([plans], by
 * the server's rank) gives, and more, says so first («همه‌ی امکانات
 * پریمیوم») and then lists only what it adds or raises, so a dearer plan
 * shows why it costs more. A plan none of these describe shows its own
 * description from the server, if it has one.
 */
@Composable
fun benefitLines(plan: PlanGroup, plans: List<PlanGroup>, planNames: Map<String, String>, language: AppLanguage): List<String> {
    val given = Benefit.entries.filter { it.givenBy(plan) }
    val lower = plans.below(plan)?.takeIf { plan.covers(it) }
    if (lower != null) {
        val added = given.filter { it.raisedOver(plan, lower) }
        if (added.isNotEmpty()) {
            val everything = brandString(R.string.paywall_benefit_everything, planName(lower.plan, planNames, lower.name))
            return listOf(everything) + added.take(MAX_BENEFITS - 1).map { line(it, plan, language) }
        }
    }
    return given.take(MAX_BENEFITS).map { line(it, plan, language) }.ifEmpty { listOfNotNull(plan.description) }
}

const val MAX_BENEFITS = 4

/**
 * A store's price as a screen writes it: the number and, apart, its
 * currency. A toman price ([StorePrices.toman]) is the store's own amount
 * regrouped in the reader's digits and separator («۴۵۰٬۰۰۰», "450,000",
 * "450.000") with the currency word. Any other currency is the store's
 * string exactly ([unit] null), except in Persian, where the number is
 * written in Persian digits with «٫» and «٬» and the store's symbol after
 * it («۱۲٫۴۹ €»).
 */
data class PriceText(val amount: String, val unit: String?) {
    /** The price in one piece («۴۵۰٬۰۰۰ تومان», "€4.99"), for a button or a sentence. */
    val full: String get() = if (unit == null) amount else "$amount $unit"
}

object StorePrices {
    private val TOMAN = Regex("""(?i)تومان|toman|\bIRT\b""")
    private val GROUPING = setOf(',', '٬', '.', '\'', '\u2019', ' ', '\u00A0', '\u202F', '\u2009')
    private const val PERSIAN_GROUP = '٬'
    private const val PERSIAN_DECIMAL = '٫'

    /** Bidi marks a store may put around a price; never part of its symbol. */
    private val BIDI = Regex("[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]")

    /**
     * The whole number of toman in a store's price string («۴۵۰٬۰۰۰ تومان»,
     * "450,000 Toman"), or null when it is not one: no toman word, no digits,
     * or more than one number in it.
     */
    fun toman(formatted: String): Long? {
        if (!TOMAN.containsMatchIn(formatted)) return null
        val ascii = Digits.ascii(formatted)
        val first = ascii.indexOfFirst(Char::isDigit).takeIf { it >= 0 } ?: return null
        val last = ascii.indexOfLast(Char::isDigit)
        val number = ascii.substring(first, last + 1)
        if (number.any { !it.isDigit() && it !in GROUPING }) return null
        val digits = number.filter(Char::isDigit)
        return digits.takeIf { it.length in 1..15 }?.toLongOrNull()
    }

    fun display(product: StoreProduct, language: AppLanguage, currencyWord: String): PriceText =
        display(product.formattedPrice, language, currencyWord, product.priceMicros, product.currencyCode)

    fun display(formatted: String, language: AppLanguage, currencyWord: String, micros: Long? = null, currency: String? = null): PriceText {
        toman(formatted)?.let { return PriceText(Numerals.format(it, language), currencyWord) }
        if (language == AppLanguage.FA) persian(formatted, micros, currency)?.let { return it }
        return PriceText(formatted, null)
    }

    /**
     * Another currency in Persian: the amount from the store's micros (its
     * currency's own decimals), else read from its string, in Persian digits
     * with «٬» and «٫»; the symbol as the store writes it («€», "US$"),
     * isolated so it stays whole beside Persian text. Null when the string
     * holds no single number.
     */
    private fun persian(formatted: String, micros: Long?, currency: String?): PriceText? {
        val ascii = Digits.ascii(formatted.replace(PERSIAN_DECIMAL, '.').replace(PERSIAN_GROUP, ','))
        val first = ascii.indexOfFirst(Char::isDigit).takeIf { it >= 0 } ?: return null
        val last = ascii.indexOfLast(Char::isDigit)
        val number = ascii.substring(first, last + 1)
        if (number.any { !it.isDigit() && it !in GROUPING }) return null
        val symbol = (ascii.substring(0, first) + ascii.substring(last + 1)).replace(BIDI, "").trim().ifEmpty { currency ?: return null }
        val (whole, fraction) = if (micros != null && micros >= 0 && currency != null) fromMicros(micros, currency) else split(number)
        val grouped = buildString {
            whole.forEachIndexed { i, c ->
                if (i > 0 && (whole.length - i) % 3 == 0) append(PERSIAN_GROUP)
                append(c)
            }
            if (fraction.isNotEmpty()) append(PERSIAN_DECIMAL).append(fraction)
        }
        return PriceText(Digits.localize(grouped, AppLanguage.FA), "\u2068$symbol\u2069")
    }

    private fun fromMicros(micros: Long, currency: String): Pair<String, String> {
        val decimals = runCatching { Currency.getInstance(currency).defaultFractionDigits }.getOrNull()?.takeIf { it >= 0 } ?: 2
        val plain = BigDecimal.valueOf(micros, 6).setScale(decimals, RoundingMode.HALF_UP).toPlainString()
        return plain.substringBefore('.') to plain.substringAfter('.', "")
    }

    /** The whole and decimal digits of a price string's number: the last '.' or ',' followed by one or two digits is the decimal point. */
    private fun split(number: String): Pair<String, String> {
        val mark = number.indexOfLast { it == '.' || it == ',' }
        val tail = if (mark >= 0) number.substring(mark + 1) else ""
        return if (mark >= 0 && tail.length in 1..2 && tail.all(Char::isDigit)) {
            number.substring(0, mark).filter(Char::isDigit) to tail
        } else {
            number.filter(Char::isDigit) to ""
        }
    }

    /** A comparable amount and its currency: the store's micros, else a toman price read from its string. */
    fun amount(product: StoreProduct): Pair<Double, String>? {
        val micros = product.priceMicros
        val currency = product.currencyCode
        if (micros != null && micros > 0 && currency != null) return micros.toDouble() to currency
        return toman(product.formattedPrice)?.takeIf { it > 0 }?.let { it.toDouble() to "IRT" }
    }

    /**
     * What [option] saves per month against the plan's shortest monthly
     * period, as a whole percentage rounded half up (16.7 % is said as 17,
     * as the design writes it); null when there is nothing to compare with,
     * the prices cannot be compared, or it saves less than 0.5 %.
     */
    fun savingPercent(option: PlanOption, plan: PlanGroup): Int? {
        val months = option.period.months ?: return null
        val base = plan.options.filter { it.period.months != null }.minByOrNull { it.period.months!! } ?: return null
        if (base.key == option.key) return null
        val (price, currency) = amount(option.product) ?: return null
        val (basePrice, baseCurrency) = amount(base.product) ?: return null
        if (currency != baseCurrency) return null
        val perMonth = price / months
        val basePerMonth = basePrice / base.period.months!!
        val saving = floor((1 - perMonth / basePerMonth) * 100 + 0.5).toInt()
        return saving.takeIf { it >= 1 }
    }
}

/** The one-line reason a purchase stopped; `%1$s` is the store's name where it appears. */
@StringRes
fun PurchaseFailure.message(): Int = when (this) {
    PurchaseFailure.STORE_MISSING -> R.string.paywall_fail_store_missing
    PurchaseFailure.STORE_NOT_READY -> R.string.paywall_fail_not_ready
    PurchaseFailure.NOT_SUPPORTED -> R.string.paywall_fail_not_supported
    PurchaseFailure.STORE_UNREACHABLE -> R.string.paywall_fail_unreachable
    PurchaseFailure.STORE_ERROR -> R.string.paywall_fail_store_error
    PurchaseFailure.INVALID -> R.string.paywall_fail_invalid
    PurchaseFailure.OTHER_ACCOUNT -> R.string.paywall_fail_other_account
    PurchaseFailure.NOT_RESTORED -> R.string.paywall_fail_not_restored
    PurchaseFailure.STILL_COMPLETING -> R.string.paywall_fail_completing
    PurchaseFailure.NOT_ACTIVE -> R.string.paywall_fail_not_active
    PurchaseFailure.CHANGE_NOT_SUPPORTED -> R.string.paywall_locked
    PurchaseFailure.ALREADY_CURRENT -> R.string.paywall_fail_current
    PurchaseFailure.MANAGED_ELSEWHERE -> R.string.paywall_held_elsewhere
    PurchaseFailure.SIGNED_OUT -> R.string.paywall_fail_signed_out
}

/** A restore's notice; `%1$s` is the store's name where it appears. */
@StringRes
fun RestoreNotice.message(): Int = when (this) {
    RestoreNotice.RESTORED -> R.string.paywall_restored
    RestoreNotice.UP_TO_DATE -> R.string.paywall_restore_up_to_date
    RestoreNotice.UP_TO_DATE_WITH_OTHER_ACCOUNT -> R.string.paywall_restore_up_to_date_other_account
    RestoreNotice.NOTHING -> R.string.paywall_restore_nothing
    RestoreNotice.OTHER_ACCOUNT -> R.string.paywall_fail_other_account
    RestoreNotice.NOT_CONFIRMED -> R.string.paywall_restore_not_confirmed
    RestoreNotice.NOT_ACTIVE -> R.string.paywall_restore_not_active
    RestoreNotice.OFFLINE -> R.string.error_offline
    RestoreNotice.FAILED -> R.string.error_generic
    RestoreNotice.STORE_UNAVAILABLE -> R.string.paywall_restore_store
}

@StringRes
fun WalletItem.packsTitle(): Int = when (this) {
    WalletItem.Boost -> R.string.packs_title_boost
    WalletItem.Spotlight -> R.string.packs_title_spotlight
    WalletItem.Dm -> R.string.packs_title_dm
    else -> R.string.packs_title_superlike
}

@PluralsRes
fun WalletItem.quantity(): Int = when (this) {
    WalletItem.Boost -> R.plurals.packs_quantity_boost
    WalletItem.Spotlight -> R.plurals.packs_quantity_spotlight
    WalletItem.Dm -> R.plurals.packs_quantity_dm
    else -> R.plurals.packs_quantity_superlike
}

/** A plan's name: the server's (in the session's language), else the config's, else its key. */
fun planName(plan: String, planNames: Map<String, String>, serverName: String? = null): String =
    serverName?.takeIf(String::isNotBlank)
        ?: planNames[plan]?.takeIf(String::isNotBlank)
        ?: plan.replace('_', ' ').replaceFirstChar { it.titlecase() }
