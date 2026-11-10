package app.core.feature.paywall

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.billing.PackOption
import app.core.billing.PurchaseFailure
import app.core.billing.PurchaseStep
import app.core.feature.auth.brandPlural
import app.core.feature.auth.screenLanguage
import app.core.feature.card.isolate
import app.core.i18n.AppLanguage
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.model.PurchaseKind
import app.core.model.Wallet
import app.core.model.WalletItem
import app.core.ui.components.EmptyState
import app.core.ui.components.PackCard
import app.core.ui.components.PackChoice
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SegmentedControl
import app.core.ui.components.packPriceFit
import app.core.ui.components.skeleton
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space

/** The packs sheet on the design's phone (dp). */
internal object PacksLayout {
    val bottom = 30.dp
    val underTabs = 18.dp
    val titleGap = 10.dp
    val cardsTop = 16.dp
    val cardGap = 8.dp
    val aboveButton = 18.dp
    val underButton = 12.dp
    val skeletonCard = 132.dp
}

/** Up to three packs share a row; more wrap to the next row. */
private const val PACKS_PER_ROW = 3

/** The two items a sheet switches between (README m15): super likes and boosts. */
private val SWITCHED = listOf(WalletItem.Superlike, WalletItem.Boost)

/**
 * The packs of one consumable (m15), in a bottom sheet over the screen that
 * ran out: «سوپرلایک / بوست» when both are on sale, the title with how many
 * the account holds beside it, the packs (the count and the store's price),
 * the button with the chosen pack's price, and one line of terms where the
 * purchase's steps are said.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PacksContent(state: StoreUiState, actions: StoreActions, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    val language = screenLanguage()
    val storeName = brandString(R.string.store_name)
    val item = state.item
    val step = state.step
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = Space.gutter, end = Space.gutter, bottom = PacksLayout.bottom),
    ) {
        if (step is PurchaseStep.Done && step.kind == PurchaseKind.Consumable) {
            val pack = state.catalogue?.pack(step.target)
            val what = pack?.let { brandPlural(it.item.quantity(), it.quantity, Numerals.format(it.quantity, language)) }
            Text(
                if (what != null) brandString(R.string.packs_done, what) else brandString(R.string.paywall_done_action),
                style = t.type.h2,
                color = t.colors.text,
                modifier = Modifier.semantics { heading() },
            )
            Spacer(Modifier.height(PacksLayout.aboveButton))
            PrimaryButton(brandString(R.string.paywall_done_action), { actions.stepShown(); actions.close() })
            return@Column
        }
        val catalogue = state.catalogue
        val switchable = item in SWITCHED && (catalogue == null || SWITCHED.all { catalogue.packsFor(it).isNotEmpty() })
        if (switchable) {
            SegmentedControl(
                options = listOf(brandString(R.string.packs_tab_superlike), brandString(R.string.packs_tab_boost)),
                selected = SWITCHED.indexOf(item),
                onSelect = { actions.selectItem(SWITCHED[it]) },
                enabled = !state.busy,
            )
            Spacer(Modifier.height(PacksLayout.underTabs))
        }
        // The balance moves under the title when both no longer fit one line (large text), instead of being squeezed.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PacksLayout.titleGap)) {
            Text(brandString(item.packsTitle()), style = t.type.h2, color = t.colors.text, modifier = Modifier.alignByBaseline().semantics { heading() })
            state.entitlements?.wallet?.count(item)?.takeIf { it > 0 }?.let { held ->
                Text(
                    brandPlural(R.plurals.packs_balance, held, Numerals.format(held, language)),
                    style = t.type.bodySm,
                    color = t.colors.text3,
                    modifier = Modifier.alignByBaseline(),
                )
            }
        }
        Spacer(Modifier.height(PacksLayout.cardsTop))
        when (val load = state.load) {
            StoreLoad.Loading -> LoadingPacks()
            is StoreLoad.Unavailable -> {
                val message = brandString(load.reason.message(), storeName)
                when (load.reason) {
                    PurchaseFailure.STORE_MISSING -> EmptyState(message, action = brandString(R.string.paywall_store_missing_action, storeName), onAction = actions::installStore)
                    PurchaseFailure.STORE_NOT_READY -> EmptyState(message, action = brandString(R.string.paywall_store_not_ready_action, storeName), onAction = actions::openStore)
                    else -> EmptyState(message, action = brandString(R.string.action_try_again), onAction = actions::retry)
                }
            }
            StoreLoad.Offline -> EmptyState(brandString(R.string.error_offline), action = brandString(R.string.action_try_again), onAction = actions::retry)
            StoreLoad.Failed -> EmptyState(brandString(R.string.error_generic), action = brandString(R.string.action_try_again), onAction = actions::retry)
            is StoreLoad.Ready -> {
                val packs = load.catalogue.packsFor(item)
                if (packs.isEmpty()) {
                    EmptyState(brandString(R.string.packs_none), action = brandString(R.string.action_try_again), onAction = actions::retry)
                } else {
                    Packs(packs, state, language, actions)
                }
            }
        }
    }
}

@Composable
private fun Packs(packs: List<PackOption>, state: StoreUiState, language: AppLanguage, actions: StoreActions) {
    val currency = brandString(R.string.paywall_currency)
    val storeName = brandString(R.string.store_name)
    val chosen = packs.firstOrNull { it.key == state.selectedPack } ?: packs.startPack()
    val prices = packs.map { pack ->
        val price = StorePrices.display(pack.product, language, currency)
        if (price.unit == null) isolate(price.full) else price.full
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        // Every price of the sheet at one size: the largest at which the widest fits its card.
        val priceFit = packPriceFit(prices, maxWidth, PACKS_PER_ROW, PacksLayout.cardGap)
        Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(PacksLayout.cardGap)) {
            packs.zip(prices).chunked(PACKS_PER_ROW).forEach { row ->
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(PacksLayout.cardGap)) {
                    row.forEach { (pack, price) ->
                        val what = brandPlural(pack.item.quantity(), pack.quantity, Numerals.format(pack.quantity, language))
                        PackCard(
                            PackChoice(
                                id = pack.key,
                                count = Numerals.format(pack.quantity, language),
                                price = price,
                                description = brandString(R.string.packs_buy_a11y, what, StorePrices.display(pack.product, language, currency).full),
                            ),
                            selected = pack.key == chosen?.key,
                            onClick = { actions.selectPack(pack.key) },
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                            priceFit = priceFit,
                            enabled = !state.busy,
                        )
                    }
                    repeat(PACKS_PER_ROW - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
    Spacer(Modifier.height(PacksLayout.aboveButton))
    if (chosen != null) {
        val price = StorePrices.display(chosen.product, language, currency)
        val step = state.step
        // The purchase under way keeps its button in the accent, at work.
        val working = state.busy && step.target == chosen.key
        // «{price} Toman’a satın al» fits a toman price only; any other is said without a suffix.
        val label = if (StorePrices.toman(chosen.price) != null) R.string.packs_buy else R.string.packs_buy_store_price
        PrimaryButton(
            brandString(label, if (price.unit == null) isolate(price.full) else price.full),
            { actions.buy(chosen.key) },
            enabled = working || (!state.busy && step !is PurchaseStep.Pending && step !is PurchaseStep.Queued),
            loading = working,
        )
    }
    Spacer(Modifier.height(PacksLayout.underButton))
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        StatusLine(state, storeName, actions, fallback = brandString(R.string.packs_terms), plans = false)
    }
}

/** Three pack shapes while the catalogue is read. */
@Composable
private fun LoadingPacks() {
    val t = AppTheme.template
    val loading = stringResource(R.string.ui_loading)
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = loading },
        horizontalArrangement = Arrangement.spacedBy(PacksLayout.cardGap),
    ) {
        repeat(PACKS_PER_ROW) { Box(Modifier.weight(1f).height(PacksLayout.skeletonCard).skeleton(RoundedCornerShape(t.radii.card))) }
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
