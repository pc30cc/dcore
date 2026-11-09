package app.core.feature.paywall

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.billing.PackOption
import app.core.billing.PurchaseStep
import app.core.feature.auth.brandPlural
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.i18n.brandString
import app.core.model.PurchaseKind
import app.core.model.Wallet
import app.core.model.WalletItem
import app.core.ui.theme.Radius
import app.core.ui.theme.Space

/**
 * The packs of one consumable (super likes, boosts, spotlight, messages):
 * what it does, how many the account holds, each pack with the store's own
 * price, and the purchase's steps, in a bottom sheet over the screen that
 * ran out.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PacksContent(state: StoreUiState, item: WalletItem, actions: StoreActions, modifier: Modifier = Modifier) {
    val storeName = brandString(R.string.store_name)
    val number = rememberNumbers()
    val step = state.step
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(start = Space.xl, end = Space.xl, bottom = Space.xl),
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        if (step is PurchaseStep.Done && step.kind == PurchaseKind.Consumable) {
            val pack = step.target.let { state.catalogue?.pack(it) }
            DonePane(
                title = brandString(R.string.paywall_done_pack_title),
                body = pack?.let { brandPlural(it.item.quantity(), it.quantity, number(it.quantity)) } ?: "",
                onContinue = { actions.stepShown(); actions.close() },
            )
            return@Column
        }
        Text(brandString(item.packsTitle()), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
        Text(brandString(item.packsBody()), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.entitlements?.wallet?.count(item)?.takeIf { it > 0 }?.let { held ->
            Text(
                brandString(R.string.packs_have, brandPlural(item.quantity(), held, number(held))),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        when (val load = state.load) {
            StoreLoad.Loading -> Row(Modifier.fillMaxWidth().padding(vertical = Space.lg), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator()
            }
            is StoreLoad.Unavailable -> UnavailablePane(load.reason, storeName, actions)
            StoreLoad.Offline -> MessagePane(Icons.Filled.Info, brandString(R.string.paywall_offline_title), brandString(R.string.paywall_offline_body), actions::retry)
            StoreLoad.Failed -> MessagePane(Icons.Filled.Warning, brandString(R.string.paywall_failed_title), brandString(R.string.paywall_failed_body), actions::retry)
            is StoreLoad.Ready -> {
                val packs = load.catalogue.packsFor(item)
                if (packs.isEmpty()) {
                    MessagePane(Icons.Filled.ShoppingCart, brandString(R.string.paywall_empty_title), brandString(R.string.paywall_empty_body), actions::retry)
                } else {
                    packs.forEach { pack -> PackRow(pack, state, number) { actions.buy(pack.key) } }
                }
            }
        }
        StepPanel(step, storeName, actions)
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.xs, Alignment.CenterHorizontally)) {
            if (state.catalogue?.plans?.isNotEmpty() == true) {
                TextButton(onClick = actions::seePlans, enabled = !state.busy, modifier = Modifier.heightIn(min = Space.minTouch)) {
                    Text(brandString(R.string.packs_or_plans))
                }
            }
            TextButton(onClick = actions::restore, enabled = !state.busy, modifier = Modifier.heightIn(min = Space.minTouch)) {
                Text(brandString(if (state.restoring) R.string.paywall_restoring else R.string.paywall_restore))
            }
        }
        // The restore button's answer, under it (a snackbar would sit behind the sheet).
        state.restoreNotice?.let { notice ->
            Text(
                brandString(notice.message(), storeName),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

@Composable
private fun PackRow(pack: PackOption, state: StoreUiState, number: (Int) -> String, onBuy: () -> Unit) {
    val what = brandPlural(pack.item.quantity(), pack.quantity, number(pack.quantity))
    val busyHere = state.busy && state.step.target == pack.key
    val description = brandString(R.string.packs_buy_a11y, what, pack.price)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radius.lg))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(Radius.lg))
            .heightIn(min = 64.dp)
            .padding(horizontal = Space.md, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
            Text(what, style = MaterialTheme.typography.titleMedium)
            pack.badge?.let { Badge(brandString(it.label()), it) }
        }
        Spacer(Modifier.width(Space.sm))
        Button(
            onClick = onBuy,
            enabled = !state.busy && state.step !is PurchaseStep.Pending && state.step !is PurchaseStep.Queued,
            modifier = Modifier.heightIn(min = Space.minTouch).semantics { contentDescription = description },
        ) {
            if (busyHere) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
            } else {
                Text(isolate(pack.price))
            }
        }
    }
}

/** How many of [item] the wallet holds. */
fun Wallet.count(item: WalletItem): Int = when (item) {
    WalletItem.Superlike -> superlike
    WalletItem.Boost -> boost
    WalletItem.Spotlight -> spotlight
    WalletItem.Dm -> dm
    WalletItem.Unknown -> 0
}
