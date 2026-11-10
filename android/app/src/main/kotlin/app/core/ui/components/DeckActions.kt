package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.DeckActionTokens
import app.core.ui.theme.Space
import app.core.ui.theme.insetShadow
import app.core.ui.theme.outerShadow
import androidx.compose.runtime.getValue

/** One of the deck's five actions. */
enum class DeckAction { Rewind, Pass, SuperLike, Like, Boost }

/**
 * The deck's action row: rewind 48, pass 68, super like 56, like 68,
 * boost 48, from left to right in every language (pass on the left, like
 * on the right), so only this row is laid out left to right inside a
 * Persian screen; inside the 20 dp gutter.
 *
 * A null handler leaves that button out (no rewind or boost on a plan
 * without them), keeping the others where they are.
 */
@Composable
fun DeckActions(
    onRewind: (() -> Unit)?,
    onPass: () -> Unit,
    onSuperLike: () -> Unit,
    onLike: () -> Unit,
    onBoost: (() -> Unit)?,
    modifier: Modifier = Modifier,
    backdrop: GlassBackdrop? = null,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            modifier = modifier.fillMaxWidth().padding(horizontal = Space.gutter),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Slot(DeckActionTokens.rewind) { onRewind?.let { DeckActionButton(DeckAction.Rewind, it, backdrop = backdrop) } }
            DeckActionButton(DeckAction.Pass, onPass, backdrop = backdrop)
            DeckActionButton(DeckAction.SuperLike, onSuperLike, backdrop = backdrop)
            DeckActionButton(DeckAction.Like, onLike, backdrop = backdrop)
            Slot(DeckActionTokens.boost) { onBoost?.let { DeckActionButton(DeckAction.Boost, it, backdrop = backdrop) } }
        }
    }
}

@Composable
private fun Slot(size: Dp, content: @Composable () -> Unit) {
    Box(Modifier.size(maxOf(size, 48.dp)), contentAlignment = Alignment.Center) { content() }
}

/**
 * One deck action at its size: like is `--like-fill` with `--on-like` and
 * `--glow-like` (the only glow); super like `--super-fill` with a 1.5 dp
 * `--super-line` and `--super-icon`; rewind, pass and boost `--act-fill`
 * (blurred over [backdrop] where glass is on) with a 1 dp `--act-line`,
 * `--act-icon` (boost: `--boost-icon`). Neon puts them on the photo, white
 * on the page with `--act-shadow`; the tokens carry the difference.
 */
@Composable
fun DeckActionButton(
    action: DeckAction,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    backdrop: GlassBackdrop? = null,
) {
    val t = AppTheme.template
    val c = t.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale = pressScale(pressed, if (action == DeckAction.Like) 0.90f else 0.94f)
    val (size, icon, label) = when (action) {
        DeckAction.Rewind -> Triple(DeckActionTokens.rewind, AppIcons.Rewind, R.string.ui_rewind)
        DeckAction.Pass -> Triple(DeckActionTokens.pass, AppIcons.Close, R.string.ui_pass)
        DeckAction.SuperLike -> Triple(DeckActionTokens.superLike, AppIcons.Star, R.string.ui_super_like)
        DeckAction.Like -> Triple(DeckActionTokens.like, AppIcons.Heart, R.string.ui_like)
        DeckAction.Boost -> Triple(DeckActionTokens.boost, AppIcons.Bolt, R.string.ui_boost)
    }
    val description = stringResource(label)
    val iconSize = if (size >= 68.dp) 30.dp else 24.dp
    val tint: Color = when (action) {
        DeckAction.Like -> c.onLike
        DeckAction.SuperLike -> c.superIcon
        DeckAction.Boost -> c.boostIcon
        DeckAction.Rewind, DeckAction.Pass -> c.actIcon
    }
    Box(
        modifier = modifier
            .size(size)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        when (action) {
            DeckAction.Like -> Box(
                Modifier
                    .size(size)
                    .likeGlow(CircleShape)
                    .background(t.paints.likeFill, CircleShape)
                    .insetShadow(CircleShape, t.shadows.btnHighlight),
            )
            DeckAction.SuperLike -> Box(
                Modifier
                    .size(size)
                    .outerShadow(CircleShape, t.shadows.actShadow)
                    .background(c.superFill, CircleShape)
                    .border(1.5.dp, c.superLine, CircleShape),
            )
            else -> GlassBox(CircleShape, GlassStyle.deckAction(), Modifier.size(size), backdrop) {}
        }
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(iconSize))
    }
}
