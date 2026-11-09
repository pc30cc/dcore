package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.unit.sp
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius

/** A badge on a plan card or period row: popular (violet tint) or alive (lime: best value, new). */
data class PlanBadge(val text: String, val alive: Boolean)

/**
 * One plan as the server sends it: everything a card shows is data, so the
 * admin panel can add, rename and reorder plans without a release.
 */
data class PlanOption(
    val id: String,
    val name: String,
    /** «ماهی از» */
    val priceLead: String,
    /** «۱۰۰٬۰۰۰» */
    val price: String,
    /** «تومان» */
    val unit: String,
    val badge: PlanBadge? = null,
)

/**
 * The plan chooser for any number of plans: one plan needs no chooser (its
 * name heads the benefits instead; this draws nothing), two are a
 * [SegmentedControl], three are equal cards, four or more a rail of cards
 * with the next one peeking and the chosen one scrolled into view.
 */
@Composable
fun PlanSelector(
    plans: List<PlanOption>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
) {
    val selected = plans.indexOfFirst { it.id == selectedId }.coerceAtLeast(0)
    when {
        plans.size <= 1 -> Unit
        plans.size == 2 -> SegmentedControl(
            options = plans.map { it.name },
            selected = selected,
            onSelect = { onSelect(plans[it].id) },
            modifier = modifier.padding(contentPadding),
        )
        plans.size == 3 -> Row(
            modifier.fillMaxWidth().padding(contentPadding).padding(top = 10.dp).selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            plans.forEachIndexed { index, plan ->
                PlanCard(plan, index == selected, { onSelect(plan.id) }, Modifier.weight(1f), height = 96.dp)
            }
        }
        else -> {
            val list = rememberLazyListState()
            LaunchedEffect(selected) { list.animateScrollToItem(selected) }
            Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                LazyRow(
                    state = list,
                    contentPadding = PaddingValues(
                        start = contentPadding.calculateLeftPadding(LayoutDirection.Ltr),
                        end = 64.dp,
                        top = 10.dp,
                    ),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxWidth().endFade(64.dp).selectableGroup(),
                ) {
                    itemsIndexed(plans, key = { _, plan -> plan.id }) { index, plan ->
                        PlanCard(plan, index == selected, { onSelect(plan.id) }, Modifier.width(132.dp), height = 112.dp)
                    }
                }
                PagerDots(plans.size, selected, Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }
}

/** Fades the end edge (the left in Persian) over [width], so a cut card reads as "more this way". */
private fun Modifier.endFade(width: Dp): Modifier =
    graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen).drawWithContent {
        drawContent()
        val w = width.toPx()
        val rtl = layoutDirection == LayoutDirection.Rtl
        val from = if (rtl) 0f else size.width - w
        drawRect(
            Brush.horizontalGradient(
                if (rtl) listOf(Color.Transparent, Color.Black) else listOf(Color.Black, Color.Transparent),
                startX = from,
                endX = from + w,
            ),
            topLeft = androidx.compose.ui.geometry.Offset(from, 0f),
            size = androidx.compose.ui.geometry.Size(w, size.height),
            blendMode = BlendMode.DstIn,
        )
    }

@Composable
private fun PagerDots(count: Int, selected: Int, modifier: Modifier = Modifier) {
    val colors = AppTheme.colors
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (i in 0 until count) {
            val on = i == selected
            Box(
                Modifier
                    .size(if (on) 18.dp else 6.dp, 6.dp)
                    .background(if (on) colors.gradient else Brush.linearGradient(listOf(colors.hairlineStrong, colors.hairlineStrong)), CircleShape),
            )
        }
    }
}

/** A badge sitting on a card's top edge, ringed in the background colour. */
@Composable
private fun EdgeBadge(badge: PlanBadge, modifier: Modifier = Modifier) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val fill = if (badge.alive) colors.alive else scheme.secondaryContainer
    val ink = if (badge.alive) colors.onAlive else scheme.onSecondaryContainer
    Box(
        modifier
            .background(scheme.background, CircleShape)
            .padding(3.dp)
            .background(fill, CircleShape)
            .padding(horizontal = 10.dp, vertical = 1.dp),
    ) {
        Text(badge.text, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold), color = ink, maxLines = 1)
    }
}

