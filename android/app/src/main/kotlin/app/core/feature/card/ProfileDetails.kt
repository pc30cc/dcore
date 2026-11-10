package app.core.feature.card

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.core.R
import app.core.feature.deck.CardInfo
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.ItemKind
import app.core.model.LikedItem
import app.core.model.ProfileCard
import app.core.model.ProfilePrompt
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppSnackbar
import app.core.ui.components.Avatar
import app.core.ui.components.DeckAction
import app.core.ui.components.DeckActionButton
import app.core.ui.components.Fact
import app.core.ui.components.FactRow
import app.core.ui.components.IconButtonKind
import app.core.ui.components.PhotoScrimBottom
import app.core.ui.components.PhotoScrimTop
import app.core.ui.components.LikeAnswerButton
import app.core.ui.components.PromptQuote
import app.core.ui.components.SectionLabel
import app.core.ui.components.SettingsRow
import app.core.ui.components.RowEnd
import app.core.ui.components.StoryProgress
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.VerifiedBadge
import app.core.ui.components.rememberGlassBackdrop
import app.core.ui.components.glassSource
import app.core.ui.components.templateCard
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.DialogBarIcons
import app.core.ui.theme.DeckStyle
import app.core.ui.theme.HeroStyle
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Space
import app.core.ui.theme.insetShadow
import kotlinx.coroutines.launch

/** Where the full profile was opened from: the deck, the likes list, or a conversation with a match (no swipe actions there). */
enum class DetailsSource { Deck, Likes, Match }

/** A notice to show over the open profile ([id] marks it shown once it was). */
data class DetailsNotice(val id: Long, val text: String)

/** A photo or a prompt someone wants to like on its own. */
data class LikeTarget(val card: ProfileCard, val item: LikedItem, val photoIndex: Int? = null, val promptText: String? = null, val question: String? = null)

/**
 * The full profile, opened by swiping up or from a like, above everything
 * (the tab bar included), entering from below as the swipe that opened it
 * suggests. See [ProfileDetails].
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
    onMessage: (() -> Unit)? = null,
    onReport: (() -> Unit)? = null,
    onBlock: (() -> Unit)? = null,
    /** Shown over the profile (its window covers the screen's own notices), then [onNoticeShown]. */
    notice: DetailsNotice? = null,
    onNoticeShown: (Long) -> Unit = {},
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        DialogBarIcons()
        ProfileDetails(
            card, catalog, source, onDismiss, onPass, onLike, onSuperlike, onLikeItem,
            onMessage = onMessage, onReport = onReport, onBlock = onBlock, notice = notice, onNoticeShown = onNoticeShown,
        )
    }
}

/**
 * The full profile as one page. Its first screen is the person's photos
 * (story bars; tapping the start or end side pages through them, as on the
 * deck; a long press likes the photo shown), by the template's deck switch:
 * bleed (neon) edge to edge with a glass close (chevron down) and «بیشتر»
 * over it and the name and the line on the photo; card (white) under a plain
 * header, inset with `--r-photo` corners, the name and the line under it in
 * ink. Scrolling on: about, the voice answers, the fact grid (three columns,
 * no icons), each answer as a pull quote with its own like and one more
 * photo after it (neon full width fading out of the page; white inset and
 * rounded, never fading), then report and block as text buttons. Once the
 * first screen has gone, an app bar shows the close, the face, «{name}،
 * {age}» with the badge and «بیشتر» («پیام بده», report and block).
 *
 * Pass and like float at the bottom corners (not for a match: [source]
 * [DetailsSource.Match]); a super like goes from the like-a-photo sheet.
 * [onSuperlike] is no longer drawn here.
 */
