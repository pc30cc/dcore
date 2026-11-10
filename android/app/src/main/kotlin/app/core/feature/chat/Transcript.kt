package app.core.feature.chat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.call.CallLineRow
import app.core.feature.call.callDuration
import app.core.feature.call.rememberLanguage
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.ConversationSource
import app.core.model.MessageKind
import app.core.model.Photo
import app.core.model.ProblemCodes
import app.core.sync.ChatErrors
import app.core.ui.components.AppIconButton
import app.core.ui.components.BUBBLE_MAX
import app.core.ui.components.ChatBubbleFrame
import app.core.ui.components.ChatBubbleMeta
import app.core.ui.components.ChatSystemLine
import app.core.ui.components.IconButtonKind
import app.core.ui.components.TextAction
import app.core.ui.components.overhangingTarget
import app.core.ui.components.skeleton
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Space
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

/** The transcript: newest at the bottom, older pages as the person scrolls up. */
@Composable
internal fun Transcript(state: ChatUiState, actions: ChatActions, onSheet: (ChatSheet) -> Unit, onVoice: () -> Unit = {}, now: Instant = rememberMinuteNow()) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val clock = rememberChatClock()
    val items = state.items
    val newest = items.firstOrNull()?.key
    // Moves with the minute clock: a thread left open past midnight calls the new day "Today".
    val today = rememberToday(now)
    val rows = items.count { it is ChatItem.Bubble || it is ChatItem.Call }

    // Stay at the newest message when one arrives and the person was there
    // already (the line that was newest is still on screen), or wrote it;
    // otherwise offer a way down. The first line of a new day brings its day
    // separator with it, so the old newest line is then two rows up, not one.
    val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex <= 1 } }
    val shown = remember { ShownNewest() }
    LaunchedEffect(newest) {
        val mine = (items.firstOrNull() as? ChatItem.Bubble)?.message?.mine == true
        val previous = shown.key
        val wasThere = previous == null || list.layoutInfo.visibleItemsInfo.any { it.key == previous }
        shown.key = newest
        if (wasThere || atBottom || mine) list.animateScrollToItem(0)
    }
    // Typing is the newest row: someone reading the newest message sees it come in.
    LaunchedEffect(state.typing) {
        if (state.typing && list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0)
    }
    LaunchedEffect(list, rows) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .collect { last -> if (rows > 0 && last >= list.layoutInfo.totalItemsCount - TOP_MARGIN) actions.nearTop(rows) }
    }

    // Only your newest message says when it went and how far it got («۱۸:۲۵، دیده شد»); a pending one says it is on its way.
    val newestOwn = items.firstOrNull { it is ChatItem.Bubble && it.message.mine && it.unsent == null }?.key
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val bubbleMax = (maxWidth * BUBBLE_SHARE).coerceAtMost(BUBBLE_MAX)
        LazyColumn(
            state = list,
            reverseLayout = true,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = Space.gutter, vertical = TranscriptLayout.edge),
        ) {
            if (state.typing) item(key = "typing") { TypingBubble(peerName(state)) }
            items(items, key = { it.key }) { item ->
                when (item) {
                    is ChatItem.Bubble -> BubbleRow(item, bubbleMax, clock, state, actions, onSheet, onVoice, meta = item.key == newestOwn)
                    is ChatItem.Call -> CallLine(item, state)
                    is ChatItem.Day -> ChatSystemLine(dayHeader(clock, item.date, today))
                    is ChatItem.Intro -> Intro(item, clock, now)
                }
            }
            if (state.olderLoading) {
                item(key = "older-loading") {
                    val t = AppTheme.template
                    Box(Modifier.fillMaxWidth().padding(Space.lg), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = t.colors.text3, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                    }
                }
            } else if (state.olderFailed) {
                item(key = "older-failed") {
                    val t = AppTheme.template
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(brandString(R.string.chat_older_failed), style = t.type.caption, color = t.colors.text3)
                        TextAction(brandString(R.string.action_try_again), actions::retryOlder)
                    }
                }
            }
        }
        if (!atBottom) {
            AppIconButton(
                AppIcons.ChevronDown,
                brandString(R.string.chat_jump_newest),
                onClick = { scope.launch { list.animateScrollToItem(0) } },
                kind = IconButtonKind.Tonal,
                size = TranscriptLayout.jump,
                modifier = Modifier.align(Alignment.BottomEnd).padding(TranscriptLayout.jumpInset),
            )
        }
    }
}

