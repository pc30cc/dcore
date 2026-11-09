package app.core.feature.paywall

import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.billing.Catalogue
import app.core.billing.CatalogueJoin
import app.core.billing.CatalogueLoad
import app.core.billing.PurchaseFailure
import app.core.billing.PurchaseStep
import app.core.billing.PurchaseTarget
import app.core.billing.Purchases
import app.core.billing.RestoreOutcome
import app.core.billing.failure
import app.core.billing.storePlan
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.store.StorePurchase
import app.core.sync.EntitlementRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The catalogue's state in a paywall or a packs sheet. */
sealed interface StoreLoad {
    data object Loading : StoreLoad

    data class Ready(val catalogue: Catalogue) : StoreLoad

    /** The store cannot sell on this phone; [reason] says what the person can do about it. */
    data class Unavailable(val reason: PurchaseFailure) : StoreLoad

    data object Offline : StoreLoad

    data object Failed : StoreLoad
}

/** The restore button's last answer, shown once. */
enum class RestoreNotice {
    /** Something that gives access was added to the account by this restore. */
    RESTORED,

    /** What the store holds gives access, and the account had it already. */
    UP_TO_DATE,

    /**
     * [UP_TO_DATE] for the account's own purchases, and the store account
     * also holds another account's (a shared phone, or a second account).
     */
    UP_TO_DATE_WITH_OTHER_ACCOUNT,
    NOTHING,

    /** What the store holds was bought by another account of the app. */
    OTHER_ACCOUNT,

    /** Not confirmed yet (the store could not be asked, or the payment is pending): it is sent again. */
    NOT_CONFIRMED,

    /** The server knows it, but it gives nothing now (on hold, expired, refunded…). */
    NOT_ACTIVE,
    OFFLINE,
    FAILED,
    STORE_UNAVAILABLE,
}

/**
 * The one line a restore ends with, wherever its button is: something was
 * added to the account; else, in this order, purchases the account had
 * already beside another account's (both said), another account's purchase,
 * one not confirmed yet, purchases the account had already, one that gives
 * nothing now, or nothing. A server that does not say which tokens are new
 * ([RestoreOutcome.Done.addedKnown] false) leaves "restored" for anything
 * that gives access, as before.
 */
fun RestoreOutcome.notice(): RestoreNotice = when (this) {
    is RestoreOutcome.Done -> when {
        added.isNotEmpty() -> RestoreNotice.RESTORED
        granted.isNotEmpty() && !addedKnown -> RestoreNotice.RESTORED
        foreign > 0 && granted.isNotEmpty() -> RestoreNotice.UP_TO_DATE_WITH_OTHER_ACCOUNT
        foreign > 0 -> RestoreNotice.OTHER_ACCOUNT
        later > 0 -> RestoreNotice.NOT_CONFIRMED
        granted.isNotEmpty() -> RestoreNotice.UP_TO_DATE
        inactive > 0 -> RestoreNotice.NOT_ACTIVE
        else -> RestoreNotice.NOTHING
    }
    RestoreOutcome.NothingToRestore -> RestoreNotice.NOTHING
    RestoreOutcome.Offline -> RestoreNotice.OFFLINE
    RestoreOutcome.Failed -> RestoreNotice.FAILED
    is RestoreOutcome.StoreUnavailable -> RestoreNotice.STORE_UNAVAILABLE
}