@Composable
fun ProfileDetails(
    card: ProfileCard,
    catalog: Catalog,
    source: DetailsSource,
    onDismiss: () -> Unit,
    onPass: () -> Unit,
    onLike: () -> Unit,
    @Suppress("UNUSED_PARAMETER") onSuperlike: (() -> Unit)?,
    onLikeItem: (LikeTarget) -> Unit,
    modifier: Modifier = Modifier,
    /** "Write to them": a message request before matching (not offered for a match). */
    onMessage: (() -> Unit)? = null,
    onReport: (() -> Unit)? = null,
    onBlock: (() -> Unit)? = null,
    notice: DetailsNotice? = null,
    onNoticeShown: (Long) -> Unit = {},
) {
    val t = AppTheme.template
    val number = rememberNumbers()
    val match = source == DetailsSource.Match
    // A match's profile, opened from the conversation: nothing to swipe or like.
    val likeItem: (LikeTarget) -> Unit = if (match) { _ -> } else onLikeItem
    val writeTo = onMessage?.takeIf { !match }
    val separator = brandString(R.string.profile_list_separator)
    val sections = remember(card, catalog, number, separator) { profileSections(card, catalog, number, separator) }
    val reduced = LocalReducedMotion.current
    val rise = with(LocalDensity.current) { DetailsLayout.rise.toPx() }
    val enter = remember(card.id) { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(card.id) { if (!reduced) enter.animateTo(1f, spring(dampingRatio = 0.85f, stiffness = 420f)) }
    val pane = nameAndAge(card, number)
    val list = rememberLazyListState()
    var photoIndex by rememberSaveable(card.id) { mutableIntStateOf(0) }
    var more by rememberSaveable(card.id) { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    if (notice != null) {
        LaunchedEffect(notice.id) {
            snackbar.showSnackbar(notice.text)
            onNoticeShown(notice.id)
        }
    }
    val scope = rememberCoroutineScope()
    val voiceUnavailable = brandString(R.string.profile_view_voice_unavailable)
    val statusTop = maxOf(WindowInsets.statusBars.asPaddingValues().calculateTopPadding(), DetailsLayout.statusBar)
    val navigation = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val barHeight = statusTop + DetailsLayout.appBar
    val density = LocalDensity.current
    val hasMore = writeTo != null || onReport != null || onBlock != null
    val likePhoto: (Int) -> Unit = { index ->
        card.photos.getOrNull(index)?.let { likeItem(LikeTarget(card, LikedItem(ItemKind.Photo, it.id), photoIndex = index)) }
    }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .background(t.colors.bg)
            .graphicsLayer {
                alpha = enter.value.coerceIn(0f, 1f)
                translationY = (1f - enter.value) * rise
            }
            .semantics { paneTitle = pane },
    ) {
        val viewport = maxHeight
        val heroGone by remember(viewport, barHeight) {
            derivedStateOf {
                list.firstVisibleItemIndex > 0 ||
                    list.firstVisibleItemScrollOffset > with(density) { (viewport - barHeight).toPx() }
            }
        }
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = if (match) navigation + DetailsLayout.endPadding else navigation + DetailsLayout.actionsRoom),
        ) {
            item(key = "hero") {
                Hero(
                    card = card,
                    height = viewport,
                    statusTop = statusTop,
                    navigation = navigation,
                    number = number,
                    photoIndex = photoIndex,
                    onPhotoIndex = { photoIndex = it },
                    onLikePhoto = if (match) null else likePhoto,
                    onClose = onDismiss,
                    onMore = if (hasMore) { { more = true } } else null,
                    withActions = !match,
                )
            }
            itemsIndexed(sections, key = { _, it -> it.key }) { index, section ->
                // The first section starts under the app bar that replaces the first screen's chrome.
                Column(Modifier.padding(top = if (index == 0) barHeight else 0.dp)) {
                when (section) {
                    is ProfileSection.About -> Block(DetailsLayout.firstGap) {
                        SectionLabel(brandString(R.string.profile_view_about), Modifier.padding(bottom = DetailsLayout.labelGap))
                        // The person's own words take their own direction (a Persian about in an English page).
                        Text(section.text, style = t.type.bodyLg.copy(textDirection = TextDirection.Content), color = t.colors.text, modifier = Modifier.fillMaxWidth())
                    }
                    is ProfileSection.PromptBlock -> if (section.voice) {
                        Block(DetailsLayout.firstGap) {
                            SectionLabel(brandString(R.string.profile_view_voice), Modifier.padding(bottom = DetailsLayout.labelGap))
                            VoiceCard(
                                section.question,
                                section.prompt,
                                number,
                                onPlay = { scope.launch { snackbar.showSnackbar(voiceUnavailable) } },
                                // A voice answer is liked like a written one (not on a match's profile).
                                onLike = if (match) {
                                    null
                                } else {
                                    {
                                        likeItem(
                                            LikeTarget(
                                                card,
                                                LikedItem(ItemKind.Prompt, section.prompt.promptId.toString()),
                                                promptText = null,
                                                question = section.question,
                                            ),
                                        )
                                    }
                                },
                            )
                        }
                    } else {
                        Block(DetailsLayout.sectionGap) {
                            PromptQuote(
                                question = section.question.orEmpty(),
                                answer = section.prompt.answer.orEmpty(),
                                onLike = if (match) {
                                    null
                                } else {
                                    {
                                        likeItem(
                                            LikeTarget(
                                                card,
                                                LikedItem(ItemKind.Prompt, section.prompt.promptId.toString()),
                                                promptText = section.prompt.answer,
                                                question = section.question,
                                            ),
                                        )
                                    }
                                },
                            )
                        }
                    }
                    is ProfileSection.Fields -> Block(DetailsLayout.factsGap) { FactGrid(card, catalog, section, number) }
                    is ProfileSection.PhotoBlock -> InlinePhoto(card, section, number, if (match) null else { { likePhoto(section.index) } })
                }
                }
            }
            if (onReport != null || onBlock != null) {
                item(key = "safety") { Safety(card, onReport, onBlock) }
            }
        }

        if (!match) {
            // Pass and like float over the page with nothing under them: photos run under them crisp, as
            // the design draws them; the list's end padding keeps the last section clear of them.
            val bottom by animateDpAsState(if (heroGone) DetailsLayout.actionsBottomDetails else DetailsLayout.actionsBottomHero, label = "actions")
            val side by animateDpAsState(
                if (heroGone && t.switches.hero == HeroStyle.Framed) DetailsLayout.actionsSideFramed else Space.gutter,
                label = "side",
            )
            PassAndLike(
                source = source,
                onPass = onPass,
                onLike = onLike,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(start = side, end = side, bottom = bottom + navigation),
            )
        }

        AnimatedVisibility(heroGone, Modifier.align(Alignment.TopCenter), enter = fadeIn(), exit = fadeOut()) {
            DetailsBar(card, number, statusTop, onDismiss, if (hasMore) { { more = true } } else null)
        }

        SnackbarHost(
            snackbar,
            Modifier.align(Alignment.BottomCenter).padding(start = Space.gutter, end = Space.gutter, bottom = navigation + DetailsLayout.actionsRoom),
        ) { data -> AppSnackbar(data.visuals.message) }
    }

    if (more) {
        MoreSheet(
            card = card,
            onDismiss = { more = false },
            onMessage = writeTo,
            onReport = onReport,
            onBlock = onBlock,
        )
    }
}

