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
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.inset
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.outerShadow
import androidx.compose.runtime.getValue

/**
 * Two or three options on a 48 dp `--surface-2` track (`--r-button`); the
 * chosen one is the `--seg-thumb` with `--on-seg-thumb` and `--seg-shadow`,
 * the others `--text-2`. Labels stay on one line with an ellipsis.
 */
@Composable
fun SegmentedControl(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = AppTheme.template
    val reduced = LocalReducedMotion.current
    val shape = RoundedCornerShape(t.radii.button)
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(shape)
            .background(t.colors.surface2, shape),
    ) {
        val count = options.size.coerceAtLeast(1)
        val gap = 4.dp
        val segment = (maxWidth - 8.dp - gap * (count - 1)) / count
        val index = selected.coerceIn(0, count - 1)
        val x by animateDpAsState((segment + gap) * index, tween(if (reduced) 0 else Motion.MEDIUM_MS, easing = Motion.Standard), label = "segment")
        Box(
            Modifier
                .padding(4.dp)
                .offset { IntOffset(x.roundToPx(), 0) }
                .width(segment)
                .height(40.dp)
                .outerShadow(shape, t.shadows.segShadow)
                .background(t.colors.segThumb, shape),
        )
        // Each option is the full 48 dp tall to touch; the chosen thumb is drawn 4 dp inside.
        Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 4.dp).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(gap)) {
            options.forEachIndexed { i, label ->
                val on = i == selected
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .selectable(selected = on, role = Role.Tab, onClick = { onSelect(i) })
                        .padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        style = if (on) t.type.chipStrong else t.type.labelSm,
                        color = if (on) t.colors.onSegThumb else t.colors.text2,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * A switch (52 × 32, a 48 dp target): off, `--switch-off` with a 2 dp
 * `--switch-off-ring` and a 16 dp thumb at the start; on, `--switch-on`
 * with a 24 dp `--switch-thumb` at the end.
 */
@Composable
fun AppSwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val t = AppTheme.template
    val reduced = LocalReducedMotion.current
    val thumb by animateDpAsState(if (checked) 24.dp else 16.dp, tween(if (reduced) 0 else Motion.SHORT_MS), label = "thumb")
    val travel by animateDpAsState(if (checked) 52.dp - 4.dp - 24.dp else 8.dp, tween(if (reduced) 0 else Motion.SHORT_MS, easing = Motion.Standard), label = "travel")
    val toggle = if (onCheckedChange != null) {
        Modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
    } else {
        Modifier
    }
    // The whole 52 × 48 area toggles (the track is 32 dp tall inside it).
    Box(modifier.then(toggle).sizeIn(minWidth = 52.dp, minHeight = 48.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(52.dp, 32.dp)
                .clip(CircleShape)
                .then(
                    if (checked) {
                        Modifier.background(t.paints.switchOn, CircleShape)
                    } else {
                        Modifier.background(t.colors.switchOff, CircleShape).border(2.dp, t.colors.switchOffRing, CircleShape)
                    },
                ),
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(
                Modifier
                    .offset { IntOffset(travel.roundToPx(), 0) }
                    .size(thumb)
                    .background(if (checked) t.colors.switchThumb else t.colors.switchOffRing, CircleShape),
            )
        }
    }
}

/** A radio (24 dp): a 2 dp `--outline` ring, or `--primary-fill` with an `--on-primary` check. */
@Composable
fun AppRadio(selected: Boolean, modifier: Modifier = Modifier, size: Dp = 24.dp) {
    val t = AppTheme.template
    if (selected) {
        Box(modifier.size(size).background(t.paints.primaryFill, CircleShape), contentAlignment = Alignment.Center) {
            Icon(AppIcons.Check, contentDescription = null, tint = t.colors.onPrimary, modifier = Modifier.size(size * 0.62f))
        }
    } else {
        Box(modifier.size(size).border(2.dp, t.colors.outline, CircleShape))
    }
}

/** A checkbox (24 dp, `--r-check`): a 2 dp `--outline` edge, or `--primary-fill` with an `--on-primary` check. */
@Composable
fun AppCheckbox(checked: Boolean, modifier: Modifier = Modifier, size: Dp = 24.dp) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.check)
    if (checked) {
        Box(modifier.size(size).background(t.paints.primaryFill, shape), contentAlignment = Alignment.Center) {
            Icon(AppIcons.Check, contentDescription = null, tint = t.colors.onPrimary, modifier = Modifier.size(size * 0.66f))
        }
    } else {
        Box(modifier.size(size).border(2.dp, t.colors.outline, shape))
    }
}

/**
 * A choice row (60 dp, `--r-option`): the radio (or the checkbox when
 * [multiple]) at the start, the label in `--type-h3`; selected, the one
 * selected treatment. No description, no icon.
 */