/** A bubble takes at most this share of the thread's width, and never more than 286 dp. */
private const val BUBBLE_SHARE = 0.78f

private const val TOP_MARGIN = 4

/** The newest line the transcript last showed, read when the next one arrives (not drawn). */
private class ShownNewest {
    var key: Any? = null
}

/**
 * The top of a thread, as one system line: when they matched («۳ روز پیش
 * مچ شدین», «امروز مچ شدین»), or that it began with a message request.
 */
@Composable
private fun Intro(item: ChatItem.Intro, clock: ChatClockText, now: Instant) {
    val conversation = item.conversation
    val text = if (conversation.source == ConversationSource.Request) {
        brandString(R.string.chat_intro_request)
    } else {
        matchedAgo(clock, conversation.createdAt, now)
    }
    ChatSystemLine(text)
}

/** «امروز مچ شدین», «دیروز مچ شدین», «۳ روز پیش مچ شدین», by calendar days in the reader's zone. */
@Composable
internal fun matchedAgo(clock: ChatClockText, at: Instant, now: Instant): String {
    val days = Duration.between(clock.date(at).atStartOfDay(), clock.date(now).atStartOfDay()).toDays().coerceAtLeast(0)
    return when (days) {
        0L -> brandString(R.string.chat_matched_today)
        1L -> brandString(R.string.chat_matched_yesterday)
        else -> {
            val resources = androidx.compose.ui.platform.LocalResources.current
            resources.getQuantityString(R.plurals.chat_matched_days, days.toInt(), clock.digits(days.toString()))
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BubbleRow(
    item: ChatItem.Bubble,
    maxWidth: Dp,
    clock: ChatClockText,
    state: ChatUiState,
    actions: ChatActions,
    onSheet: (ChatSheet) -> Unit,
    onVoice: () -> Unit,
    meta: Boolean,
) {
    val t = AppTheme.template
    val message = item.message
    val mine = message.mine
    val haptics = LocalHapticFeedback.current
    val unsent = item.unsent != null
    val content = when {
        unsent -> t.colors.text3
        mine -> t.colors.onBubbleOut
        else -> t.colors.onBubbleIn
    }
    val time = clock.time(message.at)
    val description = bubbleDescription(item, time)
    val openSheet = {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        onSheet(ChatSheet.Message(item))
    }
    val failed = item.delivery == Delivery.Failed
    val actionsLabel = brandString(R.string.chat_message_actions)
    val metaText = when {
        unsent || failed || item.delivery == Delivery.Confirm -> null
        item.delivery == Delivery.Pending -> brandString(R.string.chat_status_sending)
        meta -> metaLine(time, item.delivery)
        else -> null
    }
    // Read receipts are the plan's: the newest message's «رسید» opens the plans, nothing in the thread says so.
    val paywall = app.core.feature.paywall.LocalPaywall.current
    val seeRead = brandString(R.string.chat_read_receipts_upsell)
    val metaClick = if (meta && state.readReceiptsLocked && (item.delivery == Delivery.Delivered || item.delivery == Delivery.Sent)) {
        Modifier.clickable(role = Role.Button, onClickLabel = seeRead) { paywall.plans(app.core.feature.paywall.PaywallEntry.READ_RECEIPTS) }
    } else {
        Modifier
    }

    Column(
        Modifier.fillMaxWidth().padding(top = TranscriptLayout.gap),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        Box {
            ChatBubbleFrame(
                mine = mine,
                tail = !item.joinsOlder,
                outline = unsent,
                maxWidth = maxWidth,
                interaction = Modifier
                    .combinedClickable(
                        onClick = { if (failed) onSheet(ChatSheet.Message(item)) },
                        onLongClick = openSheet,
                        onLongClickLabel = actionsLabel,
                    )
                    .semantics(mergeDescendants = true) {
                        contentDescription = description
                        customActions = listOf(CustomAccessibilityAction(actionsLabel) { onSheet(ChatSheet.Message(item)); true })
                    },
            ) {
                BubbleContent(item, content, mine, onVoice)
                if (metaText != null) ChatBubbleMeta(metaText, mine, metaClick.testTag(metaTag(item.delivery)))
            }
            if (item.reactions.isNotEmpty() && !unsent) {
                Text(
                    item.reactions.distinct().joinToString(" ") + if (item.reactions.size > 1) " ${clock.digits(item.reactions.size.toString())}" else "",
                    style = t.type.labelSm,
                    color = t.colors.text,
                    modifier = Modifier
                        .align(if (mine) Alignment.BottomStart else Alignment.BottomEnd)
                        .offset(y = TranscriptLayout.reactionDrop)
                        .background(t.colors.surface2, RoundedCornerShape(t.radii.chip))
                        .padding(horizontal = TranscriptLayout.reactionPadH, vertical = TranscriptLayout.reactionPadV),
                )
            }
        }
        if (item.reactions.isNotEmpty() && !unsent) Spacer(Modifier.height(TranscriptLayout.reactionDrop))
        if (failed || item.delivery == Delivery.Confirm) FailedLine(message.errorCode) { onSheet(ChatSheet.Message(item)) }
    }
}

/** Your newest message's line: «۱۸:۲۵، دیده شد» / "6:25 PM, seen" (the time alone for any other state). */
@Composable
private fun metaLine(time: String, delivery: Delivery?): String = when (delivery) {
    Delivery.Sent -> brandString(R.string.chat_meta_sent, time)
    Delivery.Delivered -> brandString(R.string.chat_meta_delivered, time)
    Delivery.Read -> brandString(R.string.chat_meta_seen, time)
    else -> time
}

@Composable
private fun BubbleContent(item: ChatItem.Bubble, content: Color, mine: Boolean, onVoice: () -> Unit) {
    val t = AppTheme.template
    val message = item.message
    // What people write takes its own direction: English in a Persian thread reads left to right, and the other way round.
    val body = t.type.body.copy(textDirection = TextDirection.Content)
    when {
        item.unsent == Unsent.Removed -> Placeholder(brandString(R.string.chat_removed), content)
        item.unsent == Unsent.BySender -> Placeholder(brandString(if (mine) R.string.chat_unsent_mine else R.string.chat_unsent_theirs), content)
        else -> when (message.kind) {
            MessageKind.Text -> Text(message.body.orEmpty(), style = body, color = content)
            // The note as a plain bubble: the message does not carry what was liked, so there is
            // no quote (`.qbox`) to draw, and no line is written in its place. TalkBack hears
            // that it was a like's note.
            MessageKind.LikeNote -> {
                val note = message.body?.takeIf { it.isNotBlank() }
                if (note != null) {
                    Text(note, style = body, color = content)
                } else {
                    Text(brandString(if (mine) R.string.chat_like_note_mine else R.string.chat_like_note_theirs), style = body, color = content)
                }
            }
            MessageKind.Image, MessageKind.Gif -> {
                val media = message.media
                if (media != null) {
                    val ratio = if ((media.w ?: 0) > 0 && (media.h ?: 0) > 0) (media.w!!.toFloat() / media.h!!).coerceIn(0.5f, 2f) else 1f
                    PhotoImage(
                        photo = Photo(id = message.localId, w = media.w ?: 0, h = media.h ?: 0, blurhash = media.blurhash.orEmpty(), url = media.url),
                        contentDescription = brandString(R.string.chat_photo),
                        modifier = Modifier.width(TranscriptLayout.photo).aspectRatio(ratio).clip(RoundedCornerShape(t.radii.md)),
                    )
                } else {
                    Text(message.body ?: brandString(R.string.chat_photo), style = body, color = content)
                }
            }
            MessageKind.Voice -> VoiceMessage(item, mine, onVoice)
            else -> Placeholder(brandString(R.string.chat_unknown), content)
        }
    }
}

/**
 * A voice message (`.vm`): the 34 dp play (48 dp target), the waveform and
 * its length («۰:۱۸»). Playing is not in this version yet: the play says so.
 */
@Composable
private fun VoiceMessage(item: ChatItem.Bubble, mine: Boolean, onPlay: () -> Unit) {
    val t = AppTheme.template
    val seconds = ((item.message.media?.durationMs ?: 0) + 999) / 1000
    val ink = if (mine) t.colors.onBubbleOut else t.colors.onBubbleIn
    val play = brandString(R.string.chat_voice_play)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TranscriptLayout.voiceGap)) {
        // The 34 dp play keeps the bubble at the design's height: its 48 dp target reaches over the padding.
        Box(
            Modifier
                .overhangingTarget(onClick = onPlay, target = TranscriptLayout.voiceTarget)
                .semantics { contentDescription = play },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(TranscriptLayout.voicePlay).background(ink, CircleShape), contentAlignment = Alignment.Center) {
                Icon(AppIcons.Play, contentDescription = null, tint = if (mine) t.colors.primary else t.colors.bubbleIn, modifier = Modifier.size(TranscriptLayout.voiceIcon))
            }
        }
        Wave(item.key.hashCode(), ink, Modifier.width(TranscriptLayout.waveWidth))
        if (seconds > 0) Text(callDuration(seconds.toLong(), rememberLanguage()), style = t.type.caption, color = if (mine) t.colors.onBubbleOut2 else t.colors.text3)
    }
}