/**
 * The first screen: the photos and the person's line. Bleed: the photo edge
 * to edge, the top (190 dp) and bottom (56 %) scrims, the story bars 8 dp
 * under the status bar, the glass close and «بیشتر», the name 124 dp above
 * the bottom. Card: a plain header, the photo inset from 92 dp to 196 dp
 * above the bottom with `--r-photo` corners and its 84 dp scrim at 70 %, the
 * name in ink 12 dp under it.
 */
@Composable
private fun Hero(
    card: ProfileCard,
    height: Dp,
    statusTop: Dp,
    navigation: Dp,
    number: (Int) -> String,
    photoIndex: Int,
    onPhotoIndex: (Int) -> Unit,
    onLikePhoto: ((Int) -> Unit)?,
    onClose: () -> Unit,
    onMore: (() -> Unit)?,
    withActions: Boolean,
) {
    val t = AppTheme.template
    val bleed = t.switches.deck == DeckStyle.Bleed
    val backdrop = rememberGlassBackdrop()
    // The first screen's only words: TalkBack reads them as the page's heading.
    val spoken = cardDescription(card, number)
    val below = when {
        !withActions -> DetailsLayout.infoBottomNoActions
        bleed -> DetailsLayout.infoBottom
        else -> DetailsLayout.infoBottomCard
    }
    if (bleed) {
        Box(Modifier.fillMaxWidth().height(height)) {
            Box(Modifier.fillMaxSize().glassSource(backdrop)) {
                PhotoPager(card, number, photoIndex, onPhotoIndex, onLikePhoto, Modifier.fillMaxSize())
            }
            PhotoScrimTop()
            PhotoScrimBottom(Modifier.align(Alignment.BottomCenter).fillMaxHeight(DetailsLayout.BOTTOM_SCRIM))
            Stories(card, photoIndex, Modifier.padding(top = statusTop + DetailsLayout.storyBelowStatus))
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = statusTop + DetailsLayout.chromeBelowStatus, start = DetailsLayout.chromeSide, end = DetailsLayout.chromeSide),
            ) {
                AppIconButton(AppIcons.ChevronDown, brandString(R.string.profile_view_close), onClose, kind = IconButtonKind.Glass, backdrop = backdrop)
                Spacer(Modifier.weight(1f))
                if (onMore != null) AppIconButton(AppIcons.More, brandString(R.string.profile_view_more), onMore, kind = IconButtonKind.Glass, backdrop = backdrop)
            }
            CardInfo(
                card,
                number,
                onPhoto = true,
                modifier = Modifier.align(Alignment.BottomStart).padding(start = Space.gutter, end = Space.gutter, bottom = below + navigation),
                description = spoken,
            )
        }
    } else {
        Column(Modifier.fillMaxWidth().height(height)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = statusTop + DetailsLayout.headerBelowStatus, start = DetailsLayout.headerSide, end = DetailsLayout.headerSide),
            ) {
                AppIconButton(AppIcons.ChevronDown, brandString(R.string.profile_view_close), onClose)
                Spacer(Modifier.weight(1f))
                if (onMore != null) AppIconButton(AppIcons.More, brandString(R.string.profile_view_more), onMore)
            }
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(start = Space.gutter, end = Space.gutter, top = DetailsLayout.photoBelowHeader)
                    .clip(RoundedCornerShape(t.radii.photo))
                    .background(t.colors.photoPlaceholder),
            ) {
                PhotoPager(card, number, photoIndex, onPhotoIndex, onLikePhoto, Modifier.fillMaxSize())
                PhotoScrimTop(Modifier.alpha(DetailsLayout.CARD_SCRIM_ALPHA), height = DetailsLayout.cardScrim)
                Stories(card, photoIndex, Modifier.padding(top = DetailsLayout.storyInset))
            }
            Spacer(Modifier.height(DetailsLayout.infoBelowPhoto))
            CardInfo(card, number, onPhoto = false, modifier = Modifier.padding(horizontal = Space.gutter), description = spoken)
            Spacer(Modifier.height(below + navigation))
        }
    }
}

