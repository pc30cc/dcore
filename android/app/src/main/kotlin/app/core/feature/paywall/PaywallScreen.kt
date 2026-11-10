package app.core.feature.paywall

import android.graphics.Matrix
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.billing.Catalogue
import app.core.billing.PlanGroup
import app.core.billing.PurchaseFailure
import app.core.billing.PurchaseStep
import app.core.billing.storePlan
import app.core.feature.auth.authSideInsets
import app.core.feature.auth.authTopInsets
import app.core.feature.auth.brandPlural
import app.core.feature.auth.screenLanguage
import app.core.feature.card.isolate
import app.core.i18n.AppLanguage
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.model.PlanKey
import app.core.model.PurchaseKind
import app.core.store.Store
import app.core.ui.components.AppIconButton
import app.core.ui.components.BenefitList
import app.core.ui.components.PeriodOption
import app.core.ui.components.PeriodRow
import app.core.ui.components.PlanSelector
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SecondaryButton
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.periodsStacked
import app.core.ui.components.skeleton
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import app.core.ui.components.PlanOption as PlanChoice

/** What the paywall and the packs sheet can be asked to do. */
interface StoreActions {
    fun close()
    fun selectPlan(plan: String)
    fun select(key: String)
    fun selectItem(item: app.core.model.WalletItem)
    fun selectPack(key: String)
    fun buy(key: String)
    fun restore()
    fun retry()

    /** The held-elsewhere line: read the entitlements and the store's list again. */
    fun checkAgain()
    fun stepShown()
    fun manage()
    fun openLink(url: String)
    fun installStore()
    fun openStore()
}

/** The links under the purchase button, from the config (else the build's). */
data class PaywallLinks(val termsUrl: String, val privacyUrl: String)

/** The paywall on the design's phone (dp). */
internal object PaywallLayout {
    val topRow = 56.dp
    val closeInset = 8.dp

    /** The block's least distance from the close row, when it fills the screen. */
    val top = 8.dp
    val group = 20.dp
    val aboveButton = 24.dp
    val underButton = 12.dp
    val aboveLinks = 4.dp
    val linkGap = 8.dp
    val bottom = 14.dp
    val periodGap = 8.dp
    val period = 64.dp
    val selector = 48.dp
    val skeletonBenefit = 22.dp
    val skeletonBenefitWidth = 0.6f
    val skeletonGap = 12.dp
    val skeletonPeriods = 3
}

/**
 * The paywall (m14, h06): the close button, then one block resting on the
 * bottom of the screen: the title, the plan selector (segmented for two or
 * three plans, a rail for more), what the chosen plan gives, its periods
 * with the store's prices, the button with the price on it, one store line
 * and the links, 20 dp between groups and 24 dp above the button. Neon's
 * hero light fills the free space above it. Every step of a purchase, and
 * a restore's answer, is said on the one line under the button; when the
 * catalogue cannot be shown, what happened is the page's only title, with
 * its one action.
 */
@Composable
fun PaywallScreen(
    state: StoreUiState,
    entry: PaywallEntry,
    store: Store,
    planNames: Map<String, String>,
    links: PaywallLinks,
    actions: StoreActions,
    modifier: Modifier = Modifier,
    likes: Int? = null,
) {
    val t = AppTheme.template
    val language = screenLanguage()
    val storeName = brandString(R.string.store_name)

    Box(modifier.fillMaxSize().background(t.colors.bg)) {
        if (t.switches.glow) Box(Modifier.fillMaxSize().background(t.paints.heroBg))
        Column(Modifier.fillMaxSize().authTopInsets().authSideInsets()) {
            Row(Modifier.fillMaxWidth().height(PaywallLayout.topRow).padding(start = PaywallLayout.closeInset), verticalAlignment = Alignment.CenterVertically) {
                AppIconButton(AppIcons.Close, brandString(R.string.paywall_close), actions::close)
            }
            val step = state.step
            BottomBlock {
                if (step is PurchaseStep.Done && step.kind == PurchaseKind.Subscription) {
                    Done(state, step, planNames, actions)
                } else {
                    Offer(state, entry, likes, store, storeName, language, planNames, links, actions)
                }
            }
        }
    }
}

/**
 * The page under the close row: [content] rests on the bottom edge; taller
 * than the screen (large text, a small phone), it fills it and scrolls from
 * its top, so nothing moves while it is read.
 */
