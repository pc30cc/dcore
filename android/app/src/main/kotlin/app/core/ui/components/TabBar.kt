package app.core.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.core.ui.theme.TabBarStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.brushTint
import androidx.compose.runtime.getValue

/** A badge on a tab: a count (`--badge-fill`, new likes), or a 9 dp `--like` dot (unread chats). */
sealed interface TabBadge {
    /** [text] is the count as shown («۱۲»); [description] what TalkBack says («۱۲ لایک تازه»). */
    data class Count(val text: String, val description: String) : TabBadge

    /** [description] says what the dot means. */
    data class Dot(val description: String) : TabBadge
}

/** One tab: a line icon at rest, a solid one (filled with `--tab-active-icon`) when chosen. */
data class TabItem(
    val label: String,
    val icon: ImageVector,
    val selectedIcon: ImageVector = icon,
    val badge: TabBadge? = null,
)

/**
 * The tab bar, by the template's switch:
 * - floating (neon): a 66 dp pill 12 dp from the sides and 20 dp above the
 *   bottom (plus the system's navigation inset), `--tabbar-fill` with a
 *   hairline and `--tabbar-shadow`; over the deck photo ([overPhoto])
 *   `--tabbar-fill-photo`, blurred over [backdrop] where glass is on;
 * - docked (white): full width at the bottom, `--tabbar-fill` with a
 *   hairline on top, 62 dp plus the gesture area inside it ([safeArea];
 *   null takes the system's navigation inset; `--tabbar-safe` is the
 *   gesture area's height on a phone with gesture navigation).
 * The first tab is at the start (the right in Persian). Lists under a
 * floating bar keep [listBottomPadding] free.
 */
@Composable
fun AppTabBar(
    tabs: List<TabItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    overPhoto: Boolean = false,
    backdrop: GlassBackdrop? = null,
    safeArea: Dp? = null,
) {
    val t = AppTheme.template
    val floating = t.switches.tabBar == TabBarStyle.Floating
    val photo = overPhoto && floating
    val navigation = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val row: @Composable () -> Unit = {
        Row(
            Modifier.fillMaxWidth().heightIn(min = t.sizes.tabbarH).padding(t.sizes.tabbarPad).selectableGroup(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tabs.forEachIndexed { index, tab ->
                TabCell(tab, index == selected, photo, Modifier.weight(1f)) { onSelect(index) }
            }
        }
    }
    if (floating) {
        val shape = RoundedCornerShape(t.sizes.tabbarR)
        val style = if (photo) {
            GlassStyle(t.colors.tabbarFillPhoto, t.colors.tabbarFill, t.sizes.tabbarBlur, t.colors.tabbarLine, t.shadows.tabbarShadow)
        } else {
            GlassStyle(t.colors.tabbarFill, t.colors.tabbarFill, 0.dp, t.colors.tabbarLine, t.shadows.tabbarShadow)
        }
        Box(modifier.fillMaxWidth().padding(start = t.sizes.tabbarInset, end = t.sizes.tabbarInset, bottom = t.sizes.tabbarBottom + (safeArea ?: navigation))) {
            GlassBox(shape, style, Modifier.fillMaxWidth(), if (photo) backdrop else null) { row() }
        }
    } else {
        Column(
            modifier
                .fillMaxWidth()
                .background(t.colors.tabbarFill)
                .drawBehind { drawRect(t.colors.tabbarLine, size = androidx.compose.ui.geometry.Size(size.width, 1.dp.toPx())) }
                .padding(bottom = safeArea ?: navigation),
        ) { row() }
    }
}

/** What a list under the floating bar keeps free at its end (66 + 20 + 16); a docked bar takes its own room. */
val listBottomPadding: Dp
    @Composable get() {
        val t = AppTheme.template
        return if (t.switches.tabBar == TabBarStyle.Floating) t.sizes.tabbarH + t.sizes.tabbarBottom + 16.dp else 16.dp
    }

/** The older name of [AppTabBar]. */
@Composable
fun FloatingTabBar(
    tabs: List<TabItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    overPhoto: Boolean = false,
    backdrop: GlassBackdrop? = null,
) = AppTabBar(tabs, selected, onSelect, modifier, overPhoto, backdrop)

@Composable
private fun TabCell(tab: TabItem, selected: Boolean, overPhoto: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val t = AppTheme.template
    val c = t.colors
    val reduced = LocalReducedMotion.current
    val activeFill = if (overPhoto) c.tabActiveFillPhoto else c.tabActiveFill
    val pill by animateColorAsState(if (selected) activeFill else Color.Transparent, tween(if (reduced) 0 else Motion.MEDIUM_MS, easing = Motion.Standard), label = "tab")
    val labelColor = when {
        selected && overPhoto -> c.tabActiveColorPhoto
        selected -> c.tabActiveColor
        overPhoto -> c.tabColorPhoto
        else -> c.tabColor
    }
    val badgeText = when (val b = tab.badge) {
        is TabBadge.Count -> b.description
        is TabBadge.Dot -> b.description
        null -> null
    }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
        modifier = modifier
            .heightIn(min = t.sizes.tabbarH - t.sizes.tabbarPad * 2)
            .clip(RoundedCornerShape(t.sizes.tabR))
            .background(pill)
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
            .semantics { if (badgeText != null) contentDescription = "${tab.label}، $badgeText" }
            .padding(vertical = 6.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            if (selected) {
                Icon(tab.selectedIcon, contentDescription = null, tint = Color.Black, modifier = Modifier.size(24.dp).brushTint(t.paints.tabActiveIcon))
            } else {
                Icon(tab.icon, contentDescription = null, tint = labelColor, modifier = Modifier.size(24.dp))
            }
            when (val badge = tab.badge) {
                is TabBadge.Count -> Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 14.dp, y = (-8).dp)
                        .background(c.badgeRing, CircleShape)
                        .padding(2.dp)
                        .heightIn(min = 20.dp)
                        .widthIn(min = 20.dp)
                        .background(t.paints.badgeFill, CircleShape)
                        .padding(horizontal = 6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(badge.text, style = t.type.captionStrong, color = c.onBadge, maxLines = 1)
                }
                is TabBadge.Dot -> Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 4.dp, y = (-2).dp)
                        .size(13.dp)
                        .background(c.badgeRing, CircleShape)
                        .padding(2.dp)
                        .background(c.like, CircleShape),
                )
                null -> Unit
            }
        }
        Text(
            tab.label,
            style = if (selected) t.type.captionStrong else t.type.caption,
            color = labelColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
