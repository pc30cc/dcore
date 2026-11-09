package app.core.feature.paywall

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.billing.Catalogue
import app.core.billing.CatalogueJoin
import app.core.billing.PlanOption
import app.core.billing.ProductBadge
import app.core.billing.PurchaseFailure
import app.core.billing.PurchaseStep
import app.core.billing.storePlan
import app.core.feature.auth.screenLanguage
import app.core.feature.card.isolate
import app.core.feature.onboarding.formatDate
import app.core.i18n.brandString
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.model.PurchaseKind
import app.core.store.Store
import app.core.ui.components.BrandMark
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import java.time.ZoneId

/** What the paywall and the packs sheet can be asked to do. */
interface StoreActions {
    fun close()
    fun selectPlan(plan: Plan)
    fun select(key: String)
    fun buy(key: String)
    fun restore()
    fun restoreShown()
    fun retry()

    /** The held-elsewhere note: read the entitlements and the store's list again. */
    fun checkAgain()
    fun stepShown()
    fun manage()
    fun openLink(url: String)
    fun installStore()
    fun openStore()

    /** From a packs sheet: the plans instead. */
    fun seePlans()
}

/** The links under the purchase button, from the config (else the build's). */
data class PaywallLinks(val termsUrl: String, val privacyUrl: String)

/**
 * The paywall for a given state: the plans of this store with the store's
 * own prices, and every step of a purchase. Next to the button, without
 * another tap: the price, the period and that it renews until cancelled;
 * under the prices the store's renewal and cancellation terms, then what is
 * included; the terms and privacy links, restore, and (for a store plan) the
 * store's own subscription page.
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
) {
    val storeName = brandString(R.string.store_name)
    val snackbar = remember { SnackbarHostState() }
    RestoreNotices(state, storeName, snackbar, actions)

    Surface(modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            val step = state.step
            when {
                step is PurchaseStep.Done && step.kind == PurchaseKind.Subscription ->
                    DonePane(
                        title = brandString(R.string.paywall_done_plan_title, planName(state.entitlements?.plan?.takeIf { it in CatalogueJoin.PLANS } ?: state.plan, planNames)),
                        body = brandString(R.string.paywall_done_plan_body, planName(state.entitlements?.plan?.takeIf { it in CatalogueJoin.PLANS } ?: state.plan, planNames)),
                        onContinue = { actions.stepShown(); actions.close() },
                    )
                else -> Column(Modifier.fillMaxSize()) {
                    Column(
                        Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState()),
                    ) {
                        Hero(entry, onClose = actions::close)
                        Column(
                            Modifier.padding(horizontal = Space.gutter),
                            verticalArrangement = Arrangement.spacedBy(Space.lg),
                        ) {
                            CurrentPlan(state.entitlements, store, planNames, actions, manage = !state.heldElsewhere)
                            when (val load = state.load) {
                                StoreLoad.Loading -> LoadingPane()
                                is StoreLoad.Unavailable -> UnavailablePane(load.reason, storeName, actions)
                                StoreLoad.Offline -> MessagePane(Icons.Filled.Info, brandString(R.string.paywall_offline_title), brandString(R.string.paywall_offline_body), actions::retry)
                                StoreLoad.Failed -> MessagePane(Icons.Filled.Warning, brandString(R.string.paywall_failed_title), brandString(R.string.paywall_failed_body), actions::retry)
                                is StoreLoad.Ready -> if (load.catalogue.plans.isEmpty()) {
                                    MessagePane(Icons.Filled.ShoppingCart, brandString(R.string.paywall_empty_title), brandString(R.string.paywall_empty_body), actions::retry)
                                } else {
                                    Plans(load.catalogue, state, planNames, actions)
                                }
                            }
                            Spacer(Modifier.height(Space.sm))
                        }
                    }
                    BottomBar(state, store, links, actions)
                }
            }
            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = 120.dp))
        }
    }
}

@Composable
private fun Hero(entry: PaywallEntry, onClose: () -> Unit) {
    val primary = MaterialTheme.colorScheme.primary
    Box(
        Modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(primary.copy(alpha = 0.16f), MaterialTheme.colorScheme.background))),
    ) {
        IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopStart).padding(Space.xs)) {
            Icon(Icons.Filled.Close, contentDescription = brandString(R.string.paywall_close))
        }
        Column(
            Modifier
                .fillMaxWidth()
                .padding(start = Space.gutter, end = Space.gutter, top = Space.xxl, bottom = Space.md),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            BrandMark(size = 48.dp)
            Text(
                brandString(entry.headline()),
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                brandString(R.string.paywall_title),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * "Plus, renews on 9 Dec 2026", and where to manage it, when there is a paid
 * plan. [manage]: false when the note next to the button already offers the
 * store's page (a plan held on another store account).
 */