@Composable
fun OptionRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    multiple: Boolean = false,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.option)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clip(shape)
            .choiceFrame(selected, shape)
            .then(
                if (multiple) {
                    Modifier.toggleable(value = selected, role = Role.Checkbox, onValueChange = { onClick() })
                } else {
                    Modifier.selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
                },
            )
            .padding(horizontal = if (selected) 16.dp else 18.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (multiple) AppCheckbox(selected) else AppRadio(selected)
        Text(label, style = t.type.h3, color = t.colors.text, modifier = Modifier.weight(1f))
    }
}

/** The label above a slider: what it sets at the start, its value («۲۲ تا ۳۰») at the end. */
@Composable
fun SliderLabel(label: String, value: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        Text(value, style = t.type.bodySm, color = t.colors.text2)
    }
}

/**
 * A 4 dp `--slider-track` with `--slider-fill` between [from] and [to]
 * (fractions from the start edge). The fill is its own box, as in the
 * design: a gradient spans the fill, not the whole track.
 */
@Composable
private fun SliderTrack(from: Float, to: Float, brush: Brush, rest: Color) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    Canvas(Modifier.fillMaxWidth().height(4.dp)) {
        val r = CornerRadius(size.height / 2)
        drawRoundRect(rest, cornerRadius = r)
        val a = if (rtl) size.width * (1f - to) else size.width * from
        val b = if (rtl) size.width * (1f - from) else size.width * to
        // inset() shrinks the draw size, which is what a brush's shader is made for.
        if (b > a) inset(left = a, top = 0f, right = size.width - b, bottom = 0f) { drawRoundRect(brush, cornerRadius = r) }
    }
}

/**
 * The slider's touch thumb is 48 dp, and Material insets a custom track by
 * half of it on each side. The design's track spans the whole width with a
 * 24 dp thumb whose centre reaches both ends, so the slider is measured one
 * thumb wider and centred: the track meets the content edges, and the thumb
 * hangs half over them, as drawn.
 */
private fun Modifier.trackToTheEdges(thumb: Dp): Modifier = layout { measurable, constraints ->
    val extra = thumb.roundToPx()
    val wide = if (constraints.hasBoundedWidth) {
        constraints.copy(minWidth = constraints.minWidth + extra, maxWidth = constraints.maxWidth + extra)
    } else {
        constraints
    }
    val placeable = measurable.measure(wide)
    val width = (placeable.width - extra).coerceAtLeast(0)
    layout(width, placeable.height) { placeable.place(-extra / 2, 0) }
}

/** The slider thumb's touch target. */
private val THUMB_TARGET = 48.dp

/** A 24 dp `--slider-thumb` with `--slider-thumb-shadow`, in a 48 dp target. */
@Composable
private fun SliderThumb() {
    val t = AppTheme.template
    Box(Modifier.size(THUMB_TARGET), contentAlignment = Alignment.Center) {
        Box(Modifier.size(24.dp).outerShadow(CircleShape, t.shadows.sliderThumbShadow).background(t.colors.sliderThumb, CircleShape))
    }
}

/** A slider: `--slider-fill` from the start (the right in Persian), a 24 dp thumb, 48 dp to touch. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    enabled: Boolean = true,
) {
    val t = AppTheme.template
    Slider(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        modifier = modifier.trackToTheEdges(THUMB_TARGET),
        valueRange = valueRange,
        steps = steps,
        thumb = { SliderThumb() },
        track = {
            val span = valueRange.endInclusive - valueRange.start
            val fraction = if (span == 0f) 0f else (it.value - valueRange.start) / span
            SliderTrack(0f, fraction, t.paints.sliderFill, t.colors.sliderTrack)
        },
    )
}

/** A range slider (two thumbs), `--slider-fill` between them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRangeSlider(
    value: ClosedFloatingPointRange<Float>,
    onValueChange: (ClosedFloatingPointRange<Float>) -> Unit,
    modifier: Modifier = Modifier,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    enabled: Boolean = true,
) {
    val t = AppTheme.template
    RangeSlider(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        modifier = modifier.trackToTheEdges(THUMB_TARGET),
        valueRange = valueRange,
        steps = steps,
        startThumb = { SliderThumb() },
        endThumb = { SliderThumb() },
        track = {
            val span = valueRange.endInclusive - valueRange.start
            val from = if (span == 0f) 0f else (it.activeRangeStart - valueRange.start) / span
            val to = if (span == 0f) 0f else (it.activeRangeEnd - valueRange.start) / span
            SliderTrack(from, to, t.paints.sliderFill, t.colors.sliderTrack)
        },
    )
}

/** A 4 dp progress bar (`--progress-track`, `--progress-fill` from the start) at [fraction]. */
@Composable
fun ProgressBar(fraction: Float, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Box(modifier.fillMaxWidth().height(4.dp)) {
        SliderTrack(0f, fraction.coerceIn(0f, 1f), t.paints.progressFill, t.colors.progressTrack)
    }
}
