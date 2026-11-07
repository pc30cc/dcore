package app.core.feature.card

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.runtime.CompositionLocalProvider
import app.core.R
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.ItemKind
import app.core.model.LikedItem
import app.core.model.ProfileCard
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space

/** Where the full profile was opened from: the actions at its foot differ. */
enum class DetailsSource { Deck, Likes }

/** A photo or a prompt someone wants to like on its own. */
data class LikeTarget(val card: ProfileCard, val item: LikedItem, val photoIndex: Int? = null, val promptText: String? = null, val question: String? = null)

/**
 * The full profile, opened by swiping up or from a like: one continuous page
 * ([profileSections]), each photo and each answer with its own like, and the
 * actions at the foot.
 *
 * Shown above everything (the bottom bar included), entering from below as
 * the swipe that opened it suggests.
 */
@Composable
fun ProfileDetailsDialog(
    card: ProfileCard,
    catalog: Catalog,
    source: DetailsSource,
    onDismiss: () -> Unit,
    onPass: () -> Unit,
    onLike: () -> Unit,
    onSuperlike: (() -> Unit)?,
    onLikeItem: (LikeTarget) -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        ProfileDetails(card, catalog, source, onDismiss, onPass, onLike, onSuperlike, onLikeItem)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProfileDetails(
    card: ProfileCard,
    catalog: Catalog,
    source: DetailsSource,
    onDismiss: () -> Unit,
    onPass: () -> Unit,
    onLike: () -> Unit,
    onSuperlike: (() -> Unit)?,
    onLikeItem: (LikeTarget) -> Unit,
    modifier: Modifier = Modifier,
) {
    val number = rememberNumbers()
    val sections = remember(card, catalog, number) { profileSections(card, catalog, number) }
    val reduced = LocalReducedMotion.current
    val rise = with(LocalDensity.current) { 64.dp.toPx() }
    val enter = remember(card.id) { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(card.id) { if (!reduced) enter.animateTo(1f, spring(dampingRatio = 0.85f, stiffness = 420f)) }
    val pane = nameAndAge(card, number)

    Surface(
        color = MaterialTheme.colorScheme.background,
        modifier = modifier
            .fillMaxSize()
            .graphicsLayer {
                alpha = enter.value.coerceIn(0f, 1f)
                translationY = (1f - enter.value) * rise
            }
            .semantics { paneTitle = pane },
    ) {
        Box(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(top = Space.sm, bottom = 128.dp),
                verticalArrangement = Arrangement.spacedBy(Space.lg),
            ) {
                item(key = "top-inset") { Spacer(Modifier.statusBarsPadding()) }
                items(sections, key = { it.key }) { section ->
                    when (section) {
                        is ProfileSection.PhotoBlock -> PhotoSection(card, section) {
                            onLikeItem(LikeTarget(card, LikedItem(ItemKind.Photo, section.photo.id), photoIndex = section.index))
                        }
                        ProfileSection.Header -> HeaderSection(card, catalog, number)
                        is ProfileSection.About -> TextBlock(brandString(R.string.profile_view_about), section.text)
                        is ProfileSection.PromptBlock -> PromptSection(section, number) {
                            onLikeItem(
                                LikeTarget(
                                    card,
                                    LikedItem(ItemKind.Prompt, section.prompt.promptId.toString()),
                                    promptText = section.prompt.answer,
                                    question = section.question,
                                ),
                            )
                        }
                        is ProfileSection.Fields -> FieldsSection(section)
                    }
                }
            }

            // Close, at the top start, over the first photo.
            Surface(
                onClick = onDismiss,
                shape = CircleShape,
                color = Color.Black.copy(alpha = 0.45f),
                contentColor = Color.White,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(Space.xl)
                    .size(Space.minTouch),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = brandString(R.string.profile_view_close), modifier = Modifier.size(28.dp))
                }
            }

            DetailsActions(
                source = source,
                onPass = onPass,
                onLike = onLike,
                onSuperlike = onSuperlike,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, MaterialTheme.colorScheme.background)))
                    .navigationBarsPadding()
                    .padding(top = Space.xl, bottom = Space.lg),
            )
        }
    }
}

@Composable
private fun PhotoSection(card: ProfileCard, section: ProfileSection.PhotoBlock, onLike: () -> Unit) {
    val number = rememberNumbers()
    val ratio = section.photo.let { if (it.w > 0 && it.h > 0) (it.w.toFloat() / it.h).coerceIn(0.62f, 1.2f) else 0.8f }
    val description = brandString(R.string.profile_view_photo, number(section.index + 1), number(section.count))
    Box(
        Modifier
            .padding(horizontal = Space.lg)
            .fillMaxWidth()
            .aspectRatio(ratio)
            .clip(RoundedCornerShape(Radius.lg)),
    ) {
        PhotoImage(
            photo = section.photo,
            contentDescription = null,
            modifier = Modifier
                .fillMaxSize()
                .semantics { contentDescription = description },
        )
        ItemLikeButton(brandString(R.string.like_photo), onLike, Modifier.align(Alignment.BottomEnd).padding(Space.md))
    }
}

