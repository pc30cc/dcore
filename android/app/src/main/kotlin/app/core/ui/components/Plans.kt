package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.first
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.unit.sp
import app.core.ui.theme.AppTheme

/**
 * One plan as the server sends it: everything a card shows is data, so the
 * admin panel can add, rename and reorder plans without a release. Cards
 * carry the name only; the price is on the period rows and the button.
 */
data class PlanOption(
    val id: String,
    val name: String,
    /** A tag on the card («پیشنهاد ما»), when the server sends one. */
    val tag: String? = null,
)

/**
 * The plan chooser for any number of plans: one plan needs no chooser (this
 * draws nothing), two or three are a [SegmentedControl], four or more a
 * rail of [PlanCard]s that runs off the screen edge with the chosen one
 * scrolled into view.
 */
@Composable
fun PlanSelector(
    plans: List<PlanOption>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
    enabled: Boolean = true,
) {
    val selected = plans.indexOfFirst { it.id == selectedId }.coerceAtLeast(0)
    when {
        plans.size <= 1 -> Unit
        plans.size <= 3 -> SegmentedControl(
            options = plans.map { it.name },
            selected = selected,
            onSelect = { onSelect(plans[it].id) },
            modifier = modifier.padding(contentPadding),
            enabled = enabled,
        )
        else -> {
            val list = rememberLazyListState()
            // The chosen card is brought into view only when it is not wholly in view already.
            LaunchedEffect(selected) {
                val info = snapshotFlow { list.layoutInfo }.first { it.visibleItemsInfo.isNotEmpty() }
                val card = info.visibleItemsInfo.firstOrNull { it.index == selected }
                val whole = card != null && card.offset >= info.viewportStartOffset && card.offset + card.size <= info.viewportEndOffset
                if (!whole) list.animateScrollToItem(selected)
            }
            LazyRow(
                state = list,
                contentPadding = PaddingValues(
                    start = contentPadding.calculateLeftPadding(LayoutDirection.Ltr),
                    end = contentPadding.calculateRightPadding(LayoutDirection.Ltr),
                    top = 2.dp,
                    bottom = 2.dp,
                ),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = modifier.fillMaxWidth().selectableGroup(),
            ) {
                itemsIndexed(plans, key = { _, plan -> plan.id }) { index, plan ->
                    PlanCard(plan, index == selected, { onSelect(plan.id) }, Modifier.width(132.dp), enabled = enabled)
                }
            }
        }
    }
}

/**
 * A plan card (132 dp wide, 92 dp at least, `--r-card`): the radio at the
 * top-start corner, the name (`--type-body-strong`, up to two lines) under
 * it; chosen, the one selected treatment. Not [enabled] (a purchase under
 * way), it cannot be chosen.
 */
@Composable
fun PlanCard(
    plan: PlanOption,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    Column(
        modifier
            .heightIn(min = 92.dp)
            .clip(shape)
            .then(if (selected) Modifier.choiceFrame(true, shape) else Modifier.templateCard(shape))
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AppRadio(selected)
            if (plan.tag != null) Pill(plan.tag)
        }
        // Two lines held for every name, so the cards of a rail stand equally tall.
        WholeWordsText(plan.name, style = t.type.bodyStrong.copy(color = t.colors.text), maxLines = 2, minLines = 2)
    }
}

/** What a plan gives, one line each after a 6 dp `--primary` dot (`--type-body-strong`); no icons. */
@Composable
fun BenefitList(benefits: List<String>, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (benefit in benefits) {
            Row(Modifier.heightIn(min = 34.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(6.dp).background(t.colors.primary, CircleShape))
                Text(benefit, style = t.type.bodyStrong, color = t.colors.text)
            }
        }
    }
}

/** One subscription period, always a full-width row (any number of them). */
data class PeriodOption(
    val id: String,
    /** «۱۲ ماهه» */
    val title: String,
    /** «۱٬۲۰۰٬۰۰۰» */
    val total: String,
    /** «تومان» */
    val unit: String,
    /** «۴۴٪ کمتر» */
    val saving: String? = null,
)

/**
 * A period row (64 dp, `--r-option`): the radio at the start, the title
 * (`--type-body-strong`) and the saving (`--type-caption-strong`,
 * `--primary`), the total (`--type-h3`) and its currency word (`--text-3`)
 * on one baseline at the end; chosen, the one selected treatment. The price
 * is measured first and never cut (see [PeriodLine]); [stacked] puts it
 * under the title, for every row of a group alike ([periodsStacked]). Not
 * [enabled] (a purchase under way), it cannot be chosen.
 */
