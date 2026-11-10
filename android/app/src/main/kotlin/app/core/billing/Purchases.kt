package app.core.billing

import androidx.activity.ComponentActivity
import app.core.common.Clock
import app.core.common.Diag
import app.core.model.BoostKind
import app.core.model.Entitlements
import app.core.model.PlanKey
import app.core.model.ProblemCodes
import app.core.model.PurchaseKind
import app.core.model.PurchaseResult
import app.core.model.RestorePurchase
import app.core.model.StoreProducts
import app.core.net.ApiError
import app.core.store.BillingAvailability
import app.core.store.BillingResult
import app.core.store.BillingUnavailableReason
import app.core.store.ConsumeOutcome
import app.core.store.PlanChange
import app.core.store.ProductType
import app.core.store.PurchaseOutcome
import app.core.store.Store
import app.core.store.StoreBilling
import app.core.store.StoreProduct
import app.core.store.StorePurchase
import app.core.store.StorePurchaseState
import app.core.sync.EntitlementRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

/** What can be bought: a period of a plan, or a pack. */
sealed interface PurchaseTarget {
    val key: String
    val product: StoreProduct
    val kind: PurchaseKind

    data class Subscription(val option: PlanOption) : PurchaseTarget {
        override val key: String get() = option.key
        override val product: StoreProduct get() = option.product
        override val kind: PurchaseKind get() = PurchaseKind.Subscription
    }

    data class Pack(val pack: PackOption) : PurchaseTarget {
        override val key: String get() = pack.key
        override val product: StoreProduct get() = pack.product
        override val kind: PurchaseKind get() = PurchaseKind.Consumable
    }
}

/**
 * Where one purchase is, from the tap to the server's answer. [target] is
 * the [PurchaseTarget.key] it is about. Nothing is granted on the phone: a
 * [Done] means the server verified the purchase with the store and the
 * entitlements it sent are already shown.
 */
sealed interface PurchaseStep {
    val target: String?

    data object Idle : PurchaseStep {
        override val target: String? = null
    }

    /** Asking the store whether it can sell (its app, its service). */
    data class Connecting(override val target: String) : PurchaseStep

    /** The store's own purchase sheet is open. */
    data class InStore(override val target: String) : PurchaseStep

    /** The store took the payment; the server is checking it with the store. */
    data class Verifying(override val target: String) : PurchaseStep

    /** The store holds the payment (cash, a slow method): nothing is granted until it completes. */
    data class Pending(override val target: String) : PurchaseStep

    data class Done(override val target: String, val kind: PurchaseKind) : PurchaseStep

    /**
     * The store took the payment but the server could not be reached (no
     * network, the store's check unavailable): it is kept on the phone and
     * sent again until the server answers. Nothing more to pay.
     */
    data class Queued(override val target: String) : PurchaseStep

    /** The store says it is owned already: restoring it. */
    data class Restoring(override val target: String) : PurchaseStep

    data class Failed(override val target: String, val reason: PurchaseFailure) : PurchaseStep
}

enum class PurchaseFailure {
    /** The store app is not on this phone (common for Cafe Bazaar). */
    STORE_MISSING,

    /** The store app is too old, or nobody is signed in to it. */
    STORE_NOT_READY,

    /** This device, country or account cannot buy here. */
    NOT_SUPPORTED,

    /** The store's service could not be reached; worth another try. */
    STORE_UNREACHABLE,

    STORE_ERROR,

    /** The server could not confirm the purchase with the store (`purchase_invalid`). */
    INVALID,

    /** The purchase belongs to another account of this app (`purchase_other_account`). */
    OTHER_ACCOUNT,

    /** The store said "already owned" and a restore did not bring it back. */
    NOT_RESTORED,

    /**
     * The store said "already owned" for a pack the server credited before:
     * the store has not used it up yet (Play's consume is the server's, and it
     * can lag), so it cannot be bought again for a moment. Nothing was charged.
     */
    STILL_COMPLETING,

    /** The server knows the purchase but it gives nothing now (on hold, paused, expired, refunded, replaced). */
    NOT_ACTIVE,

    /** Cafe Bazaar: another subscription while one runs (the store does not replace one). */
    CHANGE_NOT_SUPPORTED,

    /** The period the person is on already, or a plan the server gave before and still gives. */
    ALREADY_CURRENT,

    /**
     * The plan is held on another store account than the one on this phone
     * ([PlanChanges.heldElsewhere]): no second subscription is sold here.
     */
    MANAGED_ELSEWHERE,

    /** No account is signed in to buy for. */
    SIGNED_OUT,
}

sealed interface CatalogueLoad {
    data class Ready(val catalogue: Catalogue) : CatalogueLoad

    /** The store cannot sell here; [reason] says what the person can do. */
    data class StoreUnavailable(val reason: BillingUnavailableReason) : CatalogueLoad

    /** The server's catalogue could not be read: no network. */
    data object Offline : CatalogueLoad

    data object Failed : CatalogueLoad
}

