package app.core.feature.paywall

import androidx.compose.runtime.staticCompositionLocalOf
import app.core.model.Plan
import app.core.model.WalletItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where the paywall was opened from: what its first line says, and which plan it starts on. */
enum class PaywallEntry(val plan: Plan = Plan.Plus) {
    SEE_LIKES,
    READ_RECEIPTS,
    INCOGNITO,
    ADVANCED_FILTERS,
    REWIND,
    OUT_OF_LIKES,
    OUT_OF_SUPERLIKES,
    BOOSTS,
    MESSAGES,
    /** The profile tab's "plans" row, the restricted screen: no feature in particular. */
    GENERAL,
}

sealed interface PaywallRequest {
    val entry: PaywallEntry

    /** The plans (subscriptions). [plan]: the tier to show first, else the entry's. */
    data class Plans(override val entry: PaywallEntry, val plan: Plan? = null) : PaywallRequest

    /** The packs of one consumable. */
    data class Packs(val item: WalletItem, override val entry: PaywallEntry) : PaywallRequest
}

/** Opens the paywall or a packs sheet from any screen ([LocalPaywall]). */
fun interface PaywallLauncher {
    fun open(request: PaywallRequest)

    fun plans(entry: PaywallEntry) = open(PaywallRequest.Plans(entry))

    fun packs(item: WalletItem, entry: PaywallEntry) = open(PaywallRequest.Packs(item, entry))

    companion object {
        /** Nothing opens: screens drawn without the app around them (tests, previews). */
        val None = PaywallLauncher { }
    }
}

/** The one paywall of the app: what is open, if anything. [PaywallHost] draws it. */
class PaywallController : PaywallLauncher {
    private val _request = MutableStateFlow<PaywallRequest?>(null)
    val request: StateFlow<PaywallRequest?> = _request.asStateFlow()

    override fun open(request: PaywallRequest) {
        _request.value = request
    }

    fun close() {
        _request.value = null
    }
}

val LocalPaywall = staticCompositionLocalOf { PaywallLauncher.None }