@Composable
private fun Stories(card: ProfileCard, index: Int, modifier: Modifier) {
    if (card.photos.size > 1) {
        StoryProgress(card.photos.size, current = index, progress = 1f, modifier = modifier.clearAndSetSemantics { })
    }
}

/**
 * The photos one at a time: tapping the end side of the reading direction
 * shows the next, the start side the one before; a long press likes the
 * photo shown. TalkBack hears the position and has the same as actions.
 */
@Composable
private fun PhotoPager(
    card: ProfileCard,
    number: (Int) -> String,
    index: Int,
    onIndex: (Int) -> Unit,
    onLike: ((Int) -> Unit)?,
    modifier: Modifier,
) {
    val photos = card.photos
    val shown = index.coerceIn(0, (photos.size - 1).coerceAtLeast(0))
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val position = brandString(R.string.profile_view_photo, number(shown + 1), number(photos.size.coerceAtLeast(1)))
    val pager = brandString(R.string.profile_view_photos, isolate(card.name))
    val nextLabel = brandString(R.string.deck_action_next_photo)
    val previousLabel = brandString(R.string.deck_action_previous_photo)
    val likeLabel = brandString(R.string.like_photo)
    PhotoImage(
        photo = photos.getOrNull(shown),
        contentDescription = null,
        alignment = DetailsLayout.photoAlignment,
        modifier = modifier
            .pointerInput(card.id, rtl, photos.size, onLike) {
                detectTapGestures(
                    onTap = { offset ->
                        val endSide = if (rtl) offset.x < size.width / 2f else offset.x > size.width / 2f
                        val next = if (endSide) shown + 1 else shown - 1
                        if (next in photos.indices) onIndex(next)
                    },
                    onLongPress = { onLike?.invoke(shown) },
                )
            }
            .semantics {
                // What it is, then where it stands: read once each.
                contentDescription = pager
                stateDescription = position
                customActions = buildList {
                    if (shown + 1 < photos.size) add(CustomAccessibilityAction(nextLabel) { onIndex(shown + 1); true })
                    if (shown > 0) add(CustomAccessibilityAction(previousLabel) { onIndex(shown - 1); true })
                    if (onLike != null) add(CustomAccessibilityAction(likeLabel) { onLike(shown); true })
                }
            },
    )
}

/** A section of the page in the 20 dp gutter, [top] under the one before. */
@Composable
private fun Block(top: Dp, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, top = top)) { content() }
}