/** The heart on a photo or an answer: like that part, with an optional comment. */
@Composable
fun ItemLikeButton(description: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = actionSurface(),
        contentColor = AppTheme.colors.like,
        shadowElevation = 4.dp,
        modifier = modifier.size(52.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Favorite, contentDescription = description, modifier = Modifier.size(26.dp))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HeaderSection(card: ProfileCard, catalog: Catalog, number: (Int) -> String) {
    Column(Modifier.padding(horizontal = Space.xl), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                nameAndAge(card, number),
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.weight(1f, fill = false).semantics { heading() },
            )
            if (card.verified) {
                Spacer(Modifier.width(Space.sm))
                VerifiedBadge(28.dp, description = brandString(R.string.deck_verified))
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            when {
                card.superliked -> Chip(brandString(R.string.deck_superliked_you), AppTheme.colors.superLike)
                card.likesYou -> Chip(brandString(R.string.deck_likes_you), MaterialTheme.colorScheme.primary)
            }
            intentionLabel(card.intention, catalog)?.let { Chip(it, MaterialTheme.colorScheme.secondary) }
            if (card.activeRecently) Chip(brandString(R.string.deck_active_recently), AppTheme.colors.like)
            if (card.traveling) Chip(brandString(R.string.deck_traveling), MaterialTheme.colorScheme.secondary)
        }
        card.job?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
        }
        locationLine(card, number)?.let {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.LocationOn, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(Space.xs))
                Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun Chip(text: String, color: Color) {
    Surface(
        shape = RoundedCornerShape(Radius.pill),
        color = color.copy(alpha = 0.12f),
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Row(Modifier.padding(horizontal = Space.md, vertical = Space.xs + 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(color))
            Spacer(Modifier.width(Space.sm))
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun TextBlock(title: String, body: String) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(Radius.lg),
        modifier = Modifier.padding(horizontal = Space.lg).fillMaxWidth(),
    ) {
        Column(Modifier.padding(Space.xl), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { heading() })
            Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

@Composable
private fun PromptSection(section: ProfileSection.PromptBlock, number: (Int) -> String, onLike: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(Radius.lg),
        modifier = Modifier.padding(horizontal = Space.lg).fillMaxWidth(),
    ) {
        Row(Modifier.padding(start = Space.xl, top = Space.xl, bottom = Space.xl, end = Space.md), verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                section.question?.let {
                    Text(it, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val answer = section.prompt.answer
                if (!answer.isNullOrBlank()) {
                    Text(answer, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurface)
                } else if (section.prompt.audioUrl != null) {
                    val seconds = ((section.prompt.audioMs ?: 0) + 999) / 1000
                    val duration = "${number(seconds / 60)}:${number(seconds % 60).padStart(2, number(0).first())}"
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(painterResource(R.drawable.ic_deck_voice), null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(Space.sm))
                        Text(brandString(R.string.profile_view_voice_answer, duration), style = MaterialTheme.typography.titleMedium)
                    }
                    Text(brandString(R.string.profile_view_voice_unavailable), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.width(Space.sm))
            ItemLikeButton(brandString(R.string.like_prompt), onLike)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FieldsSection(section: ProfileSection.Fields) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(Radius.lg),
        modifier = Modifier.padding(horizontal = Space.lg).fillMaxWidth(),
    ) {
        Column(Modifier.padding(Space.xl), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Text(brandString(R.string.profile_view_basics), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { heading() })
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                section.lines.forEach { line ->
                    Surface(
                        shape = RoundedCornerShape(Radius.pill),
                        color = MaterialTheme.colorScheme.surfaceContainerHighest,
                        contentColor = MaterialTheme.colorScheme.onSurface,
                    ) {
                        Row(Modifier.padding(horizontal = Space.md, vertical = Space.sm)) {
                            Text(line.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(Space.xs + 2.dp))
                            Text(line.value, style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
            }
        }
    }
}

/**
 * Pass and like at the foot of the page (super like from the deck; "like
 * back" from the likes list). Always pass at the left and like at the right,
 * whatever the reading direction, as on the deck.
 */
@Composable
private fun DetailsActions(
    source: DetailsSource,
    onPass: () -> Unit,
    onLike: () -> Unit,
    onSuperlike: (() -> Unit)?,
    modifier: Modifier,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(Space.xl, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            RoundAction(
                painter = androidx.compose.ui.graphics.vector.rememberVectorPainter(Icons.Filled.Close),
                description = brandString(R.string.deck_action_pass),
                color = AppTheme.colors.pass,
                size = 64.dp,
                onClick = onPass,
            )
            if (onSuperlike != null) {
                RoundAction(
                    painter = androidx.compose.ui.graphics.vector.rememberVectorPainter(Icons.Filled.Star),
                    description = brandString(R.string.deck_action_superlike),
                    color = AppTheme.colors.superLike,
                    size = 52.dp,
                    onClick = onSuperlike,
                )
            }
            RoundAction(
                painter = androidx.compose.ui.graphics.vector.rememberVectorPainter(Icons.Filled.Favorite),
                description = brandString(if (source == DetailsSource.Likes) R.string.profile_view_like_back else R.string.deck_action_like),
                color = AppTheme.colors.like,
                size = 64.dp,
                onClick = onLike,
            )
        }
    }
}