/** The waveform: bars 3 dp wide, their heights fixed by the message, none played yet. */
@Composable
private fun Wave(seed: Int, color: Color, modifier: Modifier) {
    val heights = remember(seed) {
        val random = kotlin.random.Random(seed)
        List(WAVE_BARS) { TranscriptLayout.waveMin + (TranscriptLayout.waveMax - TranscriptLayout.waveMin) * random.nextFloat() }
    }
    Row(
        modifier.height(TranscriptLayout.waveMax).clearAndSetSemantics { },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        heights.forEach { h ->
            Box(Modifier.width(TranscriptLayout.waveBar).height(h).clip(CircleShape).background(color.copy(alpha = WAVE_REST)))
        }
    }
}

private const val WAVE_BARS = 26

/** `.wave i{opacity:.45}`: bars not played yet. */
private const val WAVE_REST = 0.45f

@Composable
private fun Placeholder(text: String, content: Color) {
    Text(text, style = AppTheme.template.type.bodySm, fontStyle = FontStyle.Italic, color = content)
}

/** A bubble's meta line, for tests: by its delivery state. */
internal fun metaTag(delivery: Delivery?): String = "chat.meta.${delivery?.name?.lowercase() ?: "none"}"

@Composable
private fun FailedLine(code: String?, onClick: () -> Unit) {
    val t = AppTheme.template
    val text = when (code) {
        ProblemCodes.MESSAGE_REFUSED, ProblemCodes.TEXT_REFUSED -> brandString(R.string.chat_not_sent_refused)
        ChatErrors.EXPIRED -> brandString(R.string.chat_not_sent_expired)
        ProblemCodes.CONVERSATION_ENDED -> brandString(R.string.chat_ended_title)
        else -> brandString(R.string.chat_not_sent)
    }
    Text(
        text,
        style = t.type.caption,
        color = t.colors.error,
        modifier = Modifier
            .clip(RoundedCornerShape(t.radii.xs))
            .clickable(onClick = onClick)
            .padding(horizontal = TranscriptLayout.failedPadH, vertical = TranscriptLayout.failedPadV),
    )
}