data class StoreUiState(
    val load: StoreLoad = StoreLoad.Loading,
    /** The plan tab shown. */
    val plan: Plan = Plan.Plus,
    /** The chosen period ([app.core.billing.PlanOption.key]) of [plan]. */
    val selected: String? = null,
    val step: PurchaseStep = PurchaseStep.Idle,
    val restoring: Boolean = false,
    val restoreNotice: RestoreNotice? = null,
    val entitlements: Entitlements? = null,
    /** Purchases waiting for the server (paid in the store, not yet confirmed). */
    val waiting: Int = 0,
    /** A running plan from this store keeps another subscription from being sold (Cafe Bazaar). */
    val subscriptionLocked: Boolean = false,
    /** The key of the period the person is on ([Catalogue.current]): marked, and not sold again. */
    val current: String? = null,
    /**
     * The plan is held on another store account than the one on this phone
     * ([Purchases.heldElsewhere]): no subscription is sold, packs are.
     */
    val heldElsewhere: Boolean = false,
    /** The held-elsewhere note's "Check again" is reading the entitlements and the store's list. */
    val checking: Boolean = false,
) {
    val catalogue: Catalogue? get() = (load as? StoreLoad.Ready)?.catalogue

    /** A purchase is under way: the buttons wait. */
    val busy: Boolean
        get() = restoring || step is PurchaseStep.Connecting || step is PurchaseStep.InStore ||
            step is PurchaseStep.Verifying || step is PurchaseStep.Restoring

    /** The plans this catalogue sells, in order. */
    val plans: List<Plan> get() = catalogue?.plans?.map { it.plan }.orEmpty()
}

/**
 * The paywall's and the packs sheet's state: the catalogue (the server's,
 * with the store's prices), the chosen plan and period, the purchase in
 * progress and the restore button. Everything that buys is [Purchases].
 */