/**
 * A plan card: the radio at the top end, the name (up to two lines), «ماهی از»
 * and the price; chosen, a 2 dp gradient ring and a gradient radio.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PlanCard(
    plan: PlanOption,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    height: Dp = 96.dp,
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(Radius.planCard)
    Box(modifier) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(min = height)
                .background(scheme.surfaceContainerLow, shape)
                .then(if (selected) Modifier.border(2.dp, colors.gradient, shape) else Modifier.border(1.dp, colors.hairlineStrong, shape))
                .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(verticalAlignment = Alignment.Top) {
                WholeWordsText(
                    plan.name,
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold, lineHeight = 22.sp, color = scheme.onSurface),
                    maxLines = 2,
                    modifier = Modifier.weight(1f),
                )
                GradientRadio(selected, size = 20.dp)
            }
            Text(plan.priceLead, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal), color = colors.textTertiary)
            // The currency word moves under the price, whole, when the card is too narrow for both.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.Bottom) {
                Text(plan.price, style = AppTheme.type.price.copy(fontSize = 14.sp), color = scheme.onSurface, maxLines = 1, softWrap = false)
                Text(plan.unit, style = AppTheme.type.priceUnit, color = scheme.onSurfaceVariant, maxLines = 1, softWrap = false)
            }
        }
        plan.badge?.let { EdgeBadge(it, Modifier.align(Alignment.TopCenter).offset(y = (-12).dp)) }
    }
}

/** A benefit of a plan: a known icon, or the sparkle for one the app has no icon for. */
data class Benefit(val label: String, val icon: ImageVector = AppIcons.Sparkle)

/** Two columns of benefits (tonal icon tiles and short text); past [max], «+N امکان دیگه». */
@Composable
fun BenefitGrid(benefits: List<Benefit>, more: (Int) -> String, modifier: Modifier = Modifier, max: Int = 6) {
    val scheme = MaterialTheme.colorScheme
    val shown = benefits.take(max)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        shown.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { benefit ->
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(32.dp).background(scheme.surfaceContainerHigh, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                            Icon(benefit.icon, contentDescription = null, tint = scheme.primary, modifier = Modifier.size(18.dp))
                        }
                        Text(benefit.label, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.5.sp, fontWeight = FontWeight.Medium), color = scheme.onSurface)
                    }
                }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
        if (benefits.size > max) {
            Text(more(benefits.size - max), style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Bold), color = scheme.primary)
        }
    }
}

/** One subscription period, always a full-width row (any number of them). */
data class PeriodOption(
    val id: String,
    /** «۱۲ ماهه» */
    val title: String,
    /** «ماهی ۱۰۰٬۰۰۰ تومان» */
    val perMonth: String?,
    /** «۱٬۲۰۰٬۰۰۰» */
    val total: String,
    /** «تومان» */
    val unit: String,
    /** «۴۴٪ کمتر» */
    val saving: String? = null,
    val badge: PlanBadge? = null,
)

/**
 * A period row (58 dp): the radio, the title and saving, the monthly line,
 * the total at the end over its currency word; chosen, a 2 dp gradient
 * ring; best value, a lime badge on the top edge.
 */
@Composable
fun PeriodRow(period: PeriodOption, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(Radius.periodRow)
    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp)
                .background(scheme.surfaceContainerLow, shape)
                .then(if (selected) Modifier.border(2.dp, colors.gradient, shape) else Modifier.border(1.dp, colors.hairlineStrong, shape))
                .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            GradientRadio(selected, size = 22.dp)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(period.title, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold), color = scheme.onSurface)
                    if (period.saving != null) {
                        Text(period.saving, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold), color = scheme.primary)
                    }
                }
                if (period.perMonth != null) {
                    Text(period.perMonth, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal), color = colors.textTertiary)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(period.total, style = AppTheme.type.price, color = scheme.onSurface)
                Text(period.unit, style = AppTheme.type.priceUnit, color = scheme.onSurfaceVariant)
            }
        }
        period.badge?.let {
            val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
            EdgeBadge(it, Modifier.align(Alignment.TopEnd).offset(x = if (rtl) 16.dp else (-16).dp, y = (-12).dp))
        }
    }
}

/**
 * Text that never breaks inside a word: when its longest word is wider than
 * the space, the size steps down (to 12 sp at least) until it fits; past
 * [maxLines] it ends in an ellipsis. Server-sent names ("Premium") in narrow
 * cards would otherwise wrap as "Premiu / m".
 */
@Composable
fun WholeWordsText(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier, maxLines: Int = 2) {
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
            overflow = TextOverflow.Ellipsis,
        )
    }
}