@Composable
fun PeriodRow(period: PeriodOption, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, stacked: Boolean = false) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.option)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clip(shape)
            .then(if (selected) Modifier.choiceFrame(true, shape) else Modifier.templateCard(shape))
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = if (selected) PERIOD_PADDING - 2.dp else PERIOD_PADDING, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(PERIOD_GAP),
    ) {
        AppRadio(selected)
        PeriodLine(
            title = { Text(period.title, style = t.type.bodyStrong, color = t.colors.text) },
            saving = period.saving?.let { saving -> { Text(saving, style = t.type.captionStrong, color = t.colors.primary) } },
            price = {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(period.total, style = t.type.h3, color = t.colors.text, maxLines = 1, softWrap = false, modifier = Modifier.alignByBaseline())
                    if (period.unit.isNotBlank()) {
                        Text(period.unit, style = t.type.caption, color = t.colors.text3, maxLines = 1, softWrap = false, modifier = Modifier.alignByBaseline())
                    }
                }
            },
            modifier = Modifier.weight(1f),
            stacked = stacked,
        )
    }
}

private val PERIOD_PADDING = 16.dp
private val PERIOD_GAP = 12.dp
private val PERIOD_RADIO = 24.dp

/**
 * Whether the rows of [periods], [rowWidth] wide, put their prices under
 * their titles: when any one cannot keep its price beside its title and
 * saving (with the saving under the title), all of them do, so the prices
 * of one list stand in one column.
 */
@Composable
fun periodsStacked(periods: List<PeriodOption>, rowWidth: Dp): Boolean {
    val t = AppTheme.template
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    return remember(periods, rowWidth, t.type, density) {
        with(density) {
            val room = (rowWidth - PERIOD_PADDING * 2 - PERIOD_RADIO - PERIOD_GAP).toPx()
            val gap = PERIOD_GAP.toPx()
            fun width(text: String, style: androidx.compose.ui.text.TextStyle) = measurer.measure(text, style, maxLines = 1, softWrap = false).size.width
            periods.any { p ->
                val start = maxOf(width(p.title, t.type.bodyStrong), p.saving?.let { width(it, t.type.captionStrong) } ?: 0)
                val price = width(p.total, t.type.h3) + if (p.unit.isNotBlank()) 4.dp.toPx() + width(p.unit, t.type.caption) else 0f
                start + gap + price > room
            }
        }
    }
}

/**
 * A period row's words: the title and the saving at the start, the price at
 * the end, on one line as the design draws them. When they no longer fit (a
 * narrow phone, large text) the price keeps its whole width and the saving
 * moves under the title; [stacked], or when even the longest word beside
 * the price would not fit, the price moves under them. No word and no
 * price is ever cut.
 */
@Composable
private fun PeriodLine(title: @Composable () -> Unit, saving: (@Composable () -> Unit)?, price: @Composable () -> Unit, modifier: Modifier = Modifier, stacked: Boolean = false) {
    Layout(contents = listOf(title, saving ?: {}, price), modifier = modifier) { (titles, savings, prices), constraints ->
        val gap = 12.dp.roundToPx()
        val lineGap = 2.dp.roundToPx()
        val room = constraints.maxWidth
        val titleM = titles.first()
        val savingM = savings.firstOrNull()
        val priceP = prices.first().measure(Constraints(maxWidth = room))
        val longestWord = maxOf(titleM.minIntrinsicWidth(Constraints.Infinity), savingM?.minIntrinsicWidth(Constraints.Infinity) ?: 0)
        val beside = !stacked && longestWord + gap + priceP.width <= room
        val startRoom = if (beside) room - gap - priceP.width else room
        val titleP = titleM.measure(Constraints(maxWidth = startRoom))
        val savingP = savingM?.measure(Constraints(maxWidth = startRoom))
        val inline = savingP != null && titleP.width + gap + savingP.width <= startRoom
        val startHeight = when {
            savingP == null -> titleP.height
            inline -> maxOf(titleP.height, savingP.height)
            else -> titleP.height + lineGap + savingP.height
        }
        val height = if (beside) maxOf(startHeight, priceP.height) else startHeight + lineGap * 2 + priceP.height
        layout(room, height) {
            val top = if (beside) (height - startHeight) / 2 else 0
            when {
                savingP == null -> titleP.placeRelative(0, top)
                inline -> {
                    titleP.placeRelative(0, top + (startHeight - titleP.height) / 2)
                    savingP.placeRelative(titleP.width + gap, top + (startHeight - savingP.height) / 2)
                }
                else -> {
                    titleP.placeRelative(0, top)
                    savingP.placeRelative(0, top + titleP.height + lineGap)
                }
            }
            if (beside) priceP.placeRelative(room - priceP.width, (height - priceP.height) / 2) else priceP.placeRelative(0, startHeight + lineGap * 2)
        }
    }
}

/** One pack of a consumable: what it holds and its price, as the store writes it. */
data class PackChoice(
    val id: String,
    /** «۱۵» */
    val count: String,
    /** «۲۱۰٬۰۰۰ تومان» */
    val price: String,
    /** What TalkBack reads for the card: «۱۵ سوپرلایک، ۲۱۰٬۰۰۰ تومان». */
    val description: String,
)

/**
 * A pack card (`--r-card`): the radio at the top-start corner, the count
 * (`--type-number`) and the price (`--type-body-strong`, `--text-2`)
 * centred under it; chosen, the one selected treatment. Cards share a row
 * equally ([modifier] carries the weight). [priceFit] is the one size
 * every price of the row is drawn at ([packPriceFit]); without it, the
 * price steps its own size down to fit. Not [enabled] (a purchase under
 * way), it cannot be chosen.
 */