sealed interface RestoreOutcome {
    /**
     * [granted]: product ids of purchases the server holds as giving access
     * (active, cancelled but running, in grace, a credited pack); [foreign]:
     * another account's; [invalid]: not confirmed by the store; [later]: not
     * confirmed yet (the store could not be asked, or the payment is still
     * pending); [inactive]: known but giving nothing (on hold, paused,
     * expired, refunded, replaced).
     *
     * [added]: product ids this restore gave the account for the first time:
     * a token the server answered `fresh` for, or a queued purchase its send
     * got granted. [addedKnown]: the server said `fresh` for every token it
     * answered; when it did not (an older server), [added] holds only the
     * phone's guess for those (no settled answer before, granting now).
     */
    data class Done(
        val granted: Set<String>,
        val foreign: Int,
        val invalid: Int,
        val later: Int,
        val inactive: Int = 0,
        val added: Set<String> = emptySet(),
        val addedKnown: Boolean = false,
    ) : RestoreOutcome

    /** The store reports nothing the server does not know. */
    data object NothingToRestore : RestoreOutcome

    data class StoreUnavailable(val reason: BillingUnavailableReason) : RestoreOutcome

    data object Offline : RestoreOutcome

    data object Failed : RestoreOutcome
}

sealed interface BoostOutcome {
    data class Started(val endsAt: Instant) : BoostOutcome

    /** Nothing left to boost with; [canBuy]: packs are sold. */
    data class NoneLeft(val canBuy: Boolean) : BoostOutcome

    data object Offline : BoostOutcome

    data object Failed : BoostOutcome
}

/** The server's answer to one purchase sent to it. */
internal sealed interface Submission {
    /** Verified, and its state gives access ([Purchases.GRANTING]). */
    data class Granted(val result: PurchaseResult) : Submission

    /** Verified, but its state gives nothing (on hold, expired, refunded, replaced…). */
    data class Inactive(val result: PurchaseResult) : Submission

    data object Pending : Submission

    /** No answer, or "ask again later" (429, 5xx, `store_unavailable`): kept and sent again. */
    data object Later : Submission

    data object OtherAccount : Submission

    data object Invalid : Submission

    /** The session ended: kept for when that account signs in again. */
    data object SignedOut : Submission

    /** Nothing left to send: another path settled it first. */
    data object Settled : Submission

    companion object {
        fun of(error: Throwable): Submission = when (error) {
            is ApiError.Network, is ApiError.Decoding -> Later
            is ApiError.Unauthorized -> SignedOut
            is ApiError.Http -> when {
                error.code == ProblemCodes.PURCHASE_OTHER_ACCOUNT || error.status == 409 -> OtherAccount
                // Only a verdict on the purchase itself (or a request it can never pass) drops it.
                error.code == ProblemCodes.PURCHASE_INVALID || error.status == 422 || error.status == 400 -> Invalid
                // Everything else (408, 426, 429, 5xx, an account state, a route not there yet) keeps it.
                else -> Later
            }
            else -> Later
        }
    }
}

/**
 * Store purchases, from the paywall's tap to the server's verdict, and every
 * way of making sure none is lost.
 *
 * - **Catalogue:** the server's products for this store joined with the
 *   store's own details and prices ([catalogue], [CatalogueJoin]).
 * - **Purchase:** the store's sheet with the server's `billingRef`, then
 *   the server (`POST /v1/store/{store}/purchases`), then the entitlements it
 *   answered; a Cafe Bazaar pack is consumed in Bazaar only after the server
 *   credited it ([buy], [step]).
 * - **Never lost:** a purchase is written to the [PurchaseOutbox] before it
 *   is sent. Without an answer it stays there and is sent again: when the
 *   network comes back, when the app returns to the front, from a background
 *   job with a network constraint, at the next launch ([flush]). The server
 *   records each token once, so a resend never grants twice.
 * - **Restore:** what the store says this account owns, at launch only for
 *   tokens the server has not settled (usually none, so no request), and in
 *   full from the paywall's button ([restore]).
 * - **Boosts** ([boost]).
 *
 * A restore never takes anything away: the store's lists can come back empty
 * (Poolakey #75) and only the server decides.
 */
