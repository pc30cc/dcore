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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
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

/** One of the deck's five actions. */
enum class DeckAction { Rewind, Pass, SuperLike, Like, Boost }

/**
 * The deck's action row: rewind, pass, super-like, like, boost, from left to
 * right in every language (pass on the left, like on the right), so only
 * this row is laid out left to right inside a Persian screen. Glass over the
 * photo ([backdrop]); like is the gradient with the glow.
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
            modifier = modifier.fillMaxWidth().padding(horizontal = DeckActionTokens.gutter),
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

/** One deck action, at its own size (tokens.json `spacing.deckActions`). */
@Composable
fun DeckActionButton(
    action: DeckAction,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    backdrop: GlassBackdrop? = null,
) {
    val colors = AppTheme.colors
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
    val iconSize = when (action) {
        DeckAction.Pass -> 32.dp
        DeckAction.Like -> 32.dp
        DeckAction.SuperLike -> 26.dp
        else -> 22.dp
    }
    val tint: Color = when (action) {
        DeckAction.Like -> colors.onGradient
        DeckAction.SuperLike -> if (colors.dark) colors.alive else colors.onSuperLike
        DeckAction.Boost -> colors.boost
        DeckAction.Rewind -> colors.rewind
        DeckAction.Pass -> colors.pass
    }
    Box(
        modifier = modifier
            .size(size)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .then(if (action == DeckAction.Like) Modifier.glow(CircleShape, colors, pressed) else Modifier)
            .clip(CircleShape)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        when {
            action == DeckAction.Like -> Box(Modifier.size(size).background(colors.gradient, CircleShape))
            action == DeckAction.SuperLike && !colors.dark -> Box(Modifier.size(size).softShadow(CircleShape).background(colors.superLikeFill, CircleShape))
            else -> GlassBox(CircleShape, GlassStyle.photoChrome(colors), Modifier.size(size), backdrop) {}
        }
        if (action == DeckAction.SuperLike && colors.dark) {
            Box(Modifier.size(size).border(1.5.dp, colors.alive.copy(alpha = 0.55f), CircleShape))
        }
        DeckIcon(icon, tint, iconSize)
    }
}

@Composable
private fun DeckIcon(icon: ImageVector, tint: Color, size: Dp) {
    Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(size))
}