@Composable
fun PackCard(
    pack: PackChoice,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    priceFit: PackPriceFit? = null,
    enabled: Boolean = true,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    Box(
        modifier
            .clip(shape)
            .then(if (selected) Modifier.choiceFrame(true, shape) else Modifier.templateCard(shape))
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = pack.description }
            .padding(PACK_PADDING),
    ) {
        AppRadio(selected, size = PACK_RADIO)
        Column(
            Modifier.fillMaxWidth().padding(top = PACK_CONTENT_TOP),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(pack.count, style = t.type.number, color = t.colors.text, maxLines = 1, modifier = Modifier.clearAndSetSemantics { })
            val price = t.type.bodyStrong.copy(color = t.colors.text2)
            if (priceFit != null) {
                Text(
                    pack.price,
                    style = price.copy(fontSize = priceFit.size, textAlign = TextAlign.Center),
                    maxLines = if (priceFit.oneLine) 1 else 2,
                    softWrap = !priceFit.oneLine,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().clearAndSetSemantics { },
                )
            } else {
                OneLineText(pack.price, style = price, modifier = Modifier.fillMaxWidth().clearAndSetSemantics { })
            }
        }
    }
}

private val PACK_PADDING = 12.dp
private val PACK_RADIO = 22.dp

/** The one size every price of a row of [PackCard]s is drawn at, and whether each fits on one line at it. */
data class PackPriceFit(val size: TextUnit, val oneLine: Boolean)

/**
 * The one size the prices of a row of [PackCard]s share, so sibling cards
 * never show them in different sizes: `--type-body-strong` when every one
 * fits a card of [rowWidth] (cards [perRow] to a row, [gap] apart), else the
 * largest size, stepping down to 11 sp, at which all fit on one line. With
 * text so large that even that does not, the prices take two lines at the
 * largest size at which their longest word fits, instead of being cut.
 */
@Composable
fun packPriceFit(prices: List<String>, rowWidth: Dp, perRow: Int, gap: Dp): PackPriceFit {
    val t = AppTheme.template
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val style = t.type.bodyStrong
    return remember(prices, rowWidth, perRow, gap, style, density) {
        val inner = with(density) { ((rowWidth - gap * (perRow - 1)) / perRow - PACK_PADDING * 2).toPx() }
        fun widest(texts: List<String>, size: Float) =
            texts.maxOfOrNull { measurer.measure(it, style.copy(fontSize = size.sp), maxLines = 1, softWrap = false).size.width } ?: 0
        fun largest(texts: List<String>): Float? {
            var size = style.fontSize.value
            while (size >= MIN_FIT_SP) {
                if (widest(texts, size) <= inner) return size
                size -= FIT_STEP_SP
            }
            return null
        }
        largest(prices)?.let { PackPriceFit(it.sp, oneLine = true) }
            ?: PackPriceFit((largest(prices.flatMap { it.split(' ') }) ?: MIN_FIT_SP).sp, oneLine = false)
    }
}
/** The count starts 44 dp from the card's top edge: under the radio's row. */
private val PACK_CONTENT_TOP = 32.dp

/**
 * One line that steps its size down (to 11 sp at least) until it fits the
 * width it has: a price in a narrow card («210,000 Toman») stays whole
 * instead of being cut.
 */
@Composable
fun OneLineText(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier) {
    androidx.compose.foundation.text.BasicText(
        text,
        modifier = modifier,
        style = style.copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center),
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Ellipsis,
        autoSize = androidx.compose.foundation.text.TextAutoSize.StepBased(minFontSize = MIN_FIT_SP.sp, maxFontSize = style.fontSize, stepSize = FIT_STEP_SP.sp),
    )
}

private const val MIN_FIT_SP = 11f
private const val FIT_STEP_SP = 0.5f

/**
 * Text that never breaks inside a word: when its longest word is wider than
 * the space, the size steps down (to 12 sp at least) until it fits; past
 * [maxLines] it ends in an ellipsis. Server-sent names ("Premium") in narrow
 * cards would otherwise wrap as "Premiu / m".
 */
@Composable
fun WholeWordsText(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier, maxLines: Int = 2, minLines: Int = 1) {
    val measurer = androidx.compose.ui.text.rememberTextMeasurer()
    androidx.compose.foundation.layout.BoxWithConstraints(modifier) {
        val available = constraints.maxWidth
        val longest = text.split(' ').filter { it.isNotEmpty() }.maxOfOrNull { word ->
            measurer.measure(word, style, maxLines = 1, softWrap = false).size.width
        } ?: 0
        val base = style.fontSize.value
        val scaled = if (longest > available && longest > 0) maxOf(12f, base * available / longest) else base
        Text(
            text,
            style = style.copy(fontSize = scaled.sp, lineHeight = if (style.lineHeight.isSpecified) style.lineHeight * (scaled / base) else style.lineHeight),
            maxLines = maxLines,
            minLines = minLines.coerceAtMost(maxLines),
            overflow = TextOverflow.Ellipsis,
        )
    }
}