/** What TalkBack reads for a bubble: who, what, when, and where it is. */
@Composable
private fun bubbleDescription(item: ChatItem.Bubble, time: String): String {
    val m = item.message
    val text = when {
        item.unsent == Unsent.Removed -> brandString(R.string.chat_removed)
        item.unsent == Unsent.BySender -> brandString(if (m.mine) R.string.chat_unsent_mine else R.string.chat_unsent_theirs)
        m.kind == MessageKind.Text -> m.body.orEmpty()
        m.kind == MessageKind.LikeNote -> listOfNotNull(
            brandString(if (m.mine) R.string.chat_like_note_mine else R.string.chat_like_note_theirs),
            m.body,
        ).joinToString(": ")
        m.kind == MessageKind.Image || m.kind == MessageKind.Gif -> brandString(R.string.chat_photo)
        m.kind == MessageKind.Voice -> brandString(R.string.chat_preview_voice)
        else -> brandString(R.string.chat_unknown)
    }
    val status = when (item.delivery) {
        Delivery.Pending -> brandString(R.string.chat_status_sending)
        Delivery.Sent -> brandString(R.string.chat_status_sent)
        Delivery.Delivered -> brandString(R.string.chat_status_delivered)
        Delivery.Read -> brandString(R.string.chat_status_read)
        Delivery.Failed, Delivery.Confirm -> brandString(R.string.chat_not_sent)
        null -> null
    }
    val who = if (m.mine) brandString(R.string.chat_you) else null
    val reactions = item.reactions.takeIf { it.isNotEmpty() }?.let { brandString(R.string.chat_reactions, it.joinToString(" ")) }
    return listOfNotNull(who, text, time, status, reactions).joinToString(brandString(R.string.chat_list_separator))
}