/**
 * The fact grid: what they look for and the catalogue's public fields
 * (a height in the reader's words, «۱۶۸ سانت»), three to a row.
 */
@Composable
private fun FactGrid(card: ProfileCard, catalog: Catalog, section: ProfileSection.Fields, number: (Int) -> String) {
    val defs = catalog.fields.associateBy { it.id }
    val values = card.fields.associateBy { it.fieldId }
    val facts = section.lines.map { line ->
        val def = defs[line.fieldId]
        val n = values[line.fieldId]?.number
        val cm = def?.kind == "number" && n != null && (def.unit.equals(CM, ignoreCase = true) || (def.unit.isNullOrEmpty() && def.key == HEIGHT))
        Fact(line.label, if (cm) brandString(R.string.profile_fact_cm, number(n)) else line.value)
    }.toMutableList()
    intentionLabel(section.intention, catalog)?.let { label ->
        facts.add(minOf(INTENTION_AT, facts.size), Fact(brandString(R.string.profile_fact_looking_for), label))
    }
    FactRow(facts)
}

private const val CM = "cm"
private const val HEIGHT = "height"

/**
 * [bars] levels in 0..1 for a voice answer's waveform: an envelope that is
 * low at the ends (a breath before and after) times two slow waves whose
 * pace and phase come from [seed], plus a little grain, so two answers do
 * not look alike and none reads as a barcode.
 */
internal fun waveLevels(seed: Int, bars: Int): List<Float> {
    val random = kotlin.random.Random(seed)
    val slow = 1.6f + random.nextFloat() * 1.2f
    val fast = 4.5f + random.nextFloat() * 2.5f
    val p1 = random.nextFloat() * TWO_PI
    val p2 = random.nextFloat() * TWO_PI
    return List(bars) { i ->
        val x = (i + 0.5f) / bars
        val envelope = 0.25f + 0.75f * kotlin.math.sin(Math.PI.toFloat() * x)
        val motion = 0.55f + 0.28f * kotlin.math.sin(TWO_PI * slow * x + p1) + 0.17f * kotlin.math.sin(TWO_PI * fast * x + p2)
        val grain = (random.nextFloat() - 0.5f) * 0.16f
        (envelope * motion + grain).coerceIn(0f, 1f)
    }
}

private const val TWO_PI = (2 * Math.PI).toFloat()

/** Where «دنبال» sits in the grid: after height and education, as the design orders the facts. */
private const val INTENTION_AT = 2

/**
 * A voice answer: the question (`--type-section`, `--text-2`), the 48 dp
 * play (`--primary-fill`), the waveform in `--wave` and the length. Playing
 * is not in this version yet; the play says so.
 */
@Composable
private fun VoiceCard(question: String?, prompt: ProfilePrompt, number: (Int) -> String, onPlay: () -> Unit, onLike: (() -> Unit)?) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    val seconds = ((prompt.audioMs ?: 0) + 999) / 1000
    val length = "${number(seconds / 60)}:${number(seconds % 60).padStart(2, number(0).first())}"
    val play = brandString(R.string.profile_view_play)
    Column(Modifier.fillMaxWidth().templateCard(shape).padding(horizontal = DetailsLayout.voicePadH, vertical = DetailsLayout.voicePadV)) {
        if (question != null) Text(question, style = t.type.section, color = t.colors.text2)
        Row(Modifier.fillMaxWidth().padding(top = DetailsLayout.voiceGap), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(DetailsLayout.play)
                    .clip(CircleShape)
                    .background(t.paints.primaryFill, CircleShape)
                    .insetShadow(CircleShape, t.shadows.btnHighlight)
                    .clickable(role = Role.Button, onClick = onPlay)
                    .semantics { contentDescription = play },
                contentAlignment = Alignment.Center,
            ) {
                Icon(AppIcons.Play, contentDescription = null, tint = t.colors.onPrimary, modifier = Modifier.size(DetailsLayout.playIcon))
            }
            Wave(prompt.promptId, Modifier.weight(1f).padding(horizontal = DetailsLayout.voiceGap))
            Text(length, style = t.type.caption, color = t.colors.text3)
            if (onLike != null) {
                Spacer(Modifier.width(DetailsLayout.voiceGap))
                LikeAnswerButton(onLike)
            }
        }
    }
}

/**
 * The waveform: 24 bars in `--wave`, none played yet. Their heights follow
 * a speech-like line fixed by the answer ([waveLevels]): low at both ends,
 * rising and falling in between, never a flat row of equal bars.
 */
