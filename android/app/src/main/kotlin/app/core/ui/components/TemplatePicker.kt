package app.core.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.inset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.template.TemplateRule
import app.core.ui.theme.AppTemplate
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates

/**
 * The template picker (Settings, the first group): «پیش‌فرض» and each
 * offered template this build ships, in the server's order, each a 58 dp
 * swatch drawn from that template's own tokens (page, two text lines, the
 * primary button, the like disc; «پیش‌فرض» is the two split on a
 * diagonal) and under it the radio with the name beside it. When a name
 * and its radio do not fit their column on one line (a long word, a large
 * font scale), the options go one a row instead, the swatch at the start: a
 * name is never cut short, broken inside a word or pushed under its radio.
 *
 * The checked option is the stored [choice], never the template being
 * drawn: a person on `default` sees «پیش‌فرض» checked whichever template
 * that is. A stored choice that is not among the options (no longer
 * offered, or a template a newer build ships) is drawn as the default,
 * which is what the rule then draws, so «پیش‌فرض» is checked.
 */
@Composable
fun TemplatePicker(
    choice: String,
    offered: List<String>,
    onChoose: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    val options = listOf(TemplateRule.DEFAULT) + offered.filter { it in Templates.ids }.distinct()
    val checked = if (choice in options) choice else TemplateRule.DEFAULT
    Column(
        modifier
            .fillMaxWidth()
            .templateCard(shape)
            .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.settings_template), style = t.type.bodyStrong, color = t.colors.text)
        val names = options.map { stringResource(templateName(it)) }
        val measurer = rememberTextMeasurer()
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val gap = PICKER_GAP
            val column = (maxWidth - gap * (options.size - 1)) / options.size
            val density = LocalDensity.current
            val columnPx = with(density) { column.toPx() }
            val radioPx = with(density) { (RADIO + RADIO_GAP).toPx() }
            // Side by side while every name fits beside its radio on one line; else one option a row (a long word, a large font scale).
            val sideBySide = names.all { radioPx + measurer.measure(it, t.type.bodyStrong, maxLines = 1, softWrap = false).size.width <= columnPx }
            if (sideBySide) {
                Row(Modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    options.forEachIndexed { i, id ->
                        TemplateOption(id, names[i], selected = id == checked, onClick = { onChoose(id) }, modifier = Modifier.weight(1f))
                    }
                }
            } else {
                Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(gap)) {
                    options.forEachIndexed { i, id ->
                        TemplateOptionRow(id, names[i], selected = id == checked, onClick = { onChoose(id) })
                    }
                }
            }
        }
    }
}

/** The swatch in its frame: a 2 dp `--primary-ring` when selected, a 1 dp `--line-strong` edge otherwise. */
@Composable
private fun FramedSwatch(id: String, selected: Boolean, modifier: Modifier, swatchHeight: androidx.compose.ui.unit.Dp = SWATCH_HEIGHT) {
    val t = AppTheme.template
    val outer = RoundedCornerShape(t.radii.md)
    Column(
        modifier
            .then(if (selected) Modifier.border(2.dp, t.paints.primaryRing, outer) else Modifier.border(1.dp, t.colors.lineStrong, outer))
            .padding(2.dp),
    ) {
        TemplateSwatch(id, Modifier.fillMaxWidth().height(swatchHeight).clip(RoundedCornerShape(t.radii.sm)))
    }
}

/** One option in a column: the swatch, and under it the radio with the name beside it (the picker checked that they fit). */
@Composable
private fun TemplateOption(id: String, name: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val t = AppTheme.template
    Column(
        modifier
            .clip(RoundedCornerShape(t.radii.md))
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        FramedSwatch(id, selected, Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(RADIO_GAP), verticalAlignment = Alignment.CenterVertically) {
            AppRadio(selected, size = RADIO)
            Text(name, style = t.type.bodyStrong, color = t.colors.text, maxLines = 1, softWrap = false)
        }
    }
}

/**
 * One option a row (when the names do not fit side by side): the radio at
 * the start, as every choice row has it, the name (which may wrap), and a
 * smaller swatch at the end, so the group stays short.
 */
@Composable
private fun TemplateOptionRow(id: String, name: String, selected: Boolean, onClick: () -> Unit) {
    val t = AppTheme.template
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(t.radii.md))
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AppRadio(selected, size = RADIO)
        Text(name, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        FramedSwatch(id, selected, Modifier.width(ROW_SWATCH), swatchHeight = ROW_SWATCH_HEIGHT)
    }
}

/** The name a template goes by in the picker. */
fun templateName(id: String): Int = when (id) {
    Templates.NEON -> R.string.template_neon
    Templates.WHITE -> R.string.template_white
    else -> R.string.template_default
}

/** A template drawn small from its own tokens; `default` is neon and white split on a diagonal. */
@Composable
fun TemplateSwatch(id: String, modifier: Modifier = Modifier) {
    val neon = Templates.of(Templates.NEON)
    val white = Templates.of(Templates.WHITE)
    Canvas(modifier) {
        when (id) {
            Templates.NEON -> miniature(neon)
            Templates.WHITE -> miniature(white)
            else -> {
                miniature(white)
                val split = Path().apply {
                    moveTo(0f, 0f)
                    lineTo(size.width * 0.62f, 0f)
                    lineTo(size.width * 0.38f, size.height)
                    lineTo(0f, size.height)
                    close()
                }
                clipPath(split) { miniature(neon) }
            }
        }
    }
}

/**
 * The page, two text lines at the top end, a hairline across, the like disc
 * at the bottom start and the primary button at the bottom end, physical
 * (like the picture, `assets/templates/<id>.png`: its 58-unit height, the
 * widths as parts of its width).
 */
private fun DrawScope.miniature(t: AppTemplate) {
    val w = size.width
    val h = size.height
    val u = h / 58f
    drawRect(t.colors.bg)
    val end = w * 0.842f
    drawRoundRect(t.colors.text, topLeft = Offset(w * 0.386f, 12f * u), size = Size(end - w * 0.386f, 5f * u), cornerRadius = CornerRadius(2.5f * u))
    drawRoundRect(t.colors.text2, topLeft = Offset(w * 0.545f, 22f * u), size = Size(end - w * 0.545f, 4f * u), cornerRadius = CornerRadius(2f * u))
    drawRect(t.colors.line, topLeft = Offset(w * 0.119f, 32.5f * u), size = Size(w * 0.762f, maxOf(1f, u / 3f)))
    val buttonLeft = w * 0.413f
    val buttonTop = 39f * u
    val buttonH = 12.7f * u
    val buttonR = minOf(t.radii.button.toPx(), buttonH / 2f)
    // Each fill in its own box, so a gradient spans the button and the disc, not the whole swatch.
    inset(left = buttonLeft, top = buttonTop, right = w - end, bottom = h - buttonTop - buttonH) {
        drawRoundRect(t.paints.primaryFill, cornerRadius = CornerRadius(buttonR))
    }
    val disc = 6.5f * u
    val discX = w * 0.223f
    val discY = buttonTop + buttonH / 2f
    inset(left = discX - disc, top = discY - disc, right = w - discX - disc, bottom = h - discY - disc) {
        drawCircle(t.paints.likeFill)
    }
}

private val PICKER_GAP = 12.dp
private val RADIO = 20.dp
private val RADIO_GAP = 8.dp
/** A stacked row's swatch: smaller than the columns' (58 dp high), the design's proportions kept. */
private val ROW_SWATCH = 64.dp
private val ROW_SWATCH_HEIGHT = 40.dp
private val SWATCH_HEIGHT = 58.dp