@Composable
private fun ColumnScope.BottomBlock(content: @Composable ColumnScope.() -> Unit) {
    BoxWithConstraints(
        Modifier
            .weight(1f)
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets(bottom = PaywallLayout.bottom)).only(WindowInsetsSides.Bottom)),
    ) {
        val viewport = maxHeight
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Column(
                Modifier.fillMaxWidth().heightIn(min = viewport).padding(top = PaywallLayout.top),
                verticalArrangement = Arrangement.Bottom,
                content = content,
            )
        }
    }
}

/** The purchase confirmed: «پریمیوم فعال شد.» right above «ادامه». */
@Composable
private fun Done(state: StoreUiState, step: PurchaseStep.Done, planNames: Map<String, String>, actions: StoreActions) {
    // The plan of the period just bought; the entitlements' only when they name a paid one.
    val plan = state.catalogue?.option(step.target)?.plan
        ?: state.entitlements?.plan?.takeIf(PlanKey::isPaid)
        ?: state.plan.orEmpty()
    PageTitle(brandString(R.string.paywall_done_plan, planName(plan, planNames, state.catalogue?.plan(plan)?.name)))
    Spacer(Modifier.height(PaywallLayout.aboveButton))
    PrimaryButton(brandString(R.string.paywall_done_action), { actions.stepShown(); actions.close() }, Modifier.padding(horizontal = Space.gutter))
}

/** The offer in its state: loading, the plans, or why there are none with the one thing that helps. */
@Composable
private fun Offer(
    state: StoreUiState,
    entry: PaywallEntry,
    likes: Int?,
    store: Store,
    storeName: String,
    language: AppLanguage,
    planNames: Map<String, String>,
    links: PaywallLinks,
    actions: StoreActions,
) {
    // A plan of this store keeps its way to the store's page on a page that cannot show the plans too.
    val manage = state.entitlements?.storePlan(store) == true
    when (val load = state.load) {
        StoreLoad.Loading -> {
            Title(entry, likes, language)
            Spacer(Modifier.height(PaywallLayout.group))
            LoadingPlans()
            Footer(state, storeName, links, actions, manage)
        }
        is StoreLoad.Unavailable -> when (load.reason) {
            PurchaseFailure.STORE_MISSING -> Stopped(brandString(load.reason.message(), storeName), brandString(R.string.paywall_store_missing_action, storeName), actions::installStore, state, storeName, links, actions, manage)
            PurchaseFailure.STORE_NOT_READY -> Stopped(brandString(load.reason.message(), storeName), brandString(R.string.paywall_store_not_ready_action, storeName), actions::openStore, state, storeName, links, actions, manage)
            else -> Stopped(brandString(load.reason.message(), storeName), brandString(R.string.action_try_again), actions::retry, state, storeName, links, actions, manage)
        }
        StoreLoad.Offline -> Stopped(brandString(R.string.error_offline), brandString(R.string.action_try_again), actions::retry, state, storeName, links, actions, manage)
        StoreLoad.Failed -> Stopped(brandString(R.string.error_generic), brandString(R.string.action_try_again), actions::retry, state, storeName, links, actions, manage)
        is StoreLoad.Ready -> {
            val group = shownPlan(load.catalogue, state)
            if (group == null) {
                Stopped(brandString(R.string.paywall_none), brandString(R.string.action_try_again), actions::retry, state, storeName, links, actions, manage)
            } else {
                Title(entry, likes, language)
                Spacer(Modifier.height(PaywallLayout.group))
                val plans = load.catalogue.plans
                if (plans.size > 1) {
                    PlanSelector(
                        plans = plans.map { PlanChoice(it.plan, planName(it.plan, planNames, it.name)) },
                        selectedId = group.plan,
                        onSelect = actions::selectPlan,
                        modifier = Modifier.padding(horizontal = if (plans.size <= RAIL_FROM) Space.gutter else 0.dp),
                        contentPadding = PaddingValues(horizontal = if (plans.size <= RAIL_FROM) 0.dp else Space.gutter),
                        enabled = !state.busy,
                    )
                    Spacer(Modifier.height(PaywallLayout.group))
                }
                BenefitList(benefitLines(group, plans, planNames, language), Modifier.padding(horizontal = Space.gutter))
                Spacer(Modifier.height(PaywallLayout.group))
                Purchase(state, load.catalogue, group, store, storeName, language, actions)
                Spacer(Modifier.height(PaywallLayout.aboveLinks))
                LinksRow(state, links, actions)
            }
        }
    }
}

