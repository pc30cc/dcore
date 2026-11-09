package app.core.ui.components

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion

/**
 * Two or three options on a 48 dp pill; the chosen one is the inverse fill.
 * Labels stay on one line with an ellipsis. More than three: use cards
 * (`PlanSelector`'s rail), not this.
 */
@Composable
fun SegmentedControl(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    icons: List<ImageVector?> = emptyList(),
) {
    val scheme = MaterialTheme.colorScheme
    val reduced = LocalReducedMotion.current
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(CircleShape)
            .background(scheme.surfaceContainerHigh, CircleShape),
    ) {
        val count = options.size.coerceAtLeast(1)
        val segment = (maxWidth - 8.dp) / count
        val x by animateDpAsState(segment * selected.coerceIn(0, count - 1), tween(if (reduced) 0 else Motion.MEDIUM_MS, easing = Motion.Standard), label = "segment")
        Box(Modifier.padding(4.dp).offset { IntOffset(x.roundToPx(), 0) }.width(segment).height(40.dp).background(scheme.inverseSurface, CircleShape))
        // Each option is the full 48 dp tall to touch; the chosen pill is drawn 4 dp inside.
        Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 4.dp).selectableGroup()) {
            options.forEachIndexed { index, label ->
                val on = index == selected
                val color = if (on) scheme.inverseOnSurface else scheme.onSurfaceVariant
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .selectable(selected = on, role = Role.Tab, onClick = { onSelect(index) })
                        .padding(horizontal = 10.dp),
                ) {
                    icons.getOrNull(index)?.let { Icon(it, contentDescription = null, tint = color, modifier = Modifier.size(18.dp)) }
                    Text(
                        label,
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (on) FontWeight.Bold else FontWeight.Medium),
                        color = color,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * A switch (52 × 32, a 48 dp target): off, a grey track with an outline
 * ring and a small thumb; on, the gradient with a white thumb at the end.
 */
@Composable
fun GradientSwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val reduced = LocalReducedMotion.current
    val thumb by animateDpAsState(if (checked) 24.dp else 16.dp, tween(if (reduced) 0 else Motion.SHORT_MS), label = "thumb")
    val travel by animateDpAsState(if (checked) 52.dp - 4.dp - 24.dp else 8.dp, tween(if (reduced) 0 else Motion.SHORT_MS, easing = Motion.Standard), label = "travel")
    val toggle = if (onCheckedChange != null) {
        Modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
    } else {
        Modifier
    }
    Box(modifier.minimumInteractiveComponentSize().then(toggle), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(52.dp, 32.dp)
                .clip(CircleShape)
                .then(
                    if (checked) {
                        Modifier.background(colors.gradient, CircleShape)
                    } else {
                        Modifier.background(scheme.surfaceContainerHighest, CircleShape).border(2.dp, scheme.outline, CircleShape)
                    },
                ),
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(
                Modifier
                    .offset { IntOffset(travel.roundToPx(), 0) }
                    .size(thumb)
                    .background(if (checked) Color.White else scheme.outline, CircleShape),
            )
        }
    }
}

/** A selection dot: a ring when off, the gradient with a white check when on (sheets, lists, plan cards). */
@Composable
fun GradientRadio(selected: Boolean, modifier: Modifier = Modifier, size: androidx.compose.ui.unit.Dp = 24.dp) {
    val colors = AppTheme.colors
    if (selected) {
        Box(modifier.size(size).background(colors.gradient, CircleShape), contentAlignment = Alignment.Center) {
            Icon(AppIcons.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.62f))
        }
    } else {
        Box(modifier.size(size).border(2.dp, MaterialTheme.colorScheme.outline, CircleShape))
    }
}

/** The label above a slider: what it sets at the start, its value («۲۲ تا ۳۰») at the end. */
@Composable
fun SliderLabel(label: String, value: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Bold), color = MaterialTheme.colorScheme.onSurface)
    }
}

/** A 4 dp track with the gradient between [from] and [to] (fractions from the start edge). */
@Composable
private fun GradientTrack(from: Float, to: Float, brush: Brush, rest: Color) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    Canvas(Modifier.fillMaxWidth().height(4.dp)) {
        val r = CornerRadius(size.height / 2)
        drawRoundRect(rest, cornerRadius = r)
        val a = if (rtl) size.width * (1f - to) else size.width * from
        val b = if (rtl) size.width * (1f - from) else size.width * to
        if (b > a) drawRoundRect(brush, topLeft = Offset(a, 0f), size = Size(b - a, size.height), cornerRadius = r)
    }
}

@Composable
private fun SliderThumb() {
    val colors = AppTheme.colors
    // On light surfaces a white thumb needs an edge to stand out (3:1 for a control).
    val edge = if (colors.dark) Modifier else Modifier.border(1.5.dp, MaterialTheme.colorScheme.outline, CircleShape)
    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(24.dp).softShadow(CircleShape, 0.45f).background(Color.White, CircleShape).then(edge))
    }
}

/** A slider: the gradient fills from the start (the right in Persian); a 24 dp white thumb, 48 dp to touch. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GradientSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    enabled: Boolean = true,
) {
    val colors = AppTheme.colors
    val rest = MaterialTheme.colorScheme.surfaceContainerHighest
    Slider(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        modifier = modifier,
        valueRange = valueRange,
        steps = steps,
        thumb = { SliderThumb() },
        track = {
            val span = valueRange.endInclusive - valueRange.start
            val fraction = if (span == 0f) 0f else (it.value - valueRange.start) / span
            GradientTrack(0f, fraction, colors.gradient, rest)
        },
    )
}

/** A range slider (two thumbs), the gradient between them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GradientRangeSlider(
    value: ClosedFloatingPointRange<Float>,
    onValueChange: (ClosedFloatingPointRange<Float>) -> Unit,
    modifier: Modifier = Modifier,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    enabled: Boolean = true,
) {
    val colors = AppTheme.colors
    val rest = MaterialTheme.colorScheme.surfaceContainerHighest
    RangeSlider(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        modifier = modifier,
        valueRange = valueRange,
        steps = steps,
        startThumb = { SliderThumb() },
        endThumb = { SliderThumb() },
        track = {
            val span = valueRange.endInclusive - valueRange.start
            val from = if (span == 0f) 0f else (it.activeRangeStart - valueRange.start) / span
            val to = if (span == 0f) 0f else (it.activeRangeEnd - valueRange.start) / span
            GradientTrack(from, to, colors.gradient, rest)
        },
    )
}
