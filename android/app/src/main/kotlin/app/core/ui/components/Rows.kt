package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
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
 * A settings row (56 dp at least): a 40 dp tonal icon tile, the title and an
 * optional subtitle, a value, and a chevron or switch at the end. The
 * hairline under it starts under the text, not the icon.
 */
@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    subtitle: String? = null,
    value: String? = null,
    end: RowEnd = RowEnd.Chevron,
    divider: Boolean = true,
    onClick: (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val colors = AppTheme.colors
    val click = when {
        end is RowEnd.Switch -> Modifier.clickable(role = Role.Switch) { end.onChange(!end.checked) }
        onClick != null -> Modifier.clickable(role = Role.Button, onClick = onClick)
        else -> Modifier
    }
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = Space.listRowMin).then(click),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Box(Modifier.size(40.dp).background(scheme.surfaceContainerHigh, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = scheme.onSurface, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Row(Modifier.heightIn(min = Space.listRowMin).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleSmall, color = scheme.onSurface)
                    if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary)
                }
                if (value != null) {
                    Text(value, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal), color = scheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
                }
                when (end) {
                    RowEnd.Chevron -> Icon(AppIcons.ChevronEnd, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp).size(20.dp))
                    is RowEnd.Switch -> GradientSwitch(end.checked, onCheckedChange = null)
                    RowEnd.None -> Unit
                }
            }
            if (divider) HorizontalDivider(thickness = 1.dp, color = scheme.outlineVariant)
        }
    }
}

/**
 * A conversation in the list (76 dp): the avatar (a gradient ring for a new
 * match, the lime dot when online), the name with the verified mark, the
 * last message or «داره می‌نویسه…» in the accent, the time, and either the
 * unread count on the gradient or the lime «نوبت توئه» pill.
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
    val scheme = MaterialTheme.colorScheme
    val colors = AppTheme.colors
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
                Text(name, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold), color = scheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (verified) VerifiedBadge(16.dp)
            }
            Text(
                preview,
                style = MaterialTheme.typography.bodySmall,
                color = if (typing) scheme.primary else colors.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(time, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal), color = colors.textTertiary)
            when {
                unread > 0 -> Box(
                    Modifier
                        .heightIn(min = 22.dp)
                        .background(colors.gradient, CircleShape)
                        .padding(horizontal = 7.dp)
                        .semantics { this.contentDescription = unreadLabel.orEmpty() },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(Numerals.format(unread, language), style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold), color = colors.onGradient)
                }
                yourTurn != null -> AlivePill(yourTurn)
                else -> Spacer(Modifier.height(22.dp))
            }
        }
    }
}

/** A small lime-tinted pill: «نوبت توئه», «تازه». */
@Composable
fun AlivePill(text: String, modifier: Modifier = Modifier) {
    val colors = AppTheme.colors
    Box(
        modifier
            .background(colors.aliveTint.compositeOverSafe(MaterialTheme.colorScheme.background), CircleShape)
            .border(1.dp, colors.aliveLine, CircleShape)
            .padding(horizontal = 10.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold), color = colors.aliveText, maxLines = 1)
    }
}
