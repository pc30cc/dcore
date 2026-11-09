package app.core.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.Radius
import app.core.ui.theme.TabBarTokens
import app.core.ui.theme.brushTint

/** A badge on a tab: a count on lime (new likes), or a pink dot (unread chats). */
sealed interface TabBadge {
    /** [text] is the count as shown («۱۲»); [description] what TalkBack says («۱۲ لایک تازه»). */
    data class Count(val text: String, val description: String) : TabBadge

    /** [description] says what the dot means. */
    data class Dot(val description: String) : TabBadge
}

/** One tab: a line icon at rest, a solid one (filled with the gradient) when chosen. */
data class TabItem(
    val label: String,
    val icon: ImageVector,
    val selectedIcon: ImageVector = icon,
    val badge: TabBadge? = null,
)

/**
 * The floating tab bar: a 66 dp pill inset 12 dp from the sides (place it
 * 20 dp above the bottom; lists under it keep [TabBarTokens.listBottomPadding]
 * free). Over the deck photo ([overPhoto]) it is glass on [backdrop]; over
 * lists it is the opaque fill, so nothing ghosts through. The first tab is at
 * the start (the right in Persian). Labels are 12 sp at least, and the bar
 * grows with the font size instead of clipping.
 */
@Composable
fun FloatingTabBar(
    tabs: List<TabItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    overPhoto: Boolean = false,
    backdrop: GlassBackdrop? = null,
) {
    val colors = AppTheme.colors
    val style = if (overPhoto) GlassStyle.tabBarOverPhoto(colors) else GlassStyle.tabBarOverList(colors)
    val barColor = if (overPhoto) colors.tabBarFillOverPhoto else colors.tabBarFallback
    GlassBox(
        shape = RoundedCornerShape(Radius.tabBar),
        style = style,
        backdrop = if (overPhoto) backdrop else null,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = TabBarTokens.sideInset)
            .heightIn(min = TabBarTokens.height),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(TabBarTokens.padding).selectableGroup(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tabs.forEachIndexed { index, tab ->
                TabCell(tab, index == selected, barColor, Modifier.weight(1f)) { onSelect(index) }
            }
        }
    }
}

@Composable
private fun TabCell(tab: TabItem, selected: Boolean, barColor: Color, modifier: Modifier, onClick: () -> Unit) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val reduced = LocalReducedMotion.current
    val tint = if (colors.dark) Color.White.copy(alpha = 0.10f) else colors.gradientStops.start.copy(alpha = 0.07f)
    val pill by animateColorAsState(if (selected) tint else Color.Transparent, tween(if (reduced) 0 else Motion.MEDIUM_MS, easing = Motion.Standard), label = "tab")
    val badgeText = when (val b = tab.badge) {
        is TabBadge.Count -> b.description
        is TabBadge.Dot -> b.description
        null -> null
    }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
        modifier = modifier
            .heightIn(min = TabBarTokens.height - TabBarTokens.padding * 2)
            .clip(RoundedCornerShape(Radius.tabBar))
            .background(pill)
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
            .semantics { if (badgeText != null) contentDescription = "${tab.label}، $badgeText" }
            .padding(vertical = 6.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            if (selected) {
                Icon(tab.selectedIcon, contentDescription = null, tint = Color.Black, modifier = Modifier.size(24.dp).brushTint(colors.gradient))
            } else {
                Icon(tab.icon, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
            }
            when (val badge = tab.badge) {
                is TabBadge.Count -> Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 14.dp, y = (-8).dp)
                        .background(barColor.copy(alpha = 1f), CircleShape)
                        .padding(2.dp),
                ) {
                    CountBadge(badge.text, containerColor = colors.alive, contentColor = colors.onAlive)
                }
                is TabBadge.Dot -> Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 4.dp, y = (-2).dp)
                        .size(13.dp)
                        .border(2.dp, barColor.copy(alpha = 1f), CircleShape)
                        .padding(2.dp)
                        .background(colors.like, CircleShape),
                )
                null -> Unit
            }
        }
        Text(
            tab.label,
            style = AppTheme.type.tabLabel.copy(fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium),
            color = if (selected) scheme.onSurface else scheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
