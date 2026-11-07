package app.core.feature.deck

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.card.PhotoIndicator
import app.core.feature.card.PhotoPill
import app.core.feature.card.VerifiedBadge
import app.core.feature.card.intentionLabel
import app.core.feature.card.locationLine
import app.core.feature.card.nameAndAge
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.ProfileCard
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * The face of a card: its photos edge to edge (tap the start or end side to
 * page through them), the position bar, and the name, age, badge, job, city
 * and rounded distance over a soft gradient at the bottom. While the card is
 * dragged, [progress] fades in the like or pass stamp and [upProgress] the
 * "open profile" hint.
 */
@Composable
fun DeckCardFace(
    card: ProfileCard,
    photoIndex: Int,
    onPhotoIndex: (Int) -> Unit,
    catalog: Catalog,
    number: (Int) -> String,
    onOpenDetails: () -> Unit,
    modifier: Modifier = Modifier,
    progress: () -> Float = { 0f },
    upProgress: () -> Float = { 0f },
    interactive: Boolean = true,
) {
    val photos = card.photos
    val index = photoIndex.coerceIn(0, (photos.size - 1).coerceAtLeast(0))
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val haptics = LocalHapticFeedback.current
    val reduced = LocalReducedMotion.current
    val scope = rememberCoroutineScope()
    val nudge = remember(card.id) { Animatable(0f) }
    val nudgePx = with(LocalDensity.current) { 10.dp.toPx() }

    fun page(forward: Boolean) {
        val next = if (forward) index + 1 else index - 1
        if (next in photos.indices) {
            onPhotoIndex(next)
            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
        } else if (!reduced) {
            // At either end: a small bump instead of nothing.
            haptics.performHapticFeedback(HapticFeedbackType.Reject)
            scope.launch {
                val direction = if (forward != rtl) -1f else 1f
                nudge.animateTo(direction * nudgePx, spring(stiffness = 2_000f))
                nudge.animateTo(0f, spring(dampingRatio = 0.4f, stiffness = 700f))
            }
        }
    }

    val currentPage = rememberUpdatedState(::page)

    Box(
        modifier
            .clip(RoundedCornerShape(Radius.card))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        PhotoImage(
            photo = photos.getOrNull(index),
            contentDescription = null,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer { translationX = nudge.value }
                .then(
                    if (interactive) {
                        Modifier.pointerInput(card.id, rtl) {
                            detectTapGestures { offset ->
                                // The end side of the reading direction is "next".
                                val endSide = if (rtl) offset.x < size.width / 2f else offset.x > size.width / 2f
                                currentPage.value(endSide)
                            }
                        }
                    } else {
                        Modifier
                    },
                ),
        )

        PhotoIndicator(
            count = photos.size,
            index = index,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .padding(horizontal = Space.md, vertical = Space.sm)
                .clearAndSetSemantics { },
        )

        // The bottom gradient, only under the text.
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .fillMaxSize(0.5f)
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.78f)))),
        )

        CardInfo(card, catalog, number, onOpenDetails, interactive, Modifier.align(Alignment.BottomStart))

        SwipeStamps(progress, upProgress)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CardInfo(
    card: ProfileCard,
    catalog: Catalog,
    number: (Int) -> String,
    onOpenDetails: () -> Unit,
    interactive: Boolean,
    modifier: Modifier,
) {
    val white = Color.White
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = Space.lg, end = Space.md, bottom = Space.lg),
        verticalAlignment = Alignment.Bottom,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            // Wraps instead of clipping when the reader's text is large.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.xs + 2.dp), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                when {
                    card.superliked -> PhotoPill(brandString(R.string.deck_superliked_you), vector = Icons.Filled.Star, accent = lighten(AppTheme.colors.superLike))
                    card.likesYou -> PhotoPill(brandString(R.string.deck_likes_you), icon = R.drawable.ic_tab_likes)
                }
                if (card.activeRecently) {
                    PhotoPill(brandString(R.string.deck_active_recently), icon = R.drawable.ic_deck_radar, accent = lighten(AppTheme.colors.like))
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = nameAndAge(card, number),
                    style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
                    color = white,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (card.verified) {
                    Spacer(Modifier.width(Space.xs + 2.dp))
                    VerifiedBadge(26.dp, description = brandString(R.string.deck_verified))
                }
            }
            val line = listOfNotNull(intentionLabel(card.intention, catalog), card.job?.takeIf { it.isNotBlank() }).joinToString(" · ")
            if (line.isNotEmpty()) {
                Text(line, style = MaterialTheme.typography.bodyLarge, color = white.copy(alpha = 0.92f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            val location = locationLine(card, number)
            if (location != null || card.traveling) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.LocationOn, null, tint = white.copy(alpha = 0.85f), modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(Space.xs))
                    Text(
                        listOfNotNull(location, if (card.traveling) brandString(R.string.deck_traveling) else null).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = white.copy(alpha = 0.88f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        if (interactive) {
            Surface(
                onClick = onOpenDetails,
                shape = CircleShape,
                color = Color.White.copy(alpha = 0.22f),
                contentColor = white,
                modifier = Modifier
                    .padding(start = Space.sm)
                    .size(Space.minTouch),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.KeyboardArrowUp, contentDescription = brandString(R.string.deck_action_details), modifier = Modifier.size(28.dp))
                }
            }
        }
    }
}