class Purchases(
    private val billing: StoreBilling,
    private val api: StoreApi,
    private val outbox: PurchaseOutbox,
    private val known: KnownPurchases,
    private val entitlements: EntitlementRepository,
    /** The signed-in account's id, or null. */
    private val account: suspend () -> String?,
    private val scope: CoroutineScope,
    private val clock: Clock,
    private val diag: Diag = Diag.Silent,
    /** Schedules a background send with a network constraint (WorkManager in the app). */
    private val retryInBackground: () -> Unit = {},
) {
    val store: Store get() = billing.store

    /**
     * Whether [current], a plan from this store, keeps another subscription
     * from being sold: Cafe Bazaar has no replacement (see [planChange]).
     */
    fun subscriptionLocked(current: Entitlements?): Boolean =
        billing.store == Store.BAZAAR && current?.storePlan(billing.store) == true

    private val _step = MutableStateFlow<PurchaseStep>(PurchaseStep.Idle)
    val step: StateFlow<PurchaseStep> = _step.asStateFlow()

    private val _waiting = MutableStateFlow(0)

    /** Purchases the store took that the server has not answered for yet (this account's). */
    val waiting: StateFlow<Int> = _waiting.asStateFlow()

    private val back = Channel<Unit>(Channel.CONFLATED)

    /**
     * A plan from this store the app had not shown came back from a re-sync
     * ([resyncSubscriptions]): the one moment such a re-sync says anything.
     * Received once.
     */
    val subscriptionBack: Flow<Unit> = back.receiveAsFlow()

    private val buyLock = Mutex()
    private val sendLock = Mutex()
    private val restoreLock = Mutex()

    /** The token of the purchase [step] is about, so a later answer for it (a resend, a store update) finishes it. */
    @Volatile private var stepToken: String? = null

    @Volatile private var lastServerCatalogue: StoreProducts? = null
    private var retryJob: Job? = null
    private var started = false
    @Volatile private var lastQuietRestoreAt: Long? = null
    @Volatile private var quietRestoreAccount: String? = null

    // MARK: - Catalogue

    /**
     * The server's products for this store, priced by the store. The server's
     * list comes first: when it sells nothing here (no product, or the store
     * not set up on the server) the catalogue is empty and the store is not
     * asked at all, so a phone without the store app reads "nothing on sale",
     * not "install the store". Otherwise a store that cannot sell is said
     * before any price is asked for.
     */
    suspend fun catalogue(): CatalogueLoad {
        val server = try {
            api.products()
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError.Network) {
            return CatalogueLoad.Offline
        } catch (e: ApiError) {
            diag.warn(AREA, "catalogue not read (${e.code ?: e.javaClass.simpleName})")
            return CatalogueLoad.Failed
        }
        lastServerCatalogue = server
        val query = CatalogueJoin.query(server)
        if (query.subscriptions.isEmpty() && query.consumables.isEmpty()) {
            return CatalogueLoad.Ready(CatalogueJoin.join(billing.store, server, emptyList(), emptyList()))
        }
        when (val availability = billing.connect()) {
            BillingAvailability.Ready -> Unit
            is BillingAvailability.Unavailable -> return CatalogueLoad.StoreUnavailable(availability.reason)
        }
        val subscriptions = when (val r = billing.products(ProductType.SUBSCRIPTION, query.subscriptions)) {
            is BillingResult.Ok -> r.value
            is BillingResult.Failed -> return CatalogueLoad.StoreUnavailable(r.reason)
        }
        val packs = when (val r = billing.products(ProductType.ONE_TIME, query.consumables)) {
            is BillingResult.Ok -> r.value
            is BillingResult.Failed -> return CatalogueLoad.StoreUnavailable(r.reason)
        }
        val catalogue = CatalogueJoin.join(billing.store, server, subscriptions, packs) { diag.warn(AREA, "hidden: $it") }
        val hidden = server.subscriptions.size + server.consumables.size - catalogue.plans.sumOf { it.options.size } - catalogue.packs.size
        if (hidden > 0) diag.info(AREA, "$hidden catalogue entries not sold by the store here")
        return CatalogueLoad.Ready(catalogue)
    }

    // MARK: - Purchase

    /** Which [buy] the step is about, and the one whose outcome the person dismissed. */
    @Volatile private var attempt = 0L
    @Volatile private var dismissed = -1L

    /**
     * The step is shown; the paywall puts it back to idle. A purchase still
     * being answered (the store's pending shown while the server is asked)
     * does not bring its step back when its answer comes: the answer still
     * lands (entitlements, the queue), only the screen stays as dismissed.
     */
    fun acknowledge() {
        val step = _step.value
        if (step !is PurchaseStep.InStore && step !is PurchaseStep.Verifying && step !is PurchaseStep.Connecting && step !is PurchaseStep.Restoring) {
            _step.value = PurchaseStep.Idle
            stepToken = null
            dismissed = attempt
        }
    }

    /**
     * Buys [target] with [catalogue]'s `billingRef`, one purchase at a time,
     * and returns where it ended (also in [step]).
     */
    suspend fun buy(activity: ComponentActivity, catalogue: Catalogue, target: PurchaseTarget): PurchaseStep = buyLock.withLock {
        val key = target.key
        attempt++
        stepToken = null
        val me = account() ?: return@withLock finish(PurchaseStep.Failed(key, PurchaseFailure.SIGNED_OUT))
        _step.value = PurchaseStep.Connecting(key)
        when (val availability = billing.connect()) {
            BillingAvailability.Ready -> Unit
            is BillingAvailability.Unavailable -> return@withLock finish(PurchaseStep.Failed(key, availability.reason.failure()))
        }
        val change = (target as? PurchaseTarget.Subscription)?.let { planChange(catalogue, it.option) }
        if (change is ChangeDecision.Blocked) return@withLock finish(PurchaseStep.Failed(key, change.reason))

        _step.value = PurchaseStep.InStore(key)
        val outcome = try {
            billing.purchase(activity, target.product, catalogue.billingRef, (change as? ChangeDecision.Allowed)?.change)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            diag.warn(AREA, "purchase sheet failed: ${e.javaClass.simpleName}")
            PurchaseOutcome.Failed(BillingUnavailableReason.ERROR, e.javaClass.simpleName)
        }
        when (outcome) {
            PurchaseOutcome.Cancelled -> finish(PurchaseStep.Idle)
            is PurchaseOutcome.Failed -> finish(PurchaseStep.Failed(key, outcome.reason.failure()))
            is PurchaseOutcome.AlreadyOwned -> {
                _step.value = PurchaseStep.Restoring(key)
                // What the server had said of each token the store holds for it, before the restore.
                val before = ownedStates(target)
                val restored = restore(manual = true)
                finish(alreadyOwned(key, target, before, restored))
            }
            is PurchaseOutcome.Purchased -> settle(me, key, target, outcome.purchase)
            is PurchaseOutcome.Pending -> settle(me, key, target, outcome.purchase)
        }
    }

    private suspend fun settle(me: String, key: String, target: PurchaseTarget, purchase: StorePurchase): PurchaseStep {
        val productId = purchase.productIds.firstOrNull() ?: target.product.id
        // Written down before anything is sent: from here on it cannot be lost.
        val entry = outbox.add(QueuedPurchase.of(me, purchase, productId, target.kind, clock.nowMillis()))
        stepToken = entry.token
        _step.value = if (entry.pending) PurchaseStep.Pending(key) else PurchaseStep.Verifying(key)
        return finish(
            when (send(entry)) {
                is Submission.Granted -> PurchaseStep.Done(key, target.kind)
                is Submission.Inactive -> PurchaseStep.Failed(key, PurchaseFailure.NOT_ACTIVE)
                // Settled by another path in between (a resend, the store's update): its record says how.
                Submission.Settled -> when (val state = known.state(entry.token)) {
                    null, KnownPurchases.UNAVAILABLE -> PurchaseStep.Queued(key)
                    KnownPurchases.PENDING -> PurchaseStep.Pending(key)
                    OTHER_ACCOUNT -> PurchaseStep.Failed(key, PurchaseFailure.OTHER_ACCOUNT)
                    INVALID -> PurchaseStep.Failed(key, PurchaseFailure.INVALID)
                    else -> if (state in GRANTING) PurchaseStep.Done(key, target.kind) else PurchaseStep.Failed(key, PurchaseFailure.NOT_ACTIVE)
                }
                Submission.Pending -> PurchaseStep.Pending(key)
                Submission.Later, Submission.SignedOut -> PurchaseStep.Queued(key)
                Submission.OtherAccount -> PurchaseStep.Failed(key, PurchaseFailure.OTHER_ACCOUNT)
                Submission.Invalid -> PurchaseStep.Failed(key, PurchaseFailure.INVALID)
            },
        )
    }

    private fun finish(step: PurchaseStep): PurchaseStep {
        if (dismissed == attempt) return step
        _step.value = step
        if (step !is PurchaseStep.Pending && step !is PurchaseStep.Queued) stepToken = null
        return step
    }

    private sealed interface ChangeDecision {
        data class Allowed(val change: PlanChange?) : ChangeDecision

        data class Blocked(val reason: PurchaseFailure) : ChangeDecision
    }

    /**
     * A subscription bought while this store's own one runs. The period the
     * person is on is not sold again ([Catalogue.current]), and nothing is
     * sold while the plan is held on another store account
     * ([PlanChanges.heldElsewhere]). Play replaces the one behind this
     * account's plan, and only that one: bought with this account's
     * `billingRef`, of the plan's product ([PlanChanges.backing]); the mode
     * follows [PlanChanges.kind], with the base plan the person is on as the
     * bar when the server names it. When the store account holds no such
     * subscription (another account's, or one without a reference), nothing
     * is replaced. Cafe Bazaar has no replacement: a second one is not sold
     * until the first ends.
     *
     * A refusal is never decided on the copy of the plan last known alone: it
     * can be from before the plan ended (an event missed while the app was
     * away), and the store's list can lag behind a purchase made elsewhere.
     * Before refusing, the entitlements are read again and the store asked
     * again, and that answer decides.
     */
    private suspend fun planChange(catalogue: Catalogue, option: PlanOption): ChangeDecision {
        val first = decideChange(catalogue, option, entitlements.ensure())
        if (first !is ChangeDecision.Blocked) return first
        return decideChange(catalogue, option, entitlements.refresh())
    }

    private suspend fun decideChange(catalogue: Catalogue, option: PlanOption, current: Entitlements?): ChangeDecision {
        if (current == null || !current.storePlan(billing.store)) return ChangeDecision.Allowed(null)
        val now = clock.now()
        if (catalogue.current(current, now)?.key == option.key) return ChangeDecision.Blocked(PurchaseFailure.ALREADY_CURRENT)
        val owned = (billing.ownedPurchases(ProductType.SUBSCRIPTION) as? BillingResult.Ok)?.value
        if (PlanChanges.heldElsewhere(billing.store, current, owned, catalogue.billingRef, now)) {
            return ChangeDecision.Blocked(PurchaseFailure.MANAGED_ELSEWHERE)
        }
        if (billing.store == Store.BAZAAR) return ChangeDecision.Blocked(PurchaseFailure.CHANGE_NOT_SUPPORTED)
        val server = lastServerCatalogue
        val backing = PlanChanges.backing(
            owned = owned.orEmpty(),
            plan = current.plan,
            billingRef = catalogue.billingRef,
            productId = current.productId,
            planOf = { productId ->
                server?.subscriptions?.firstOrNull { it.productId == productId }?.plan
                    ?: catalogue.plans.firstOrNull { group -> group.options.any { it.productId == productId } }?.plan
            },
        ) ?: return ChangeDecision.Allowed(null).also {
            if (!owned.isNullOrEmpty()) diag.info(AREA, "no owned subscription of this account's plan: nothing replaced")
        }
        val ownedProduct = backing.productIds.first()
        val ownedOptions = catalogue.plans.flatMap { it.options }.filter { it.productId == ownedProduct }
        val bar = PlanChanges.bar(ownedOptions, current.basePlanId?.takeIf { current.productId == ownedProduct })
        return ChangeDecision.Allowed(PlanChange(backing.purchaseToken, PlanChanges.kind(current.plan, ownedProduct, bar, option, catalogue::rank)))
    }

    /** The subscriptions the store account on this phone holds, as the store lists them; null when it cannot be asked. */
    suspend fun ownedSubscriptions(): List<StorePurchase>? = when (billing.connect()) {
        BillingAvailability.Ready -> (billing.ownedPurchases(ProductType.SUBSCRIPTION) as? BillingResult.Ok)?.value
        is BillingAvailability.Unavailable -> null
    }

    /** [PlanChanges.heldElsewhere] for this store, now. */
    fun heldElsewhere(current: Entitlements?, owned: List<StorePurchase>?, billingRef: String): Boolean =
        PlanChanges.heldElsewhere(billing.store, current, owned, billingRef, clock.now())

    /** The time the plan's own end is compared with ([runningStorePlan]). */
    fun now(): Instant = clock.now()

    /** The tokens the store holds for [target]'s product, with the state the server last gave each (null: none yet). */
    private suspend fun ownedStates(target: PurchaseTarget): Map<String, String?> {
        val type = if (target is PurchaseTarget.Pack) ProductType.ONE_TIME else ProductType.SUBSCRIPTION
        return (billing.ownedPurchases(type) as? BillingResult.Ok)?.value.orEmpty()
            .filter { target.product.id in it.productIds }
            .associate { it.purchaseToken to known.state(it.purchaseToken) }
    }

    /**
     * Where "already owned" ends after the restore: done ("added") only when
     * the restore gave the product to the account for the first time
     * ([RestoreOutcome.Done.added]: the server's `fresh`, else the phone's
     * guess). A plan the server gave before and still gives is the person's
     * already, said as such; with a server that does not say `fresh`, a plan
     * it now gives is done, as before. A pack the server credited earlier is
     * one the store has not used up yet, and saying "added" would be false.
     */
    private suspend fun alreadyOwned(key: String, target: PurchaseTarget, before: Map<String, String?>, restored: RestoreOutcome): PurchaseStep {
        val after = before.keys.associateWith { known.state(it) }
        val foreign = after.values.any { it == OTHER_ACCOUNT }
        val done = restored as? RestoreOutcome.Done
        val added = done?.added.orEmpty().contains(target.product.id)
        return when (target) {
            is PurchaseTarget.Subscription -> {
                val given = entitlements.entitlements.value?.plan == target.option.plan
                when {
                    added -> PurchaseStep.Done(key, target.kind)
                    given && done?.addedKnown != true -> PurchaseStep.Done(key, target.kind)
                    given -> PurchaseStep.Failed(key, PurchaseFailure.ALREADY_CURRENT)
                    foreign -> PurchaseStep.Failed(key, PurchaseFailure.OTHER_ACCOUNT)
                    else -> PurchaseStep.Failed(key, PurchaseFailure.NOT_RESTORED)
                }
            }
            is PurchaseTarget.Pack -> when {
                added -> PurchaseStep.Done(key, target.kind)
                after.values.any { it in CREDITED } -> PurchaseStep.Failed(key, PurchaseFailure.STILL_COMPLETING)
                foreign -> PurchaseStep.Failed(key, PurchaseFailure.OTHER_ACCOUNT)
                else -> PurchaseStep.Failed(key, PurchaseFailure.NOT_RESTORED)
            }
        }
    }

    /** No verdict from the server yet, or only "pending" / "ask later". */
    private fun unsettled(state: String?): Boolean = state == null || state == KnownPurchases.PENDING || state == KnownPurchases.UNAVAILABLE

    // MARK: - Sending and the outbox

    /** Sends [entry] once, under the send lock, and settles the outbox by the answer. */
    private suspend fun send(entry: QueuedPurchase): Submission = sendLock.withLock {
        val current = outbox.all().firstOrNull { it.token == entry.token && it.stage == OutboxStage.VERIFY }
            ?: return@withLock Submission.Settled
        val answer = try {
            val result = api.submit(current)
            when {
                result.purchase.pending -> Submission.Pending
                result.purchase.state in GRANTING -> Submission.Granted(result)
                else -> Submission.Inactive(result)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            Submission.of(e).also { diag.info(AREA, "purchase ${current.hash.take(8)} not settled: ${(e as? ApiError)?.code ?: e.javaClass.simpleName}") }
        }
        when (answer) {
            is Submission.Granted -> {
                answer.result.entitlements?.let(entitlements::apply)
                known.put(current.token, answer.result.purchase.state)
                if (current.kind == PurchaseKind.Consumable) {
                    val consuming = current.copy(stage = OutboxStage.CONSUME, attempts = 0, nextAt = 0)
                    outbox.update(consuming)
                    consume(consuming)
                } else {
                    outbox.remove(current.token)
                }
                completeStep(current.token, current.kind)
            }
            is Submission.Inactive -> {
                // The server's verdict all the same: what it gives is shown, nothing is consumed or retried.
                answer.result.entitlements?.let(entitlements::apply)
                known.put(current.token, answer.result.purchase.state)
                outbox.remove(current.token)
                failStep(current.token, PurchaseFailure.NOT_ACTIVE)
            }
            Submission.Pending -> {
                known.put(current.token, KnownPurchases.PENDING)
                outbox.remove(current.token)
            }
            Submission.Later -> {
                val next = current.copy(attempts = current.attempts + 1, nextAt = clock.nowMillis() + backoff(current.attempts))
                outbox.update(next)
                scheduleRetry(next.nextAt)
            }
            Submission.OtherAccount -> {
                known.put(current.token, OTHER_ACCOUNT)
                outbox.remove(current.token)
                failStep(current.token, PurchaseFailure.OTHER_ACCOUNT)
            }
            Submission.Invalid -> {
                known.put(current.token, INVALID)
                outbox.remove(current.token)
                failStep(current.token, PurchaseFailure.INVALID)
            }
            Submission.SignedOut, Submission.Settled -> Unit
        }
        countWaiting()
        answer
    }

    /** A pack the server credited, used up in the store (Cafe Bazaar). Play's are consumed by the server. */
    private suspend fun consume(entry: QueuedPurchase) {
        val purchase = StorePurchase(
            store = billing.store,
            productIds = listOf(entry.productId),
            purchaseToken = entry.token,
            orderId = null,
            purchaseTimeMillis = entry.queuedAt,
            state = StorePurchaseState.PURCHASED,
            acknowledged = null,
            originalJson = entry.originalJson,
            signature = entry.signature,
        )
        val outcome = try {
            billing.consume(purchase)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ConsumeOutcome.Failed(e.javaClass.simpleName)
        }
        when (outcome) {
            ConsumeOutcome.Consumed, ConsumeOutcome.HandledByServer -> outbox.remove(entry.token)
            is ConsumeOutcome.Failed -> {
                if (entry.attempts + 1 >= MAX_CONSUME_ATTEMPTS) {
                    // Credited already; the next restore finds it again if the store still holds it.
                    diag.warn(AREA, "pack ${entry.hash.take(8)} not consumed after ${entry.attempts + 1} tries; left to the next restore")
                    outbox.remove(entry.token)
                } else {
                    val next = entry.copy(attempts = entry.attempts + 1, nextAt = clock.nowMillis() + backoff(entry.attempts))
                    outbox.update(next)
                    scheduleRetry(next.nextAt)
                }
            }
        }
    }

    /**
     * Sends everything this account has waiting whose time has come, and
     * consumes the packs left to consume. Returns how many still wait.
     */
    suspend fun flush(): Int {
        val me = account() ?: return 0
        val now = clock.nowMillis()
        for (entry in outbox.all()) {
            if (now - entry.queuedAt > KEEP_MS) {
                diag.warn(AREA, "purchase ${entry.hash.take(8)} dropped from the queue after 30 days")
                outbox.remove(entry.token)
                continue
            }
            if (entry.account != me || entry.nextAt > now) continue
            when (entry.stage) {
                OutboxStage.VERIFY -> send(entry)
                OutboxStage.CONSUME -> consume(entry)
            }
        }
        return countWaiting()
    }

    /** Sends at once whatever waits, whatever its backoff (the network came back, a background job ran). */
    suspend fun flushNow(): Int {
        for (entry in outbox.all()) if (entry.nextAt > 0) outbox.update(entry.copy(nextAt = 0))
        return flush()
    }

    private suspend fun countWaiting(): Int {
        val me = account()
        val count = outbox.all().count { it.account == me && it.stage == OutboxStage.VERIFY }
        _waiting.value = count
        return count
    }

    private fun scheduleRetry(at: Long) {
        retryInBackground()
        retryJob?.cancel()
        retryJob = scope.launch {
            delay((at - clock.nowMillis()).coerceAtLeast(0))
            flush()
        }
    }

    private fun completeStep(token: String, kind: PurchaseKind) {
        if (stepToken != token) return
        val target = _step.value.target ?: return
        _step.value = PurchaseStep.Done(target, kind)
        stepToken = null
    }

    private fun failStep(token: String, reason: PurchaseFailure) {
        if (stepToken != token) return
        val target = _step.value.target ?: return
        _step.value = PurchaseStep.Failed(target, reason)
        stepToken = null
    }

    /** A purchase the store reported outside a flow (Play: a pending one completing, one made in the Play Store). */
    suspend fun onStorePurchase(purchase: StorePurchase) {
        if (purchase.state != StorePurchaseState.PURCHASED && purchase.state != StorePurchaseState.PENDING) return
        val me = account() ?: return
        val productId = purchase.productIds.firstOrNull() ?: return
        if (!known.needsSending(purchase.purchaseToken, purchase.state)) return
        val entry = outbox.add(QueuedPurchase.of(me, purchase, productId, kindOf(productId), clock.nowMillis()))
        send(entry)
    }

    // MARK: - Restore

    /**
     * What the store says this account owns, sent to the server. [manual]
     * (the paywall's button) sends every owned token, so whatever the server
     * holds is shown again; otherwise only tokens the server has not settled,
     * at most 20 (usually none, and then no request at all).
     */
    suspend fun restore(manual: Boolean): RestoreOutcome = restore(if (manual) RestoreMode.MANUAL else RestoreMode.QUIET)

    /**
     * The store says a subscription's status moved ([StoreBilling.subscriptionStatusChanges]):
     * every owned subscription token goes to the server again, the ones it
     * knows included, so it asks the store anew for one it holds as on hold,
     * paused or expired (the server does that at most once per token every
     * 15 minutes). Packs are not sent. Nothing is said unless the answer
     * shows a plan from this store that the app was showing without one
     * ([subscriptionBack]).
     */
    suspend fun resyncSubscriptions(): RestoreOutcome {
        val shown = entitlements.entitlements.value
        val outcome = restore(RestoreMode.SUBSCRIPTIONS)
        val now = entitlements.entitlements.value
        val newlyGiven = outcome is RestoreOutcome.Done && outcome.granted.isNotEmpty() &&
            shown != null && !shown.storePlan(store) && now?.storePlan(store) == true
        if (newlyGiven) back.trySend(Unit)
        return outcome
    }

    /** Which owned purchases a restore sends, and how many batches of [MAX_RESTORE]. */
    private enum class RestoreMode(val resendKnown: Boolean, val packs: Boolean, val batches: Int) {
        /** At launch and on resume: only what the server has not settled. */
        QUIET(resendKnown = false, packs = true, batches = 1),

        /** The Restore button: everything owned. */
        MANUAL(resendKnown = true, packs = true, batches = MAX_MANUAL_BATCHES),

        /** A subscription's status moved in the store: every owned subscription. */
        SUBSCRIPTIONS(resendKnown = true, packs = false, batches = MAX_MANUAL_BATCHES),
    }

    private suspend fun restore(mode: RestoreMode): RestoreOutcome = restoreLock.withLock {
        val me = account() ?: return@withLock RestoreOutcome.Failed
        when (val availability = billing.connect()) {
            BillingAvailability.Ready -> Unit
            is BillingAvailability.Unavailable -> return@withLock RestoreOutcome.StoreUnavailable(availability.reason)
        }
        // What waits to be sent before the flush: one its send gets granted is added by this restore
        // (the purchase route's answer has no `fresh`).
        val queued = outbox.all().filter { it.account == me && it.stage == OutboxStage.VERIFY }.associate { it.token to it.productId }
        flush()
        val flushed = queued.filter { (token, _) -> known.state(token) in GRANTING }.values.toSet()
        val subscriptions = billing.ownedPurchases(ProductType.SUBSCRIPTION)
        val packs = if (mode.packs) billing.ownedPurchases(ProductType.ONE_TIME) else null
        if (subscriptions is BillingResult.Failed && (packs == null || packs is BillingResult.Failed)) {
            return@withLock RestoreOutcome.StoreUnavailable(subscriptions.reason)
        }
        val waiting = outbox.all().map { it.token }.toSet()
        val owned = buildList {
            (subscriptions as? BillingResult.Ok)?.value?.forEach { add(it to PurchaseKind.Subscription) }
            (packs as? BillingResult.Ok)?.value?.forEach { add(it to PurchaseKind.Consumable) }
        }.filter { (p, _) -> p.state == StorePurchaseState.PURCHASED && p.purchaseToken !in waiting && p.productIds.isNotEmpty() }
        val candidates = owned.filter { (p, _) -> mode.resendKnown || known.needsSending(p.purchaseToken, p.state) }
            .distinctBy { it.first.purchaseToken }
        if (candidates.isEmpty()) {
            if (mode.resendKnown) entitlements.refresh()
            return@withLock if (flushed.isEmpty()) {
                RestoreOutcome.NothingToRestore
            } else {
                RestoreOutcome.Done(emptySet(), 0, 0, 0, added = flushed, addedKnown = true)
            }
        }
        val granted = mutableSetOf<String>()
        val added = flushed.toMutableSet()
        var addedKnown = true
        var foreign = 0
        var invalid = 0
        var later = 0
        var inactive = 0
        fun done() = RestoreOutcome.Done(granted, foreign, invalid, later, inactive, added, addedKnown)
        for (batch in candidates.chunked(MAX_RESTORE).take(mode.batches)) {
            val result = try {
                api.restore(batch.map { (p, kind) -> p.toRestore(kind) })
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError.Network) {
                return@withLock if (granted.isEmpty() && added.isEmpty()) RestoreOutcome.Offline else done()
            } catch (e: ApiError) {
                diag.warn(AREA, "restore refused (${e.code ?: e.javaClass.simpleName})")
                return@withLock if (granted.isEmpty() && added.isEmpty()) RestoreOutcome.Failed else done()
            }
            val byToken = batch.associateBy { it.first.purchaseToken }
            for (line in result.results) {
                val (purchase, kind) = byToken[line.purchaseToken] ?: continue
                val first = when (val fresh = line.fresh) {
                    // An older server: new when the phone had no settled answer for it and it gives access now.
                    null -> (line.state in GRANTING && unsettled(known.state(line.purchaseToken))).also { addedKnown = false }
                    else -> fresh && line.state in GRANTING
                }
                if (first) added += purchase.productIds.first()
                when (line.state) {
                    in GRANTING -> granted += purchase.productIds.first()
                    KnownPurchases.UNAVAILABLE, KnownPurchases.PENDING -> later++
                    OTHER_ACCOUNT -> foreign++
                    INVALID -> invalid++
                    // On hold, paused, expired, refunded, replaced, or a state this build does not know: nothing given.
                    else -> inactive++
                }
                known.put(line.purchaseToken, line.state)
                // A pack the server holds as credited and the store still holds: used up in the store.
                if (kind == PurchaseKind.Consumable && line.state in CREDITED) {
                    val entry = outbox.add(
                        QueuedPurchase.of(me, purchase, purchase.productIds.first(), kind, clock.nowMillis()).copy(stage = OutboxStage.CONSUME),
                    )
                    if (entry.stage == OutboxStage.CONSUME) consume(entry)
                }
            }
            entitlements.apply(result.entitlements)
        }
        countWaiting()
        done()
    }

    private fun StorePurchase.toRestore(kind: PurchaseKind) = RestorePurchase(
        productId = productIds.first(),
        purchaseToken = purchaseToken,
        kind = kind,
        originalJson = originalJson.takeIf { store == Store.BAZAAR },
        signature = signature?.takeIf { store == Store.BAZAAR },
    )

    // MARK: - Lifecycle

    /**
     * The account is in (the tabs, or a restricted account's screen): send
     * what waits, and once per account and process, then at most every few
     * minutes when the app returns to the front, a quiet restore of what the
     * server does not know.
     */
    suspend fun signedIn() {
        val me = account() ?: return
        val now = clock.nowMillis()
        val last = lastQuietRestoreAt
        if (quietRestoreAccount == me && last != null && now - last < QUIET_RESTORE_EVERY_MS) {
            flush()
            return
        }
        quietRestoreAccount = me
        lastQuietRestoreAt = now
        restore(manual = false)
    }

    /**
     * Store updates outside a flow, a re-sync of the subscriptions when the
     * store says their status moved, and a resend whenever the network comes
     * back. Once.
     */
    fun start(online: Flow<Boolean>) {
        if (started) return
        started = true
        scope.launch { billing.unsolicitedPurchases.collect { onStorePurchase(it) } }
        scope.launch { billing.subscriptionStatusChanges.conflate().collect { resyncSubscriptions() } }
        scope.launch { online.collect { up -> if (up) flushNow() } }
    }

    /** Another account signed in, or nobody: what the paywall showed is gone. */
    fun clear() {
        _step.value = PurchaseStep.Idle
        stepToken = null
        lastQuietRestoreAt = null
        quietRestoreAccount = null
        lastServerCatalogue = null
        _waiting.value = 0
    }

    // MARK: - Boosts

    /**
     * `POST /v1/boosts`: from the plan's monthly boosts or the wallet; one
     * already running answers its own end. The running boost shows at once;
     * the counts follow from one read.
     */
    suspend fun boost(kind: BoostKind): BoostOutcome = try {
        val started = api.boost(kind)
        entitlements.patch { it.copy(boostEndsAt = started.endsAt) }
        scope.launch { entitlements.refresh() }
        BoostOutcome.Started(started.endsAt)
    } catch (e: CancellationException) {
        throw e
    } catch (e: ApiError.Network) {
        BoostOutcome.Offline
    } catch (e: ApiError.Http) {
        if (e.code == ProblemCodes.QUOTA_EXCEEDED) BoostOutcome.NoneLeft(e.problem.canBuy == true) else BoostOutcome.Failed
    } catch (e: ApiError) {
        BoostOutcome.Failed
    }

    private fun kindOf(productId: String): PurchaseKind =
        lastServerCatalogue?.let { server ->
            when {
                server.subscriptions.any { it.productId == productId } -> PurchaseKind.Subscription
                server.consumables.any { it.productId == productId } -> PurchaseKind.Consumable
                else -> null
            }
        } ?: if (productId.startsWith(SUBSCRIPTION_PREFIX)) PurchaseKind.Subscription else PurchaseKind.Consumable

    companion object {
        private const val AREA = "Billing"
        const val MAX_RESTORE = 20
        private const val MAX_MANUAL_BATCHES = 3
        private const val MAX_CONSUME_ATTEMPTS = 8
        private const val OTHER_ACCOUNT = "other_account"
        private const val INVALID = "invalid"
        private val CREDITED = setOf("purchased", "consumed")

        /**
         * The server's purchase states that give access: a running
         * subscription (cancelled ones run to their end, grace keeps access
         * while the store retries the payment) and a credited pack. Every
         * other state, known or not, gives nothing.
         */
        internal val GRANTING: Set<String> = setOf("active", "canceled", "grace") + CREDITED

        /** Neutral product ids: subscriptions start with `sub.` in both stores. */
        private const val SUBSCRIPTION_PREFIX = "sub."
        private const val KEEP_MS = 30L * 24 * 3600 * 1000
        private const val QUIET_RESTORE_EVERY_MS = 10L * 60 * 1000

        /** 5 s, 15 s, 1 min, 5 min, 15 min, then every 30 min. */
        fun backoff(attempts: Int): Long = when (attempts) {
            0 -> 5_000L
            1 -> 15_000L
            2 -> 60_000L
            3 -> 5 * 60_000L
            4 -> 15 * 60_000L
            else -> 30 * 60_000L
        }
    }
}

fun BillingUnavailableReason.failure(): PurchaseFailure = when (this) {
    BillingUnavailableReason.STORE_NOT_INSTALLED -> PurchaseFailure.STORE_MISSING
    BillingUnavailableReason.STORE_NOT_READY -> PurchaseFailure.STORE_NOT_READY
    BillingUnavailableReason.NOT_SUPPORTED -> PurchaseFailure.NOT_SUPPORTED
    BillingUnavailableReason.SERVICE_UNAVAILABLE -> PurchaseFailure.STORE_UNREACHABLE
    BillingUnavailableReason.ERROR -> PurchaseFailure.STORE_ERROR
}

/** Whether [entitlements] show a paid plan from this build's own store (cancelled and changed there). */
fun Entitlements.storePlan(store: Store): Boolean = PlanKey.isPaid(plan) && source?.wire == store.id

/**
 * [storePlan], and not past its own end at [now]. The server counts a
 * subscription only until it ends, so a copy whose end has passed was read
 * before then (the event that ended it was missed) and holds nothing.
 */
fun Entitlements.runningStorePlan(store: Store, now: Instant): Boolean =
    storePlan(store) && planExpiresAt?.isAfter(now) != false