/**
 * The catalogue cannot be shown: [message] is the page's only title, with
 * its one action under it, and the links (a restore still works); for a
 * plan of this store ([manage]), its store page.
 */
@Composable
private fun Stopped(
    message: String,
    action: String,
    onAction: () -> Unit,
    state: StoreUiState,
    storeName: String,
    links: PaywallLinks,
    actions: StoreActions,
    manage: Boolean,
) {
    PageTitle(message)
    Spacer(Modifier.height(PaywallLayout.aboveButton))
    SecondaryButton(action, onAction, Modifier.padding(horizontal = Space.gutter))
    Footer(state, storeName, links, actions, manage)
}

/** Under a page without periods: the restore's line when there is one, «مدیریت اشتراک» for [manage], and the links. */
@Composable
private fun Footer(state: StoreUiState, storeName: String, links: PaywallLinks, actions: StoreActions, manage: Boolean) {
    Spacer(Modifier.height(PaywallLayout.underButton))
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), horizontalAlignment = Alignment.CenterHorizontally) {
        StatusLine(state, storeName, actions, fallback = null, plans = true, manage = manage)
    }
    Spacer(Modifier.height(PaywallLayout.aboveLinks))
    LinksRow(state, links, actions)
}

/**
 * The page's title (`--type-h1`); the [highlight] part («۱۲ نفر») in the
 * template's accent (`--accent-text`: neon's gradient, white's ink). The
 * gradient spans the highlighted words only, as the design draws it, not
 * the whole title.
 */
@Composable
private fun PageTitle(text: String, highlight: IntRange? = null) {
    val t = AppTheme.template
    val accent = t.paints.accentText
    var bounds by remember(text, highlight) { mutableStateOf<Rect?>(null) }
    val annotated = remember(text, highlight, accent, bounds) {
        buildAnnotatedString {
            append(text)
            if (highlight != null) addStyle(SpanStyle(brush = accent.within(bounds)), highlight.first, highlight.last + 1)
        }
    }
    Text(
        annotated,
        style = t.type.h1.copy(lineBreak = LineBreak.Heading),
        color = t.colors.text,
        onTextLayout = { layout ->
            if (highlight != null) bounds = layout.getPathForRange(highlight.first, highlight.last + 1).getBounds()
        },
        modifier = Modifier.fillMaxWidth().padding(horizontal = Space.gutter).semantics { heading() },
    )
}

/**
 * [this] drawn over [bounds] only: a span's brush is otherwise sized to the
 * whole paragraph, so a gradient on a few words would show one end of it.
 */
private fun Brush.within(bounds: Rect?): Brush {
    val inner = this as? ShaderBrush ?: return this
    if (bounds == null || bounds.isEmpty) return this
    return object : ShaderBrush() {
        override fun createShader(size: Size): Shader =
            inner.createShader(bounds.size).apply { setLocalMatrix(Matrix().apply { setTranslate(bounds.left, bounds.top) }) }
    }
}

/**
 * «۱۲ نفر لایکت کردن» from the likes list (the count highlighted),
 * «لایک‌های امروزت تموم شد» out of likes, else «یه اشتراک انتخاب کن».
 */
@Composable
private fun Title(entry: PaywallEntry, likes: Int?, language: AppLanguage) {
    when {
        entry == PaywallEntry.SEE_LIKES && likes != null && likes > 0 -> {
            val count = Numerals.format(likes, language)
            val sentence = brandPlural(R.plurals.paywall_likes, likes, count)
            val who = brandPlural(R.plurals.paywall_likes_who, likes, count)
            val at = sentence.indexOf(who)
            PageTitle(sentence, if (at < 0) null else at until at + who.length)
        }
        entry == PaywallEntry.OUT_OF_LIKES -> PageTitle(brandString(R.string.paywall_out_of_likes))
        else -> PageTitle(brandString(R.string.paywall_choose))
    }
}

/** Up to this many plans the selector is segmented; more are a rail (README m14). */
private const val RAIL_FROM = 3

private fun shownPlan(catalogue: Catalogue, state: StoreUiState): PlanGroup? =
    state.plan?.let(catalogue::plan) ?: catalogue.plans.firstOrNull()

