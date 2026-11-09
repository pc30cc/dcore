package app.core.feature.paywall

import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import app.core.R
import app.core.billing.ProductBadge
import app.core.billing.PurchaseFailure
import app.core.model.BillingPeriod
import app.core.model.Plan
import app.core.model.WalletItem

/** "1 month", "3 months". */
@StringRes
fun BillingPeriod.label(): Int = when (this) {
    BillingPeriod.Week -> R.string.paywall_period_week
    BillingPeriod.Month -> R.string.paywall_period_month
    BillingPeriod.ThreeMonths -> R.string.paywall_period_3m
    BillingPeriod.SixMonths -> R.string.paywall_period_6m
    BillingPeriod.Year, BillingPeriod.Unknown -> R.string.paywall_period_year
}

/** "every 3 months", the renewal's rhythm. */
@StringRes
fun BillingPeriod.every(): Int = when (this) {
    BillingPeriod.Week -> R.string.paywall_every_week
    BillingPeriod.Month -> R.string.paywall_every_month
    BillingPeriod.ThreeMonths -> R.string.paywall_every_3m
    BillingPeriod.SixMonths -> R.string.paywall_every_6m
    BillingPeriod.Year, BillingPeriod.Unknown -> R.string.paywall_every_year
}

@StringRes
fun ProductBadge.label(): Int = when (this) {
    ProductBadge.POPULAR -> R.string.paywall_badge_popular
    ProductBadge.BEST_VALUE -> R.string.paywall_badge_best_value
    ProductBadge.NEW -> R.string.paywall_badge_new
}

@StringRes
fun PaywallEntry.headline(): Int = when (this) {
    PaywallEntry.SEE_LIKES -> R.string.paywall_entry_see_likes
    PaywallEntry.READ_RECEIPTS -> R.string.paywall_entry_read_receipts
    PaywallEntry.INCOGNITO -> R.string.paywall_entry_incognito
    PaywallEntry.ADVANCED_FILTERS -> R.string.paywall_entry_advanced_filters
    PaywallEntry.REWIND -> R.string.paywall_entry_rewind
    PaywallEntry.OUT_OF_LIKES -> R.string.paywall_entry_out_of_likes
    PaywallEntry.OUT_OF_SUPERLIKES -> R.string.paywall_entry_out_of_superlikes
    PaywallEntry.BOOSTS -> R.string.paywall_entry_boosts
    PaywallEntry.MESSAGES -> R.string.paywall_entry_messages
    PaywallEntry.GENERAL -> R.string.paywall_entry_general
}

/**
 * What a plan includes, as the paywall lists it. The server sends no
 * per-plan feature list yet (`GET /v1/config` has the plans' names only), so
 * these are the product's default tiers, worded without numbers the panel
 * may change.
 */
fun benefits(plan: Plan): List<Int> = when (plan) {
    Plan.Premium -> listOf(
        R.string.paywall_benefit_unlimited_likes,
        R.string.paywall_benefit_priority,
        R.string.paywall_benefit_travel,
        R.string.paywall_benefit_more_boosts,
    )
    else -> listOf(
        R.string.paywall_benefit_see_likes,
        R.string.paywall_benefit_more_likes,
        R.string.paywall_benefit_more_superlikes,
        R.string.paywall_benefit_read_receipts,
        R.string.paywall_benefit_rewind,
        R.string.paywall_benefit_incognito,
        R.string.paywall_benefit_filters,
        R.string.paywall_benefit_boost,
    )
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
    PurchaseFailure.CHANGE_NOT_SUPPORTED -> R.string.paywall_fail_change
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
    RestoreNotice.OFFLINE -> R.string.paywall_restore_offline
    RestoreNotice.FAILED -> R.string.paywall_restore_failed
    RestoreNotice.STORE_UNAVAILABLE -> R.string.paywall_restore_store
}

@StringRes
fun WalletItem.packsTitle(): Int = when (this) {
    WalletItem.Boost -> R.string.packs_title_boost
    WalletItem.Spotlight -> R.string.packs_title_spotlight
    WalletItem.Dm -> R.string.packs_title_dm
    else -> R.string.packs_title_superlike
}

@StringRes
fun WalletItem.packsBody(): Int = when (this) {
    WalletItem.Boost -> R.string.packs_body_boost
    WalletItem.Spotlight -> R.string.packs_body_spotlight
    WalletItem.Dm -> R.string.packs_body_dm
    else -> R.string.packs_body_superlike
}

@PluralsRes
fun WalletItem.quantity(): Int = when (this) {
    WalletItem.Boost -> R.plurals.packs_quantity_boost
    WalletItem.Spotlight -> R.plurals.packs_quantity_spotlight
    WalletItem.Dm -> R.plurals.packs_quantity_dm
    else -> R.plurals.packs_quantity_superlike
}

/** The plan's display name from the config, else its key. */
@Composable
fun planName(plan: Plan, planNames: Map<String, String>): String =
    planNames[plan.wire]?.takeIf(String::isNotBlank) ?: plan.wire.replaceFirstChar { it.titlecase() }
