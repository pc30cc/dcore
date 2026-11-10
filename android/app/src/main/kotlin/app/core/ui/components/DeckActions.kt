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
import androidx.compose.ui.draw.alpha
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
 * without them), keeping the others where they are. [enabled] off (no card
 * yet) dims the row. [progress] is the top card's drag, -1 (pass) to 1
 * (like): the button under the finger's gesture grows with it. [boostActive]
 * draws the bolt in `--primary` while a boost runs; [superLikeDescription]
 * and [boostDescription] replace what TalkBack says («سوپرلایک. ۳ تا داری»).
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
    enabled: Boolean = true,
    progress: () -> Float = { 0f },
    boostActive: Boolean = false,
    superLikeDescription: String? = null,
    boostDescription: String? = null,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            modifier = modifier.fillMaxWidth().padding(horizontal = Space.gutter).alpha(if (enabled) 1f else DISABLED_ALPHA),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Slot(DeckActionTokens.rewind) { onRewind?.let { DeckActionButton(DeckAction.Rewind, it, backdrop = backdrop, enabled = enabled) } }
            DeckActionButton(DeckAction.Pass, onPass, backdrop = backdrop, enabled = enabled, highlight = { (-progress()).coerceAtLeast(0f) })
            DeckActionButton(DeckAction.SuperLike, onSuperLike, backdrop = backdrop, enabled = enabled, description = superLikeDescription)
            DeckActionButton(DeckAction.Like, onLike, backdrop = backdrop, enabled = enabled, highlight = { progress().coerceAtLeast(0f) })
            Slot(DeckActionTokens.boost) {
                onBoost?.let { DeckActionButton(DeckAction.Boost, it, backdrop = backdrop, enabled = enabled, active = boostActive, description = boostDescription) }
            }
        }
    }
}

private const val DISABLED_ALPHA = 0.45f

/** How much a pass or like button grows at a full drag toward it. */
private const val HIGHLIGHT_GROWTH = 0.12f

@Composable
private fun Slot(size: Dp, content: @Composable () -> Unit) {
    Box(Modifier.size(maxOf(size, 48.dp)), contentAlignment = Alignment.Center) { content() }
}

/**
 * One deck action at its size: like is `--like-fill` with `--on-like` and
 * `--glow-like` (the only glow); super like `--super-fill` with a 1.5 dp
 * `--super-line` and `--super-icon`; rewind, pass and boost `--act-fill`
 * (blurred over [backdrop] where glass is on) with a 1 dp `--act-line`,
 * `--act-icon` (boost: `--boost-icon`, `--primary` while [active]). Neon
 * puts them on the photo, white on the page with `--act-shadow`; the tokens
 * carry the difference. [highlight] (0 to 1) grows it a little.
 */
@Composable
fun DeckActionButton(
    action: DeckAction,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    backdrop: GlassBackdrop? = null,
    enabled: Boolean = true,
    active: Boolean = false,
    highlight: () -> Float = { 0f },
    description: String? = null,
) {
    val t = AppTheme.template
    val c = t.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale = pressScale(pressed && enabled, if (action == DeckAction.Like) 0.90f else 0.94f)
    val (size, icon, label) = when (action) {
        DeckAction.Rewind -> Triple(DeckActionTokens.rewind, AppIcons.Rewind, R.string.ui_rewind)
        DeckAction.Pass -> Triple(DeckActionTokens.pass, AppIcons.Close, R.string.ui_pass)
        DeckAction.SuperLike -> Triple(DeckActionTokens.superLike, AppIcons.Star, R.string.ui_super_like)
        DeckAction.Like -> Triple(DeckActionTokens.like, AppIcons.Heart, R.string.ui_like)
        DeckAction.Boost -> Triple(DeckActionTokens.boost, AppIcons.Bolt, R.string.ui_boost)
    }
    val spoken = description ?: stringResource(label)
    val iconSize = if (size >= 68.dp) 30.dp else 24.dp
    val tint: Color = when (action) {
        DeckAction.Like -> c.onLike
        DeckAction.SuperLike -> c.superIcon
        DeckAction.Boost -> if (active) c.primary else c.boostIcon
        DeckAction.Rewind, DeckAction.Pass -> c.actIcon
    }
    Box(
        modifier = modifier
            .size(size)
            .graphicsLayer {
                val grow = 1f + HIGHLIGHT_GROWTH * highlight().coerceIn(0f, 1f)
                scaleX = scale * grow
                scaleY = scale * grow
            }
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = spoken },
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