/** The selector's, the benefits', the periods' and the button's shapes while the catalogue is read. */
@Composable
private fun LoadingPlans() {
    val t = AppTheme.template
    val loading = stringResource(R.string.ui_loading)
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter).semantics(mergeDescendants = true) { contentDescription = loading }) {
        Box(Modifier.fillMaxWidth().height(PaywallLayout.selector).skeleton(RoundedCornerShape(t.radii.button)))
        Spacer(Modifier.height(PaywallLayout.group))
        Column(verticalArrangement = Arrangement.spacedBy(PaywallLayout.skeletonGap)) {
            repeat(MAX_BENEFITS) { Box(Modifier.fillMaxWidth(PaywallLayout.skeletonBenefitWidth).height(PaywallLayout.skeletonBenefit).skeleton()) }
        }
        Spacer(Modifier.height(PaywallLayout.group))
        Column(verticalArrangement = Arrangement.spacedBy(PaywallLayout.periodGap)) {
            repeat(PaywallLayout.skeletonPeriods) { Box(Modifier.fillMaxWidth().height(PaywallLayout.period).skeleton(RoundedCornerShape(t.radii.option))) }
        }
        Spacer(Modifier.height(PaywallLayout.aboveButton))
        Box(Modifier.fillMaxWidth().height(t.sizes.buttonH).skeleton(RoundedCornerShape(t.radii.button)))
    }
}

/**
 * The periods, the button with the price and the one store line. The
 * period the person is on is marked and not sold again: its button opens
 * the store's own page, as it does while Cafe Bazaar keeps another
 * subscription from being sold and while the plan is held on another store
 * account. A plan from this store keeps a way to that page whatever is
 * chosen: «مدیریت اشتراک» under the line when the button sells something
 * else (on Play, a plan change), or when the plan held is no longer sold.
 */
@Composable
private fun Purchase(state: StoreUiState, catalogue: Catalogue, group: PlanGroup, store: Store, storeName: String, language: AppLanguage, actions: StoreActions) {
    val currency = brandString(R.string.paywall_currency)
    val currentLabel = brandString(R.string.paywall_option_current)
    val step = state.step
    val periods = group.options.map { option ->
        val price = StorePrices.display(option.product, language, currency)
        val saving = StorePrices.savingPercent(option, group)?.let { brandString(R.string.paywall_save, Numerals.percent(it, language)) }
        PeriodOption(
            id = option.key,
            title = periodLabel(option.period, language),
            total = if (price.unit == null) isolate(price.amount) else price.amount,
            unit = price.unit.orEmpty(),
            saving = if (option.key == state.current) currentLabel else saving,
        )
    }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = Space.gutter)) {
        // One layout for every row: when one price has to go under its title, all of them do.
        val stacked = periodsStacked(periods, maxWidth)
        Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(PaywallLayout.periodGap)) {
            periods.forEach { period ->
                PeriodRow(
                    period,
                    selected = period.id == state.selected,
                    onClick = { actions.select(period.id) },
                    enabled = !state.busy,
                    stacked = stacked,
                )
            }
        }
    }
    Spacer(Modifier.height(PaywallLayout.aboveButton))
    val option = state.selected?.let(catalogue::option)?.takeIf { it.plan == group.plan }
    val isCurrent = option != null && option.key == state.current
    val storePlan = state.entitlements?.storePlan(store) == true
    val manageButton = (state.heldElsewhere && step is PurchaseStep.Idle) || (storePlan && (isCurrent || state.subscriptionLocked))
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), horizontalAlignment = Alignment.CenterHorizontally) {
        when {
            manageButton -> SecondaryButton(brandString(R.string.manage_subscription), actions::manage)
            option != null -> {
                val price = StorePrices.display(option.product, language, currency)
                // The purchase under way keeps its button in the accent, at work; anything else waits greyed.
                val working = state.busy && step.target == option.key
                PrimaryButton(
                    brandString(R.string.paywall_cta, if (price.unit == null) isolate(price.full) else price.full),
                    { actions.buy(option.key) },
                    enabled = working || (
                        !state.busy && !state.heldElsewhere &&
                            step !is PurchaseStep.Pending && step !is PurchaseStep.Queued
                        ),
                    loading = working,
                )
            }
        }
        Spacer(Modifier.height(PaywallLayout.underButton))
        StatusLine(
            state,
            storeName,
            actions,
            fallback = option?.let { renewalLine(it.period, storeName, language) },
            plans = true,
            manage = storePlan && !manageButton,
        )
    }
}

/**
 * The line under a purchase button: the purchase's step when there is
 * one, else a restore under way or its answer, else, for [plans], a
 * payment still waiting for the server or what keeps a subscription from
 * being sold here, else [fallback] (the store's renewal terms, or the
 * packs' one-time line). While the button can still buy (a failed step, a
 * restore's answer, a payment waiting), the terms stay as a second line
 * under that text. Only what changes as the person acts is said aloud as
 * it changes; the terms are not. A stop the person can act on carries that
 * one action; [manage] adds the store's subscription page.
 */