@Composable
private fun CurrentPlan(e: Entitlements?, store: Store, planNames: Map<String, String>, actions: StoreActions, manage: Boolean) {
    val plan = e?.plan?.takeIf { it in CatalogueJoin.PLANS } ?: return
    val name = planName(plan, planNames)
    val language = screenLanguage()
    val date = e.planExpiresAt?.let { formatDate(it.atZone(ZoneId.systemDefault()).toLocalDate(), language) }
    val line = when {
        date == null -> brandString(R.string.paywall_current_plain, name)
        e.source == EntitlementSource.Grant -> brandString(R.string.paywall_current_grant, name, date)
        e.autoRenew == true -> brandString(R.string.paywall_current_renews, name, date)
        else -> brandString(R.string.paywall_current_ends, name, date)
    }
    Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer) {
        Column(Modifier.fillMaxWidth().padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(brandString(R.string.paywall_plan_current), style = MaterialTheme.typography.labelLarge)
            Text(line, style = MaterialTheme.typography.titleMedium)
            if (manage && e.storePlan(store)) CardTextButton(brandString(R.string.paywall_manage), actions::manage)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Plans(catalogue: Catalogue, state: StoreUiState, planNames: Map<String, String>, actions: StoreActions) {
    val plans = catalogue.plans.map { it.plan }
    if (plans.size > 1) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            plans.forEachIndexed { index, plan ->
                SegmentedButton(
                    selected = plan == state.plan,
                    onClick = { actions.selectPlan(plan) },
                    shape = SegmentedButtonDefaults.itemShape(index, plans.size),
                    modifier = Modifier.heightIn(min = Space.minTouch),
                ) {
                    Text(planName(plan, planNames), maxLines = 1)
                }
            }
        }
    }
    val group = catalogue.plan(state.plan) ?: catalogue.plans.first()
    Text(
        brandString(R.string.paywall_periods_label),
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.semantics { heading() },
    )
    Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        group.options.forEach { option ->
            OptionRow(option, selected = option.key == state.selected, current = option.key == state.current, enabled = !state.busy) {
                actions.select(option.key)
            }
        }
    }
    // The store's renewal and cancellation terms, right under the prices.
    Text(
        brandString(R.string.paywall_store_terms),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Benefits(group.plan, planNames)
}

