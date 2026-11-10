package app.core.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.semantics.heading
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.Numerals
import app.core.i18n.screenLanguage
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space

/** What ends a settings row. */
sealed interface RowEnd {
    /** A chevron pointing to the end (it opens something). */
    data object Chevron : RowEnd

    /** A switch, toggled by the whole row. */
    data class Switch(val checked: Boolean, val onChange: (Boolean) -> Unit) : RowEnd

    data object None : RowEnd
}

/**
 * A group of rows (settings, own profile): a card in `--surface-1` with
 * `--card-shadow`, 16 dp inside; rows inside are split by `--line`.
 */
@Composable
fun SettingsGroup(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(AppTheme.template.radii.card)
    Column(modifier.fillMaxWidth().templateCard(shape).padding(horizontal = 16.dp), content = content)
}

/** A plain section label above a group (`--type-section`, `--text-3`), with an optional [end] text. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, end: String? = null) {
    val t = AppTheme.template
    Row(modifier.fillMaxWidth().semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = t.type.section, color = t.colors.text3, modifier = Modifier.weight(1f))
        if (end != null) Text(end, style = t.type.section, color = t.colors.text3)
    }
}

/**
 * A row in a group (56 dp at least): the title (`--type-body-strong`, up to
 * [titleLines] lines) with an optional small [overline] above it and
 * subtitle (`--type-body-sm`, `--text-3`) or [below] content under it, a
 * value (`--text-2`) and a chevron or a switch at the end; [danger] draws the
 * title in `--error`. [divider] draws the `--line` hairline above it
 * (between rows, never above the first). No icon tile.
 *
 * The title keeps its own width: a long value (a job, several choices, an
 * address) gives way and ends in an ellipsis, so the title and the chevron
 * are always there, at any font scale.
 */
@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    value: String? = null,
    end: RowEnd = RowEnd.Chevron,
    danger: Boolean = false,
    divider: Boolean = false,
    minHeight: Dp = Space.listRowMin,
    overline: String? = null,
    titleLines: Int = Int.MAX_VALUE,
    enabled: Boolean = true,
    below: (@Composable () -> Unit)? = null,
    /** The title or value is the person's own words: each takes the direction of its text (a Persian answer in an English page). */
    ownWords: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val t = AppTheme.template
    val words = if (ownWords) TextDirection.Content else TextDirection.Unspecified
    val click = when {
        end is RowEnd.Switch -> Modifier.toggleable(value = end.checked, enabled = enabled, role = Role.Switch, onValueChange = end.onChange)
        onClick != null -> Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        else -> Modifier
    }
    Column(modifier.fillMaxWidth()) {
        if (divider) HorizontalDivider(thickness = 1.dp, color = t.colors.line)
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = minHeight).then(click).padding(vertical = ROW_PAD),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ROW_GAP),
        ) {
            TitleAndValue(Modifier.weight(1f), value, words) {
                Column {
                    if (overline != null) Text(overline, style = t.type.bodySm, color = t.colors.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        title,
                        style = t.type.bodyStrong.copy(textDirection = words),
                        color = if (danger) t.colors.error else t.colors.text,
                        maxLines = titleLines,
                        overflow = TextOverflow.Ellipsis,
                        modifier = if (overline != null) Modifier.padding(top = OVERLINE_GAP) else Modifier,
                    )
                    if (subtitle != null) Text(subtitle, style = t.type.bodySm, color = t.colors.text3)
                    below?.invoke()
                }
            }
            when (end) {
                RowEnd.Chevron -> Icon(AppIcons.ChevronEnd, contentDescription = null, tint = t.colors.text3, modifier = Modifier.size(CHEVRON))
                is RowEnd.Switch -> AppSwitch(end.checked, onCheckedChange = null, enabled = enabled)
                RowEnd.None -> Unit
            }
        }
    }
}

/**
 * The title (first) and the value (second, when there is one) side by side:
 * the title takes the width it wants and the value what is left, ending in
 * an ellipsis; the value keeps at least [VALUE_FLOOR] (or less, if it needs
 * less) and the title never less than its longest word.
 */