@Composable
internal fun StatusLine(state: StoreUiState, storeName: String, actions: StoreActions, fallback: String?, plans: Boolean, manage: Boolean = false) {
    val t = AppTheme.template
    val step = state.step
    var error = false
    var announced = true
    // The terms kept under another text, where the button still buys.
    var terms: String? = null
    val notice = state.restoreNotice
    val text = when (step) {
        is PurchaseStep.Verifying -> brandString(R.string.paywall_step_verifying, storeName)
        is PurchaseStep.Restoring -> brandString(R.string.paywall_step_restoring)
        is PurchaseStep.Pending -> brandString(R.string.paywall_step_pending)
        is PurchaseStep.Queued -> brandString(R.string.paywall_step_queued)
        is PurchaseStep.Failed -> {
            error = step.reason != PurchaseFailure.ALREADY_CURRENT
            terms = fallback
            brandString(step.reason.message(), storeName)
        }
        else -> when {
            state.restoring -> brandString(R.string.paywall_restoring)
            notice != null -> {
                error = notice.isError
                terms = fallback
                brandString(notice.message(), storeName)
            }
            !plans -> fallback.also { announced = false }
            state.waiting > 0 -> {
                terms = fallback
                brandString(R.string.paywall_waiting)
            }
            state.heldElsewhere -> brandString(R.string.paywall_held_elsewhere, storeName)
            fallback == null -> null
            state.subscriptionLocked && state.selected != state.current -> brandString(R.string.paywall_locked)
            else -> fallback.also { announced = false }
        }
    }
    if (text != null) {
        Text(
            text,
            style = t.type.legal,
            color = if (error) t.colors.error else t.colors.text3,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().then(if (announced) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier),
        )
    }
    terms?.takeIf { it != text }?.let { kept ->
        Text(kept, style = t.type.legal, color = t.colors.text3, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
    val idle = step is PurchaseStep.Idle && !state.restoring
    val action: Pair<String, () -> Unit>? = when {
        step is PurchaseStep.Failed && step.reason == PurchaseFailure.STORE_MISSING ->
            brandString(R.string.paywall_store_missing_action, storeName) to actions::installStore
        step is PurchaseStep.Failed && step.reason == PurchaseFailure.STORE_NOT_READY ->
            brandString(R.string.paywall_store_not_ready_action, storeName) to actions::openStore
        plans && idle && state.waiting == 0 && state.heldElsewhere ->
            brandString(R.string.paywall_check_again) to actions::checkAgain
        plans && idle && manage -> brandString(R.string.manage_subscription) to actions::manage
        else -> null
    }
    if (action != null) {
        TextAction(
            action.first,
            action.second,
            style = t.type.legalLink,
            enabled = !(plans && state.heldElsewhere && (state.checking || state.busy)),
        )
    }
}

/** A restore's answer that says something went wrong, drawn in `--error`. */
private val RestoreNotice.isError: Boolean
    get() = this == RestoreNotice.OFFLINE || this == RestoreNotice.FAILED || this == RestoreNotice.STORE_UNAVAILABLE || this == RestoreNotice.OTHER_ACCOUNT

/**
 * «بازیابی خرید»، «قوانین»، «حریم خصوصی»: 48 dp tall, 8 dp apart, in
 * `--type-legal-link`; a link that no longer fits (large text, a narrow
 * phone) moves to a second line instead of being cut.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LinksRow(state: StoreUiState, links: PaywallLinks, actions: StoreActions) {
    val t = AppTheme.template
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = Space.gutter),
        horizontalArrangement = Arrangement.spacedBy(PaywallLayout.linkGap, Alignment.CenterHorizontally),
    ) {
        TextAction(brandString(R.string.paywall_restore), actions::restore, kind = TextActionKind.Neutral, enabled = !state.busy, style = t.type.legalLink)
        if (links.termsUrl.isNotBlank()) {
            TextAction(brandString(R.string.paywall_terms), { actions.openLink(links.termsUrl) }, kind = TextActionKind.Neutral, style = t.type.legalLink)
        }
        if (links.privacyUrl.isNotBlank()) {
            TextAction(brandString(R.string.paywall_privacy), { actions.openLink(links.privacyUrl) }, kind = TextActionKind.Neutral, style = t.type.legalLink)
        }
    }
}
