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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
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
) {
    val selected = plans.indexOfFirst { it.id == selectedId }.coerceAtLeast(0)
    when {
        plans.size <= 1 -> Unit
        plans.size <= 3 -> SegmentedControl(
            options = plans.map { it.name },
            selected = selected,
            onSelect = { onSelect(plans[it].id) },
            modifier = modifier.padding(contentPadding),
        )
        else -> {
            val list = rememberLazyListState()
            LaunchedEffect(selected) { list.animateScrollToItem(selected) }
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
                    PlanCard(plan, index == selected, { onSelect(plan.id) }, Modifier.width(132.dp))
                }
            }
        }
    }
}

/**
 * A plan card (132 dp wide, 92 dp at least, `--r-card`): the radio at the
 * top-start corner, the name (`--type-body-strong`, up to two lines) under
 * it; chosen, the one selected treatment.
 */
@Composable
fun PlanCard(
    plan: PlanOption,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    Column(
        modifier
            .heightIn(min = 92.dp)
            .clip(shape)
            .then(if (selected) Modifier.choiceFrame(true, shape) else Modifier.templateCard(shape))
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AppRadio(selected)
            if (plan.tag != null) Pill(plan.tag)
        }
        WholeWordsText(plan.name, style = t.type.bodyStrong.copy(color = t.colors.text), maxLines = 2)
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
 * at the end; chosen, the one selected treatment.
 */
@Composable
fun PeriodRow(period: PeriodOption, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.option)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clip(shape)
            .then(if (selected) Modifier.choiceFrame(true, shape) else Modifier.templateCard(shape))
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = if (selected) 14.dp else 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AppRadio(selected)
        Text(period.title, style = t.type.bodyStrong, color = t.colors.text)
        if (period.saving != null) Text(period.saving, style = t.type.captionStrong, color = t.colors.primary)
        Spacer(Modifier.weight(1f))
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(period.total, style = t.type.h3, color = t.colors.text, maxLines = 1, softWrap = false)
            Text(period.unit, style = t.type.caption, color = t.colors.text3, maxLines = 1, softWrap = false)
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