@Composable
private fun Wave(seed: Int, modifier: Modifier) {
    val t = AppTheme.template
    val heights = remember(seed) {
        waveLevels(seed, DetailsLayout.WAVE_BARS).map { DetailsLayout.waveMin + (DetailsLayout.waveMax - DetailsLayout.waveMin) * it }
    }
    Row(
        modifier.height(DetailsLayout.waveMax).clearAndSetSemantics { },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        heights.forEach { h ->
            Box(Modifier.width(DetailsLayout.waveBar).height(h).clip(CircleShape).background(t.colors.wave.copy(alpha = DetailsLayout.WAVE_REST)))
        }
    }
}

/**
 * One more photo between the sections: neon full width with a 90 dp fade
 * from the page at its top; white inset 20 dp with `--r-photo` corners and a
 * hard edge. Tapping it likes it (the like-a-photo sheet).
 */
@Composable
private fun InlinePhoto(card: ProfileCard, section: ProfileSection.PhotoBlock, number: (Int) -> String, onLike: (() -> Unit)?) {
    val t = AppTheme.template
    val framed = t.switches.hero == HeroStyle.Framed
    val ratio = section.photo.let { if (it.w > 0 && it.h > 0) (it.w.toFloat() / it.h).coerceIn(MIN_RATIO, MAX_RATIO) else DEFAULT_RATIO }
    val description = brandString(R.string.profile_view_photo, number(section.index + 1), number(section.count))
    val likeLabel = brandString(R.string.like_photo)
    val shape = RoundedCornerShape(if (framed) t.radii.photo else 0.dp)
    Box(
        Modifier
            .padding(top = DetailsLayout.sectionGap)
            .padding(horizontal = if (framed) Space.gutter else 0.dp)
            .fillMaxWidth()
            .aspectRatio(ratio)
            .clip(shape)
            .background(t.colors.photoPlaceholder)
            .then(if (onLike != null) Modifier.clickable(onClickLabel = likeLabel, role = Role.Image, onClick = onLike) else Modifier)
            .semantics(mergeDescendants = true) { contentDescription = description },
    ) {
        PhotoImage(section.photo, contentDescription = null, alignment = DetailsLayout.photoAlignment, modifier = Modifier.fillMaxSize())
        if (!framed) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(DetailsLayout.photoFade)
                    .background(Brush.verticalGradient(listOf(t.colors.bg, t.colors.bg.copy(alpha = 0f)))),
            )
        }
    }
}

private const val MIN_RATIO = 0.62f
private const val MAX_RATIO = 1.2f
private const val DEFAULT_RATIO = 0.8f

/** A hairline, then «گزارش {name}» (neutral) and «مسدودش کن» (`--error`) as text buttons. */
@Composable
private fun Safety(card: ProfileCard, onReport: (() -> Unit)?, onBlock: (() -> Unit)?) {
    Column(Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, top = DetailsLayout.safetyTop)) {
        HorizontalDivider(thickness = 1.dp, color = AppTheme.template.colors.line)
        Row(
            Modifier.fillMaxWidth().padding(top = DetailsLayout.safetyGap),
            horizontalArrangement = Arrangement.spacedBy(DetailsLayout.safetyBetween, Alignment.CenterHorizontally),
        ) {
            if (onReport != null) TextAction(brandString(R.string.profile_report, isolate(card.name)), onReport, kind = TextActionKind.Neutral)
            if (onBlock != null) TextAction(brandString(R.string.profile_block), onBlock, kind = TextActionKind.Destructive)
        }
    }
}

/**
 * The app bar once the first screen has gone (88 dp with the status bar,
 * `--surface-bar`, a hairline under it): the close, the 36 dp face,
 * «{name}، {age}» in `--type-h3` with the badge, «بیشتر».
 */
