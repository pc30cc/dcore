package app.core.feature.deck

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.card.locationLine
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.ProfileCard
import app.core.ui.components.NameLine
import app.core.ui.components.PhotoScrimBottom
import app.core.ui.components.PhotoScrimTop
import app.core.ui.components.StoryProgress
import app.core.ui.theme.AppTheme
import app.core.ui.theme.DeckStyle
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * The face of a card, by the template's deck switch:
 * - bleed (neon): the photo edge to edge under the status bar, the top
 *   scrim (190 dp) and the bottom one (56 %), the story bars [storyTop]
 *   from the top, and the name, age, badge, online dot and «{city}، {n}
 *   کیلومتر» on the photo, [infoBottom] above the window's bottom;
 * - card (white): the photo inset with `--r-photo` corners, the story bars
 *   12 dp inside it over an 84 dp scrim at 70 %; the name and the line are
 *   drawn under the photo by the screen ([CardInfo]), not on it.
 * Tapping the start or end side of the photo pages through the photos (the
 * end side of the reading direction is "next"), with a small bump at either
 * end. Nothing else is on the card: no bio, chips, job or icons.
 */
@Composable
fun DeckCardFace(
    card: ProfileCard,
    photoIndex: Int,
    onPhotoIndex: (Int) -> Unit,
    number: (Int) -> String,
    modifier: Modifier = Modifier,
    interactive: Boolean = true,
    infoBottom: Dp = 0.dp,
    storyTop: Dp = DeckLayout.storyInset,
    onOpenInfo: (() -> Unit)? = null,
) {
    val t = AppTheme.template
    val bleed = t.switches.deck == DeckStyle.Bleed
    val photos = card.photos
    val index = photoIndex.coerceIn(0, (photos.size - 1).coerceAtLeast(0))
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val haptics = LocalHapticFeedback.current
    val reduced = LocalReducedMotion.current
    val scope = rememberCoroutineScope()
    val nudge = remember(card.id) { Animatable(0f) }
    val nudgePx = with(LocalDensity.current) { DeckLayout.nudge.toPx() }

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
    val shape = RoundedCornerShape(t.radii.photo)

    Box(
        modifier
            .clip(shape)
            .background(t.colors.photoPlaceholder, shape),
    ) {
        PhotoImage(
            photo = photos.getOrNull(index),
            contentDescription = null,
            alignment = Alignment.TopCenter,
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
        if (bleed) {
            PhotoScrimTop()
            PhotoScrimBottom(Modifier.align(Alignment.BottomCenter).fillMaxHeight(DeckLayout.BOTTOM_SCRIM))
        } else {
            PhotoScrimTop(Modifier.alpha(DeckLayout.CARD_SCRIM_ALPHA), height = DeckLayout.cardScrim)
        }
        if (photos.size > 1) {
            StoryProgress(
                count = photos.size,
                current = index,
                progress = 1f,
                modifier = Modifier.padding(top = if (bleed) storyTop else DeckLayout.storyInset).clearAndSetSemantics { },
            )
        }
        if (bleed) {
            CardInfo(
                card,
                number,
                onPhoto = true,
                onOpen = onOpenInfo,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = Space.gutter, end = Space.gutter, bottom = infoBottom),
            )
        }
    }
}

/**
 * The name line and «{city}، {n} کیلومتر»: on the photo in `--on-photo`
 * (`--type-name-photo`, the meta in `--type-body-strong` `--on-photo-2`), or
 * under a card photo in ink (`--type-h1`, the meta in `--type-body`
 * `--text-2`). The online dot is plain green; never the word.
 *
 * On the deck the card's own description speaks for it, so this says only
 * what a tap does: [onOpen] (a tap on the name block, no icon) opens the
 * full profile, «دیدن پروفایل» to TalkBack; on the photo it is part of the
 * card's own node, under a card photo its own button. Where nothing else
 * speaks for the person (the full profile), [description] is what TalkBack
 * reads, as a heading.
 */
@Composable
fun CardInfo(
    card: ProfileCard,
    number: (Int) -> String,
    onPhoto: Boolean,
    modifier: Modifier = Modifier,
    description: String? = null,
    onOpen: (() -> Unit)? = null,
) {
    val t = AppTheme.template
    val openLabel = brandString(R.string.deck_action_details)
    val open by rememberUpdatedState(onOpen)
    val semantics = when {
        description != null -> Modifier.clearAndSetSemantics {
            contentDescription = description
            heading()
        }
        onOpen != null -> Modifier.clearAndSetSemantics {
            if (!onPhoto) {
                contentDescription = openLabel
                role = Role.Button
            }
            onClick(openLabel) { open?.invoke(); open != null }
        }
        else -> Modifier.clearAndSetSemantics { }
    }
    // A tap opens the profile; a drag that starts here still moves the card (the tap gives way once it is a drag).
    val tap = if (onOpen != null) {
        Modifier
            .heightIn(min = DeckLayout.infoTarget)
            .pointerInput(Unit) { detectTapGestures(onTap = { open?.invoke() }) }
    } else {
        Modifier
    }
    Column(modifier.fillMaxWidth().then(tap).then(semantics), verticalArrangement = Arrangement.Bottom) {
        NameLine(
            name = card.name,
            age = card.age?.let(number),
            verified = card.verified,
            online = card.activeRecently,
            onPhoto = onPhoto,
        )
        locationLine(card, number)?.let { meta ->
            Text(
                meta,
                style = if (onPhoto) t.type.bodyStrong else t.type.body,
                color = if (onPhoto) t.colors.onPhoto2 else t.colors.text2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = if (onPhoto) DeckLayout.metaGapOnPhoto else 0.dp),
            )
        }
    }
}