@Composable
private fun TitleAndValue(modifier: Modifier, value: String?, direction: TextDirection, title: @Composable () -> Unit) {
    val t = AppTheme.template
    Layout(
        modifier = modifier,
        content = {
            title()
            if (value != null) Text(value, style = t.type.bodySm.copy(textDirection = direction), color = t.colors.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
    ) { measurables, constraints ->
        val width = constraints.maxWidth
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        if (measurables.size < 2) {
            val only = measurables.single().measure(loose.copy(minWidth = width, maxWidth = width))
            return@Layout layout(width, only.height) { only.placeRelative(0, 0) }
        }
        val (titleM, valueM) = measurables
        val gap = ROW_GAP.roundToPx()
        val valueWant = valueM.maxIntrinsicWidth(Constraints.Infinity)
        val titleWant = titleM.maxIntrinsicWidth(Constraints.Infinity)
        val titleLeast = titleM.minIntrinsicWidth(Constraints.Infinity)
        val floor = minOf(valueWant, VALUE_FLOOR.roundToPx())
        val titleWidth = when {
            titleWant + gap + valueWant <= width -> width - gap - valueWant
            else -> maxOf(titleLeast, minOf(titleWant, width - gap - floor))
        }.coerceIn(0, width)
        val valueWidth = (width - gap - titleWidth).coerceAtLeast(0)
        val titleP = titleM.measure(loose.copy(minWidth = titleWidth, maxWidth = titleWidth))
        val valueP = valueM.measure(loose.copy(minWidth = 0, maxWidth = valueWidth))
        val height = maxOf(titleP.height, valueP.height)
        layout(width, height) {
            titleP.placeRelative(0, (height - titleP.height) / 2)
            if (valueWidth > 0) valueP.placeRelative(width - valueP.width, (height - valueP.height) / 2)
        }
    }
}

private val VALUE_FLOOR = 56.dp
private val ROW_PAD = 8.dp
private val ROW_GAP = 12.dp
private val OVERLINE_GAP = 1.dp
private val CHEVRON = 20.dp

/**
 * A conversation in the list (76 dp): the 54 dp avatar with the online dot,
 * the name (`--type-h3`) with the verified badge, the last message
 * (`--type-body-sm`: `--text-3`, `--text` while unread, «داره می‌نویسه…» in
 * `--primary`), and at the end the time over the unread count. [divider]
 * draws the `--line` hairline above the row from the text's start (between
 * rows, never above the first). [muted] puts a quiet `--text-3` count in
 * place of the coloured one. TalkBack reads the row as [description] when
 * given (one sentence), else its texts.
 */
@Composable
fun ConversationRow(
    name: String,
    preview: String,
    time: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    verified: Boolean = false,
    online: Boolean = false,
    typing: Boolean = false,
    unread: Int = 0,
    unreadText: String? = null,
    muted: Boolean = false,
    divider: Boolean = false,
    description: String? = null,
    photo: (@Composable BoxScope.() -> Unit)? = null,
) {
    val t = AppTheme.template
    val language = screenLanguage()
    val unreadLabel = if (unread > 0) stringResource(R.string.ui_unread, Numerals.format(unread, language)) else null
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = Space.conversationRow)
            .drawBehind {
                if (divider) {
                    val start = (CONVERSATION_AVATAR + CONVERSATION_GAP).toPx()
                    val x0 = if (layoutDirection == androidx.compose.ui.unit.LayoutDirection.Rtl) 0f else start
                    drawRect(t.colors.line, topLeft = androidx.compose.ui.geometry.Offset(x0, 0f), size = androidx.compose.ui.geometry.Size(size.width - start, 1.dp.toPx()))
                }
            }
            .clickable(role = Role.Button, onClick = onClick)
            .then(
                if (description != null) {
                    Modifier.clearAndSetSemantics {
                        contentDescription = description
                        role = Role.Button
                        onClick { onClick(); true }
                    }
                } else {
                    Modifier.semantics(mergeDescendants = true) {}
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(CONVERSATION_GAP),
    ) {
        Avatar(CONVERSATION_AVATAR, online = online, photo = photo)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(name, style = t.type.h3, color = t.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (verified) VerifiedBadge(16.dp)
            }
            Text(
                preview,
                style = t.type.bodySm,
                color = when {
                    typing -> t.colors.primary
                    unread > 0 -> t.colors.text
                    else -> t.colors.text3
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(time, style = t.type.caption, color = t.colors.text3, maxLines = 1)
            when {
                // Muted: a quiet grey count that still reads.
                unread > 0 && muted -> CountBadge(
                    unreadText ?: Numerals.format(unread, language),
                    Modifier.semantics { this.contentDescription = unreadLabel.orEmpty() },
                    fill = androidx.compose.ui.graphics.SolidColor(t.colors.surface3),
                    contentColor = t.colors.text2,
                )
                unread > 0 -> UnreadCount(unreadText ?: Numerals.format(unread, language), Modifier.semantics { this.contentDescription = unreadLabel.orEmpty() })
                else -> Spacer(Modifier.height(22.dp))
            }
        }
    }
}

/** The list's avatar and its gap to the text: the divider starts after them. */
private val CONVERSATION_AVATAR = 54.dp
private val CONVERSATION_GAP = 14.dp
