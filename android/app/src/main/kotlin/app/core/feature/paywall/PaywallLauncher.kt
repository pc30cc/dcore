package app.core.feature.paywall

import androidx.compose.runtime.staticCompositionLocalOf
import app.core.billing.PlanNeed
import app.core.model.WalletItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Where the paywall was opened from: what its title says, and what the plan
 * it opens on should give ([need], matched against the server's plans).
 */
enum class PaywallEntry(val need: PlanNeed?) {
    SEE_LIKES(PlanNeed.SEE_LIKES),
    READ_RECEIPTS(PlanNeed.READ_RECEIPTS),
    INCOGNITO(PlanNeed.INCOGNITO),
    ADVANCED_FILTERS(PlanNeed.ADVANCED_FILTERS),
    REWIND(PlanNeed.REWIND),
    OUT_OF_LIKES(PlanNeed.MORE_LIKES),
    OUT_OF_SUPERLIKES(PlanNeed.MORE_SUPERLIKES),
    BOOSTS(PlanNeed.BOOSTS),
    MESSAGES(PlanNeed.MESSAGES),
    /** The profile tab's "plans" row, the restricted screen: no feature in particular. */
    GENERAL(null),
}

sealed interface PaywallRequest {
    val entry: PaywallEntry

    /**
     * The plans (subscriptions). [plan]: the key of the plan to show first,
     * else one that gives the entry's need. [likes]: how many people like the
     * person, when the likes list knows it (the title says it).
     */
    data class Plans(override val entry: PaywallEntry, val plan: String? = null, val likes: Int? = null) : PaywallRequest

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