@Composable
private fun DetailsBar(card: ProfileCard, number: (Int) -> String, statusTop: Dp, onClose: () -> Unit, onMore: (() -> Unit)?) {
    val t = AppTheme.template
    Column(Modifier.fillMaxWidth().background(t.colors.surfaceBar)) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = statusTop, start = DetailsLayout.barStart, end = DetailsLayout.barEnd)
                .height(DetailsLayout.appBar),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AppIconButton(AppIcons.ChevronDown, brandString(R.string.profile_view_close), onClose)
            val face = card.photos.firstOrNull()
            Avatar(DetailsLayout.face, photo = if (face != null) { { PhotoImage(face, null, Modifier.fillMaxSize()) } } else null)
            Row(
                Modifier.weight(1f).padding(start = DetailsLayout.nameStart).semantics(mergeDescendants = true) { heading() },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    nameAndAge(card, number),
                    style = t.type.h3,
                    color = t.colors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (card.verified) VerifiedBadge(DetailsLayout.badge, Modifier.padding(start = DetailsLayout.badgeGap))
            }
            if (onMore != null) AppIconButton(AppIcons.More, brandString(R.string.profile_view_more), onMore)
        }
        HorizontalDivider(thickness = 1.dp, color = t.colors.line)
    }
}

/** Pass at the left and like at the right (68 dp each), whatever the reading direction, as on the deck. */
@Composable
private fun PassAndLike(source: DetailsSource, onPass: () -> Unit, onLike: () -> Unit, modifier: Modifier) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            DeckActionButton(DeckAction.Pass, onPass, description = brandString(R.string.deck_action_pass))
            DeckActionButton(
                DeckAction.Like,
                onLike,
                description = brandString(if (source == DetailsSource.Likes) R.string.profile_view_like_back else R.string.deck_action_like),
            )
        }
    }
}

/** «بیشتر»: write to them (before a match), report, block. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun MoreSheet(
    card: ProfileCard,
    onDismiss: () -> Unit,
    onMessage: (() -> Unit)?,
    onReport: (() -> Unit)?,
    onBlock: (() -> Unit)?,
) {
    AppBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, bottom = DetailsLayout.sheetBottom)) {
            var first = true
            fun divider(): Boolean = (!first).also { first = false }
            if (onMessage != null) {
                SettingsRow(brandString(R.string.request_write_to), end = RowEnd.None, divider = divider(), minHeight = DetailsLayout.sheetRow, onClick = { onDismiss(); onMessage() })
            }
            if (onReport != null) {
                SettingsRow(brandString(R.string.profile_report, isolate(card.name)), end = RowEnd.None, divider = divider(), minHeight = DetailsLayout.sheetRow, onClick = { onDismiss(); onReport() })
            }
            if (onBlock != null) {
                SettingsRow(brandString(R.string.profile_block), end = RowEnd.None, danger = true, divider = divider(), minHeight = DetailsLayout.sheetRow, onClick = { onDismiss(); onBlock() })
            }
        }
    }
}

/** The profile's layout, from the design's 412 × 892 boards (m04/h03, m05/h04). */
private object DetailsLayout {
    val statusBar = 32.dp
    val appBar = 56.dp
    val rise = 64.dp
    val storyBelowStatus = 8.dp
    val storyInset = 12.dp
    val chromeBelowStatus = 20.dp
    val chromeSide = 12.dp
    val headerBelowStatus = 8.dp
    val headerSide = 8.dp
    val photoBelowHeader = 4.dp
    val cardScrim = 84.dp
    const val CARD_SCRIM_ALPHA = 0.7f
    const val BOTTOM_SCRIM = 0.56f
    val infoBelowPhoto = 12.dp
    val infoBottom = 124.dp
    val infoBottomCard = 118.dp
    val infoBottomNoActions = 34.dp
    val actionsBottomHero = 34.dp
    val actionsBottomDetails = 28.dp
    val actionsSideFramed = 32.dp
    val actionsRoom = 112.dp
    val endPadding = 30.dp
    val firstGap = 20.dp
    val factsGap = 20.dp
    val sectionGap = 26.dp
    val labelGap = 10.dp
    val photoFade = 90.dp
    val photoAlignment = BiasAlignment(0f, -0.7f)
    val voicePadH = 18.dp
    val voicePadV = 16.dp
    val voiceGap = 12.dp
    val play = 48.dp
    val playIcon = 20.dp
    const val WAVE_BARS = 24
    val waveMin = 7.dp
    val waveMax = 24.dp
    val waveBar = 3.dp
    const val WAVE_REST = 0.45f
    val safetyTop = 24.dp
    val safetyGap = 10.dp
    val safetyBetween = 8.dp
    val barStart = 8.dp
    val barEnd = 6.dp
    val face = 36.dp
    val nameStart = 8.dp
    val badge = 20.dp
    val badgeGap = 6.dp
    val sheetBottom = 30.dp
    val sheetRow = 52.dp
}
