package app.core.ui.components

import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.insetShadow

/**
 * Chips wrap onto whole rows (never clipped at the edge): 8 dp between
 * chips, 12 dp between rows of 44 dp chips (each chip's 48 dp target
 * reaches 2 dp above and below it). [centered] centres each row (the match
 * screen's openers); otherwise rows start at the start. [group] makes the
 * row one group of single choices for TalkBack ("1 of 3").
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipRow(modifier: Modifier = Modifier, centered: Boolean = false, group: Boolean = false, content: @Composable () -> Unit) {
    FlowRow(
        modifier = modifier.then(if (group) Modifier.selectableGroup() else Modifier),
        horizontalArrangement = if (centered) Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally) else Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

/**
 * A choice or filter chip: 44 dp to see in a 48 dp target, `--r-chip`; at
 * rest a 1 dp `--line-strong` edge; selected, the one selected treatment
 * ([choiceFrame]) and a 17 dp check before the label. [count] follows the
 * label in `--text-3` («همه ۱۲»). Never an icon of its own. [kind] is
 * what TalkBack calls it: a checkbox among several choices, a radio button
 * in a single choice, a tab for a filter that switches the list.
 */
@Composable
fun ChoiceChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: String? = null,
    kind: ChoiceKind = ChoiceKind.Multi,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.chip)
    val choose = when (kind) {
        ChoiceKind.Multi -> Modifier.toggleable(value = selected, role = Role.Checkbox, onValueChange = { onClick() })
        ChoiceKind.Single -> Modifier.selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
        ChoiceKind.Tab -> Modifier.selectable(selected = selected, role = Role.Tab, onClick = onClick)
    }
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(shape)
            .then(choose),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .height(44.dp)
                .choiceFrame(selected, shape, restFill = Color.Transparent)
                .padding(horizontal = if (selected) 14.dp else 16.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (selected) Icon(AppIcons.CheckBold, contentDescription = null, tint = t.colors.text, modifier = Modifier.size(17.dp))
            Text(label, style = t.type.labelSm, color = t.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (count != null) Text(count, style = t.type.labelSm, color = t.colors.text3, maxLines = 1)
        }
    }
}

/** What a [ChoiceChip] is to TalkBack. */
enum class ChoiceKind { Multi, Single, Tab }

/**
 * An interest on a profile (44 dp, not tappable). [shared] (you both have
 * it): `--primary-tint` with bold `--primary` text, no edge, no icon;
 * otherwise `--surface-1` with a `--line` hairline.
 */
@Composable
fun InterestChip(label: String, modifier: Modifier = Modifier, shared: Boolean = false) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.chip)
    // The same 48 dp line as a choice chip, so rows of either kind keep 12 dp between them.
    Box(modifier.heightIn(min = 48.dp), contentAlignment = Alignment.Center) {
    Box(
        Modifier
            .height(44.dp)
            .then(
                if (shared) {
                    Modifier.background(t.colors.primaryTint.compositeOver(t.colors.surface1), shape)
                } else {
                    Modifier.background(t.colors.surface1, shape).insetShadow(shape, listOf(hairline(t.colors.line)))
                },
            )
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = if (shared) t.type.chipStrong else t.type.labelSm,
            color = if (shared) t.colors.primary else t.colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
    }
}

/** What a small pill says with its colours. */
enum class PillKind {
    /** «اصلی», «سوپرلایک», «رایگان امروز»: `--tag-fill` with `--on-tag`. */
    Tag,

    /** «اشتراک», «تازه»: `--primary-tint` with `--primary`. */
    Tint,
}

/** A 24 dp pill (taller with larger text, one line, cut short with «…» when it has no room): a tag or a tint pill. */
@Composable
fun Pill(text: String, modifier: Modifier = Modifier, kind: PillKind = PillKind.Tag) {
    val t = AppTheme.template
    val m = when (kind) {
        PillKind.Tag -> Modifier.background(t.paints.tagFill, CircleShape)
        PillKind.Tint -> Modifier.background(t.colors.primaryTint.compositeOverSafe(t.colors.bg), CircleShape)
    }
    Box(modifier.heightIn(min = 24.dp).then(m).padding(horizontal = 10.dp, vertical = 2.dp), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = t.type.captionStrong,
            color = if (kind == PillKind.Tag) t.colors.onTag else t.colors.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A status pill on a photo («در حال بررسی»): `--photo-chip-fill`, a 1 dp `--photo-chip-line`, white text; sized as [Pill]. */
@Composable
fun PhotoPill(text: String, modifier: Modifier = Modifier, backdrop: GlassBackdrop? = null) {
    val t = AppTheme.template
    GlassBox(CircleShape, GlassStyle.photoChip(), modifier.heightIn(min = 24.dp), backdrop) {
        Text(
            text,
            style = t.type.captionStrong,
            color = t.colors.onPhoto,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 2.dp),
        )
    }
}

/** An unread count (22 dp): `--unread-fill` with `--on-unread`. */
@Composable
fun UnreadCount(text: String, modifier: Modifier = Modifier) = CountBadge(text, modifier)

/** The online mark: a plain `--online` dot (10-13 dp), never a chip or a word on a card. */
@Composable
fun OnlineDot(modifier: Modifier = Modifier, size: androidx.compose.ui.unit.Dp = 10.dp) {
    Box(modifier.size(size).background(AppTheme.template.colors.online, CircleShape))
}

/** A 1 dp inset line in [color] (a CSS `inset 0 0 0 1px`). */
internal fun hairline(color: Color) =
    app.core.ui.theme.ShadowLayer(0.dp, 0.dp, 0.dp, 1.dp, color, inset = true)

/** [this] over [background] when translucent. */
internal fun Color.compositeOverSafe(background: Color): Color =
    if (alpha >= 1f) this else compositeOver(background)