/** A call's line: the call feature's own row, with "call back" while both still allow calls. */
@Composable
private fun CallLine(item: ChatItem.Call, state: ChatUiState) {
    val call = item.message.call ?: return
    val conversation = state.conversation
    val callBack = LocalChatCallBack.current
    val onCallBack = if (callBack != null && conversation != null && conversation.callsAllowed.both && !state.ended) {
        { callBack(conversation, call.kind) }
    } else {
        null
    }
    CallLineRow(call, me = state.me, at = item.message.at, onCallBack = onCallBack)
}

@Composable
private fun TypingBubble(name: String) {
    val t = AppTheme.template
    val reduced = LocalReducedMotion.current
    val description = brandString(R.string.chat_typing_a11y, name)
    Row(Modifier.fillMaxWidth().padding(top = TranscriptLayout.gap)) {
        Row(
            Modifier
                .clip(RoundedCornerShape(t.radii.bubble))
                .background(t.colors.bubbleIn)
                .padding(horizontal = TranscriptLayout.typingPadH, vertical = TranscriptLayout.typingPadV)
                .clearAndSetSemantics {
                    contentDescription = description
                    liveRegion = LiveRegionMode.Polite
                },
            horizontalArrangement = Arrangement.spacedBy(TranscriptLayout.typingGap),
        ) {
            // The design's still (1, .7, .45 from the start side) is the first frame; the
            // darkest dot then moves along, one step every TYPING_STEP_MS.
            val transition = rememberInfiniteTransition(label = "typing")
            val phase = if (reduced) {
                0f
            } else {
                transition.animateFloat(
                    initialValue = 0f,
                    targetValue = TYPING_REST.size.toFloat(),
                    animationSpec = infiniteRepeatable(tween(durationMillis = TYPING_STEP_MS * TYPING_REST.size, easing = LinearEasing), RepeatMode.Restart),
                    label = "dots",
                ).value
            }
            repeat(TYPING_REST.size) { i ->
                Box(Modifier.size(TranscriptLayout.typingDot).alpha(typingAlpha(i, phase)).clip(CircleShape).background(t.colors.text3))
            }
        }
    }
}

private val TYPING_REST = listOf(1f, 0.7f, 0.45f)
private const val TYPING_STEP_MS = 360

/** Dot [i]'s alpha at [phase] (0 until 3): the resting fade shifted along by the phase, blended between steps. */
internal fun typingAlpha(i: Int, phase: Float): Float {
    val n = TYPING_REST.size
    val at = ((i - phase) % n + n) % n
    val from = at.toInt() % n
    val to = (from + 1) % n
    val f = at - at.toInt()
    return TYPING_REST[from] + (TYPING_REST[to] - TYPING_REST[from]) * f
}

@Composable
internal fun TranscriptSkeleton() {
    val t = AppTheme.template
    val loading = brandString(R.string.chat_loading_messages)
    Column(
        Modifier.fillMaxSize().padding(horizontal = Space.gutter, vertical = Space.md).semantics { contentDescription = loading },
        verticalArrangement = Arrangement.spacedBy(Space.md, Alignment.Bottom),
    ) {
        listOf(0.55f to false, 0.4f to true, 0.7f to false, 0.35f to true, 0.6f to true).forEach { (width, mine) ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
                Box(Modifier.fillMaxWidth(width).height(TranscriptLayout.skeletonBubble).skeleton(RoundedCornerShape(t.radii.bubble)))
            }
        }
    }
}

/** The thread's layout, from the design's board (`.thread`, `.bub`, `.qbox`, `.vm`, `.typing`). */
private object TranscriptLayout {
    val edge = 10.dp
    val gap = 6.dp
    val photo = 220.dp
    val voicePlay = 34.dp
    val voiceTarget = 48.dp
    val voiceIcon = 16.dp
    val voiceGap = 10.dp
    val waveWidth = 150.dp
    val waveBar = 3.dp
    val waveMin = 6.dp
    val waveMax = 22.dp
    val reactionDrop = 14.dp
    val reactionPadH = 8.dp
    val reactionPadV = 2.dp
    val failedPadH = 4.dp
    val failedPadV = 4.dp
    val typingPadH = 16.dp
    val typingPadV = 14.dp
    val typingGap = 4.dp
    val typingDot = 7.dp
    val jump = 40.dp
    val jumpInset = 12.dp
    val skeletonBubble = 40.dp
}