class StoreViewModel(
    private val purchases: Purchases,
    private val entitlementRepository: EntitlementRepository,
    val request: PaywallRequest,
) : ViewModel() {

    private data class Local(
        val load: StoreLoad = StoreLoad.Loading,
        val plan: Plan,
        val selected: String? = null,
        val restoring: Boolean = false,
        val restoreNotice: RestoreNotice? = null,
        /** The subscriptions the store account on this phone holds; null until asked, or when it could not be. */
        val owned: List<StorePurchase>? = null,
        /** "Check again" is reading. */
        val checking: Boolean = false,
    )

    private val local = MutableStateFlow(Local(plan = (request as? PaywallRequest.Plans)?.plan ?: request.entry.plan))

    val state: StateFlow<StoreUiState> = combine(local, purchases.step, entitlementRepository.entitlements, purchases.waiting) { l, step, e, waiting ->
        val catalogue = (l.load as? StoreLoad.Ready)?.catalogue
        StoreUiState(
            load = l.load,
            plan = l.plan,
            selected = l.selected,
            step = step,
            restoring = l.restoring,
            restoreNotice = l.restoreNotice,
            entitlements = e,
            waiting = waiting,
            subscriptionLocked = purchases.subscriptionLocked(e),
            current = catalogue?.current(e, purchases.now())?.key,
            heldElsewhere = catalogue != null && purchases.heldElsewhere(e, l.owned, catalogue.billingRef),
            checking = l.checking,
        )
    }.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        entitlementRepository.entitlements.value.let { e ->
            StoreUiState(plan = local.value.plan, entitlements = e, subscriptionLocked = purchases.subscriptionLocked(e))
        },
    )

    init {
        load()
        // The plan's product changed while the paywall is open (a purchase confirmed, a renewal on
        // another phone): the store account's subscriptions are asked again, so "held elsewhere"
        // never rests on a list from before the change.
        viewModelScope.launch {
            entitlementRepository.entitlements.map { it?.source to it?.productId }.distinctUntilChanged().drop(1).collect {
                if (sellsPlans(local.value.load)) refreshOwned()
            }
        }
    }

    /**
     * Reads the catalogue and the store account's subscriptions, and the
     * entitlements again: what the paywall marks and refuses must not rest
     * on a copy from before the plan ended (an event missed while the app was
     * away). Revalidated with its ETag, so usually a 304.
     */
    fun load() {
        local.update { it.copy(load = StoreLoad.Loading) }
        viewModelScope.launch {
            val current = entitlementRepository.refresh()
            val load = when (val r = purchases.catalogue()) {
                is CatalogueLoad.Ready -> StoreLoad.Ready(r.catalogue)
                is CatalogueLoad.StoreUnavailable -> StoreLoad.Unavailable(r.reason.failure())
                CatalogueLoad.Offline -> StoreLoad.Offline
                CatalogueLoad.Failed -> StoreLoad.Failed
            }
            // Only the plans need it ("held elsewhere"); a packs sheet sells packs whatever the store account holds.
            val owned = if (sellsPlans(load)) purchases.ownedSubscriptions() else null
            local.update { l ->
                val catalogue = (load as? StoreLoad.Ready)?.catalogue
                val plan = catalogue?.let { startPlan(it, l.plan, current) } ?: l.plan
                l.copy(load = load, plan = plan, selected = catalogue?.startOption(plan, current, purchases.now())?.key, owned = owned)
            }
        }
    }

    private fun sellsPlans(load: StoreLoad): Boolean =
        request is PaywallRequest.Plans && load is StoreLoad.Ready && load.catalogue.plans.isNotEmpty()

    private suspend fun refreshOwned() {
        val owned = purchases.ownedSubscriptions()
        local.update { it.copy(owned = owned) }
    }

    /**
     * The paywall is in front again (back from the store's page, another
     * app): the store's list is asked again while "held elsewhere" can be
     * said, since the store may have caught up with a purchase made on
     * another device meanwhile.
     */
    fun resumed() {
        if (!sellsPlans(local.value.load)) return
        val e = entitlementRepository.entitlements.value
        if (e?.storePlan(purchases.store) != true || e.productId == null) return
        viewModelScope.launch { refreshOwned() }
    }

    /** "Check again" on the held-elsewhere note: the entitlements and the store's list, both read anew. */
    fun checkAgain() {
        if (local.value.checking) return
        local.update { it.copy(checking = true) }
        viewModelScope.launch {
            try {
                entitlementRepository.refresh()
                if (sellsPlans(local.value.load)) refreshOwned()
            } finally {
                local.update { it.copy(checking = false) }
            }
        }
    }

    /**
     * The tab to open on: the one asked for when it is sold; a person on Plus
     * sees Premium (Plus is what they have); otherwise the first sold.
     */
    private fun startPlan(catalogue: Catalogue, asked: Plan, current: Entitlements?): Plan {
        val sold = catalogue.plans.map { it.plan }
        if (sold.isEmpty()) return asked
        if (current?.plan == Plan.Plus && asked == Plan.Plus && Plan.Premium in sold) return Plan.Premium
        return if (asked in sold) asked else sold.first()
    }

    fun selectPlan(plan: Plan) {
        val current = entitlementRepository.entitlements.value
        local.update { l -> l.copy(plan = plan, selected = (l.load as? StoreLoad.Ready)?.catalogue?.startOption(plan, current, purchases.now())?.key) }
    }

    fun select(key: String) {
        local.update { it.copy(selected = key) }
    }

    /** Buys the period or pack [key]: the store's sheet over [activity], then the server. */
    fun buy(activity: ComponentActivity, key: String) {
        val catalogue = state.value.catalogue ?: return
        if (state.value.busy) return
        val target = catalogue.option(key)?.let { PurchaseTarget.Subscription(it) }
            ?: catalogue.pack(key)?.let { PurchaseTarget.Pack(it) }
            ?: return
        viewModelScope.launch { purchases.buy(activity, catalogue, target) }
    }

    fun restore() {
        if (state.value.busy) return
        local.update { it.copy(restoring = true, restoreNotice = null) }
        viewModelScope.launch {
            val notice = purchases.restore(manual = true).notice()
            // The store was just asked for everything it holds: "held elsewhere" follows that list.
            if (sellsPlans(local.value.load)) refreshOwned()
            local.update { it.copy(restoring = false, restoreNotice = notice) }
        }
    }

    fun restoreShown() = local.update { it.copy(restoreNotice = null) }

    /** A finished step was shown and dismissed. */
    fun stepShown() = purchases.acknowledge()

    /** The current plan's product, for the store's subscription page (Play names it): the server's, else the catalogue's. */
    fun currentProductId(): String? {
        val e = state.value.entitlements
        val plan = e?.plan?.takeIf { it in CatalogueJoin.PLANS } ?: return null
        return e.productId ?: state.value.catalogue?.plan(plan)?.options?.firstOrNull()?.productId
    }

    override fun onCleared() {
        purchases.acknowledge()
    }
}
