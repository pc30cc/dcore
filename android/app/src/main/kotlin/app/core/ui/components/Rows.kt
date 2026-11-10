package app.core.ui.components

import androidx.compose.foundation.clickable
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
import androidx.compose.ui.semantics.heading
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
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
 * A row in a group (56 dp at least): the title (`--type-body-strong`) and an
 * optional subtitle (`--type-body-sm`, `--text-3`), a value (`--text-2`)
 * and a chevron or a switch at the end; [danger] draws the title in
 * `--error`. [divider] draws the `--line` hairline above it (between rows,
 * never above the first). No icon tile.
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
    onClick: (() -> Unit)? = null,
) {
    val t = AppTheme.template
    val click = when {
        end is RowEnd.Switch -> Modifier.toggleable(value = end.checked, role = Role.Switch, onValueChange = end.onChange)
        onClick != null -> Modifier.clickable(role = Role.Button, onClick = onClick)
        else -> Modifier
    }
    Column(modifier.fillMaxWidth()) {
        if (divider) HorizontalDivider(thickness = 1.dp, color = t.colors.line)
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = minHeight).then(click).padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = t.type.bodyStrong, color = if (danger) t.colors.error else t.colors.text)
                if (subtitle != null) Text(subtitle, style = t.type.bodySm, color = t.colors.text3)
            }
            if (value != null) Text(value, style = t.type.bodySm, color = t.colors.text2, maxLines = 1)
            when (end) {
                RowEnd.Chevron -> Icon(AppIcons.ChevronEnd, contentDescription = null, tint = t.colors.text3, modifier = Modifier.size(20.dp))
                is RowEnd.Switch -> AppSwitch(end.checked, onCheckedChange = null)
                RowEnd.None -> Unit
            }
        }
    }
}

/**
 * A conversation in the list (76 dp): the avatar (a `--ring-fill` ring for
 * a new match, the online dot), the name with the verified badge, the last
 * message (or «داره می‌نویسه…» in `--primary`), the time, and the unread
 * count or a tint pill («نوبت توئه»).
 */
@Composable
fun ConversationRow(
    name: String,
    preview: String,
    time: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    verified: Boolean = false,
    newMatch: Boolean = false,
    online: Boolean = false,
    typing: Boolean = false,
    unread: Int = 0,
    yourTurn: String? = null,
    photo: (@Composable BoxScope.() -> Unit)? = null,
) {
    val t = AppTheme.template
    val language = screenLanguage()
    val unreadLabel = if (unread > 0) stringResource(R.string.ui_unread, Numerals.format(unread, language)) else null
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = Space.conversationRow)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Avatar(54.dp, newMatch = newMatch, online = online, photo = photo)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(name, style = t.type.bodyStrong.copy(fontWeight = FontWeight.Bold), color = t.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (verified) VerifiedBadge(16.dp)
            }
            Text(preview, style = t.type.bodySm, color = if (typing) t.colors.primary else t.colors.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(time, style = t.type.caption, color = t.colors.text3)
            when {
                unread > 0 -> UnreadCount(Numerals.format(unread, language), Modifier.semantics { this.contentDescription = unreadLabel.orEmpty() })
                yourTurn != null -> Pill(yourTurn, kind = PillKind.Tint)
                else -> Spacer(Modifier.height(22.dp))
            }
        }
    }
}