/** A light tint of a semantic colour, readable on the dark photo gradient. */
private fun lighten(color: Color): Color = androidx.compose.ui.graphics.lerp(color, Color.White, 0.35f)

/**
 * The stamps a drag shows: LIKE at the top left when the card goes right,
 * PASS at the top right when it goes left (screen sides, not reading sides,
 * like the gesture), and a coloured wash from the edge it leaves by.
 */
@Composable
private fun SwipeStamps(progressOf: () -> Float, upProgressOf: () -> Float) {
    // Read here: only this layer recomposes while the card moves.
    val progress = progressOf()
    val upProgress = upProgressOf()
    if (progress == 0f && upProgress == 0f) return
    val like = AppTheme.colors.like
    val pass = AppTheme.colors.pass
    Box(Modifier.fillMaxSize()) {
        if (progress > 0f) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Brush.horizontalGradient(listOf(like.copy(alpha = 0.38f * progress), Color.Transparent))),
            )
            Stamp(brandString(R.string.deck_stamp_like), like, -14f, progress, Modifier.align(AbsoluteAlignment.TopLeft))
        } else if (progress < 0f) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Brush.horizontalGradient(listOf(Color.Transparent, pass.copy(alpha = 0.38f * -progress)))),
            )
            Stamp(brandString(R.string.deck_stamp_pass), pass, 14f, -progress, Modifier.align(AbsoluteAlignment.TopRight))
        }
        if (upProgress > 0f) {
            Surface(
                shape = RoundedCornerShape(Radius.pill),
                color = Color.Black.copy(alpha = 0.55f),
                contentColor = Color.White,
                modifier = Modifier
                    .align(Alignment.Center)
                    .graphicsLayer {
                        alpha = upProgress
                        scaleX = 0.85f + 0.15f * upProgress
                        scaleY = 0.85f + 0.15f * upProgress
                    },
            ) {
                Row(Modifier.padding(horizontal = Space.lg, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.KeyboardArrowUp, null)
                    Text(brandString(R.string.deck_action_details), style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

@Composable
private fun Stamp(text: String, color: Color, rotation: Float, alpha: Float, modifier: Modifier) {
    Box(
        modifier
            .padding(top = Space.xxxl, start = Space.xl, end = Space.xl)
            .graphicsLayer {
                rotationZ = rotation
                this.alpha = alpha.coerceIn(0f, 1f)
                val s = 1.15f - 0.15f * alpha.coerceIn(0f, 1f)
                scaleX = s
                scaleY = s
            }
            .clip(RoundedCornerShape(Radius.sm))
            .background(Color.White.copy(alpha = 0.92f))
            .padding(horizontal = Space.md, vertical = Space.xs),
    ) {
        Text(text, color = color, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Black))
    }
}