@Composable
private fun Benefits(plan: Plan, planNames: Map<String, String>) {
    Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxWidth().padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(brandString(R.string.paywall_benefits_title), style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
            val lines = buildList {
                if (plan == Plan.Premium) add(brandString(R.string.paywall_benefit_everything, planName(Plan.Plus, planNames)))
                benefits(plan).forEach { add(brandString(it)) }
            }
            lines.forEach { line ->
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                    Text(line, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OptionRow(option: PlanOption, selected: Boolean, current: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    val period = brandString(option.period.label())
    val badge = option.badge?.let { brandString(it.label()) }
    val currentText = if (current) brandString(R.string.paywall_option_current) else null
    val selectedText = brandString(R.string.paywall_option_selected)
    val outline = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radius.lg))
            .border(if (selected) 2.dp else 1.dp, outline, RoundedCornerShape(Radius.lg))
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect)
            .heightIn(min = 64.dp)
            .padding(horizontal = Space.md, vertical = Space.sm)
            .semantics(mergeDescendants = true) {
                contentDescription = listOfNotNull(period, option.price, badge, currentText).joinToString(", ")
                if (selected) stateDescription = selectedText
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Spacer(Modifier.width(Space.sm))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                Text(period, style = MaterialTheme.typography.titleMedium)
                if (badge != null) Badge(badge, option.badge)
                if (currentText != null) CurrentBadge(currentText)
            }
            Text(brandString(option.period.every()), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(Space.sm))
        // The store's price exactly as the store writes it.
        Text(isolate(option.price), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun Badge(text: String, badge: ProductBadge?) {
    val container = if (badge == ProductBadge.NEW) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.primaryContainer
    val content = if (badge == ProductBadge.NEW) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onPrimaryContainer
    Surface(shape = RoundedCornerShape(Radius.pill), color = container) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = content, modifier = Modifier.padding(horizontal = Space.sm, vertical = Space.xxs))
    }
}

/** "Current plan" on the period the person is on: the current plan card's colours. */
@Composable
private fun CurrentBadge(text: String) {
    Surface(shape = RoundedCornerShape(Radius.pill), color = MaterialTheme.colorScheme.secondaryContainer) {
        Row(
            Modifier.padding(horizontal = Space.sm, vertical = Space.xxs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.xxs),
        ) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.size(14.dp))
            Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
        }
    }
}

/**
 * The price line, the button, the store's terms and the links. The period
 * the person is on is not offered again: in place of the button, a line
 * saying so. A plan the store account on this phone does not list sells no
 * subscription here: a note, the store's page and "Check again" instead of
 * the price and the button.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BottomBar(state: StoreUiState, store: Store, links: PaywallLinks, actions: StoreActions) {
    val option = state.selected?.let { state.catalogue?.option(it) }
    val storeName = brandString(R.string.store_name)
    if (state.load !is StoreLoad.Ready) {
        // Nothing to buy: only the links (and restore), no price or button.
        Surface(color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = Space.gutter, vertical = Space.sm)) {
                LinksRow(state, store, links, actions)
            }
        }
        return
    }
    Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 6.dp) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Space.gutter, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            // The purchase's step, next to the button that started it.
            if (state.waiting > 0 && state.step !is PurchaseStep.Queued) {
                StepCard(Icons.Filled.DateRange, null, brandString(R.string.paywall_waiting))
            }
            StepPanel(state.step, storeName, actions)
            val isCurrent = option != null && option.key == state.current
            when {
                state.step !is PurchaseStep.Idle -> Unit
                state.heldElsewhere -> StepCard(Icons.Filled.Info, null, brandString(R.string.paywall_held_elsewhere, storeName)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        CardTextButton(brandString(R.string.paywall_manage), actions::manage)
                        CardTextButton(brandString(R.string.paywall_check_again), actions::checkAgain, enabled = !state.checking && !state.busy)
                    }
                }
                state.subscriptionLocked && !isCurrent -> StepCard(Icons.Filled.Info, null, brandString(R.string.paywall_fail_change, storeName))
            }
            if (option != null && isCurrent && !state.heldElsewhere) {
                CurrentOptionLine()
            } else if (option != null && !state.heldElsewhere) {
                Text(
                    brandString(R.string.paywall_renews, isolate(option.price), brandString(option.period.every())),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                val busy = state.busy
                val opening = state.step is PurchaseStep.Connecting || state.step is PurchaseStep.InStore
                Button(
                    onClick = { actions.buy(option.key) },
                    enabled = !busy && !state.subscriptionLocked && state.step !is PurchaseStep.Pending && state.step !is PurchaseStep.Queued,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                ) {
                    if (opening) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
                        Spacer(Modifier.width(Space.sm))
                        Text(brandString(R.string.paywall_step_opening, storeName))
                    } else {
                        Text(brandString(R.string.paywall_subscribe))
                    }
                }
            }
            LinksRow(state, store, links, actions)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LinksRow(state: StoreUiState, store: Store, links: PaywallLinks, actions: StoreActions) {
    FlowRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Space.xs, Alignment.CenterHorizontally),
    ) {
        if (links.termsUrl.isNotBlank()) {
            TextButton(onClick = { actions.openLink(links.termsUrl) }, modifier = Modifier.heightIn(min = Space.minTouch)) { Text(brandString(R.string.paywall_terms)) }
        }
        if (links.privacyUrl.isNotBlank()) {
            TextButton(onClick = { actions.openLink(links.privacyUrl) }, modifier = Modifier.heightIn(min = Space.minTouch)) { Text(brandString(R.string.paywall_privacy)) }
        }
        TextButton(onClick = actions::restore, enabled = !state.busy, modifier = Modifier.heightIn(min = Space.minTouch)) {
            Text(brandString(if (state.restoring) R.string.paywall_restoring else R.string.paywall_restore))
        }
        // The store's subscription page is on the current plan's card, above.
    }
}

/** In place of the purchase button on the period the person is on. */
@Composable
private fun CurrentOptionLine() {
    Surface(shape = RoundedCornerShape(Radius.pill), color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .padding(horizontal = Space.lg)
                .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.CenterHorizontally),
        ) {
            Icon(Icons.Filled.CheckCircle, contentDescription = null, modifier = Modifier.size(20.dp))
            Text(brandString(R.string.paywall_current_option), style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** The purchase's step next to its button, announced as it changes. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun StepPanel(step: PurchaseStep, storeName: String, actions: StoreActions) {
    when (step) {
        is PurchaseStep.Verifying -> StepCard(null, null, brandString(R.string.paywall_step_verifying, storeName), progress = true)
        is PurchaseStep.Restoring -> StepCard(null, null, brandString(R.string.paywall_step_restoring), progress = true)
        is PurchaseStep.Pending -> StepCard(Icons.Filled.DateRange, brandString(R.string.paywall_step_pending_title), brandString(R.string.paywall_step_pending_body, storeName)) {
            CardTextButton(brandString(R.string.paywall_close), onClick = { actions.stepShown(); actions.close() })
        }
        is PurchaseStep.Queued -> StepCard(Icons.Filled.CheckCircle, brandString(R.string.paywall_step_queued_title), brandString(R.string.paywall_step_queued_body, storeName)) {
            CardTextButton(brandString(R.string.paywall_close), onClick = { actions.stepShown(); actions.close() })
        }
        // "You already have this plan" informs; every other stop is a failure.
        is PurchaseStep.Failed -> StepCard(
            if (step.reason == PurchaseFailure.ALREADY_CURRENT) Icons.Filled.CheckCircle else Icons.Filled.Warning,
            null,
            brandString(step.reason.message(), storeName),
            danger = step.reason != PurchaseFailure.ALREADY_CURRENT,
        ) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                when (step.reason) {
                    PurchaseFailure.STORE_MISSING -> CardOutlinedButton(brandString(R.string.paywall_store_missing_action, storeName), actions::installStore)
                    PurchaseFailure.STORE_NOT_READY -> CardOutlinedButton(brandString(R.string.paywall_store_not_ready_action, storeName), actions::openStore)
                    else -> Unit
                }
                CardTextButton(brandString(R.string.action_got_it), actions::stepShown)
            }
        }
        else -> Unit
    }
}

/** A button inside a card, in the card's own text colour (the brand colour fails AA on some cards). */
@Composable
private fun CardTextButton(text: String, onClick: () -> Unit, enabled: Boolean = true) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(contentColor = LocalContentColor.current),
        modifier = Modifier.heightIn(min = Space.minTouch),
    ) { Text(text, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun CardOutlinedButton(text: String, onClick: () -> Unit) {
    val content = LocalContentColor.current
    OutlinedButton(
        onClick = onClick,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = content),
        border = androidx.compose.foundation.BorderStroke(1.dp, content),
        modifier = Modifier.heightIn(min = Space.minTouch),
    ) { Text(text) }
}

@Composable
internal fun StepCard(
    icon: ImageVector?,
    title: String?,
    body: String,
    progress: Boolean = false,
    danger: Boolean = false,
    actions: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val container = if (danger) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHigh
    val content = if (danger) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurface
    Surface(shape = RoundedCornerShape(Radius.lg), color = container, contentColor = content) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(Space.lg)
                .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            when {
                progress -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                icon != null -> Icon(icon, contentDescription = null, modifier = Modifier.size(24.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                if (title != null) Text(title, style = MaterialTheme.typography.titleMedium)
                Text(body, style = MaterialTheme.typography.bodyMedium)
                actions?.invoke(this)
            }
        }
    }
}

@Composable
private fun LoadingPane() {
    Column(
        Modifier.fillMaxWidth().padding(vertical = Space.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        CircularProgressIndicator()
        Text(brandString(R.string.paywall_loading), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The store cannot sell here: what the person can do (install it, sign in), or try again. */
@Composable
internal fun UnavailablePane(reason: PurchaseFailure, storeName: String, actions: StoreActions) {
    val (title, body) = when (reason) {
        PurchaseFailure.STORE_MISSING -> R.string.paywall_store_missing_title to R.string.paywall_store_missing_body
        PurchaseFailure.STORE_NOT_READY -> R.string.paywall_store_not_ready_title to R.string.paywall_store_not_ready_body
        PurchaseFailure.NOT_SUPPORTED -> R.string.paywall_not_supported_title to R.string.paywall_not_supported_body
        else -> R.string.paywall_unreachable_title to R.string.paywall_unreachable_body
    }
    Column(
        Modifier.fillMaxWidth().padding(vertical = Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Box(Modifier.size(64.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.ShoppingCart, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(32.dp))
        }
        Text(brandString(title, storeName), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(brandString(body, storeName), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        when (reason) {
            PurchaseFailure.STORE_MISSING -> Button(onClick = actions::installStore, modifier = Modifier.heightIn(min = Space.minTouch)) {
                Text(brandString(R.string.paywall_store_missing_action, storeName))
            }
            PurchaseFailure.STORE_NOT_READY -> Button(onClick = actions::openStore, modifier = Modifier.heightIn(min = Space.minTouch)) {
                Text(brandString(R.string.paywall_store_not_ready_action, storeName))
            }
            else -> Unit
        }
        OutlinedButton(onClick = actions::retry, modifier = Modifier.heightIn(min = Space.minTouch)) { Text(brandString(R.string.paywall_try_again)) }
    }
}

@Composable
internal fun MessagePane(icon: ImageVector, title: String, body: String, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        OutlinedButton(onClick = onRetry, modifier = Modifier.heightIn(min = Space.minTouch)) { Text(brandString(R.string.paywall_try_again)) }
    }
}

/** A purchase the server confirmed: what it unlocked, and back to where the person was. */
@Composable
internal fun DonePane(title: String, body: String, onContinue: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(Space.xl)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.lg, Alignment.CenterVertically),
    ) {
        Box(Modifier.size(96.dp).clip(CircleShape).background(AppTheme.colors.success.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = AppTheme.colors.success, modifier = Modifier.size(56.dp))
        }
        Text(title, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Button(onClick = onContinue, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(brandString(R.string.paywall_done_action)) }
    }
}

/** The restore button's answer, once, as a snackbar. */
@Composable
internal fun RestoreNotices(state: StoreUiState, storeName: String, snackbar: SnackbarHostState, actions: StoreActions) {
    val notice = state.restoreNotice ?: return
    val text = brandString(notice.message(), storeName)
    LaunchedEffect(notice) {
        snackbar.showSnackbar(text)
        actions.restoreShown()
    }
}
