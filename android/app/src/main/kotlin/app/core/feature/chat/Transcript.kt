package app.core.feature.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.card.isolate
import app.core.feature.card.shimmer
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.ConversationSource
import app.core.model.MessageKind
import app.core.model.Photo
import app.core.model.ProblemCodes
import app.core.sync.ChatErrors
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Space
import kotlinx.coroutines.launch
import java.time.LocalDate

/** The transcript: newest at the bottom, older pages as the person scrolls up. */
@Composable
internal fun Transcript(state: ChatUiState, actions: ChatActions, onSheet: (ChatSheet) -> Unit) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val clock = rememberChatClock()
    val today = remember { LocalDate.now() }
    val items = state.items
    val newest = items.firstOrNull()?.key
    val rows = items.count { it is ChatItem.Bubble || it is ChatItem.Call }

    // Stay at the newest message when one arrives and the person was there
    // already, or wrote it; otherwise offer a way down.
    val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex <= 1 } }
    LaunchedEffect(newest) {
        val mine = (items.firstOrNull() as? ChatItem.Bubble)?.message?.mine == true
        if (atBottom || mine) list.animateScrollToItem(0)
    }
    LaunchedEffect(list, rows) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .collect { last -> if (rows > 0 && last >= list.layoutInfo.totalItemsCount - TOP_MARGIN) actions.nearTop(rows) }
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val bubbleMax = (maxWidth * 0.78f).coerceAtMost(520.dp)
        LazyColumn(
            state = list,
            reverseLayout = true,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = Space.md, vertical = Space.md),
        ) {
            if (state.typing) item(key = "typing") { TypingBubble(peerName(state)) }
            items(items, key = { it.key }) { item ->
                when (item) {
                    is ChatItem.Bubble -> BubbleRow(item, bubbleMax, clock, state, actions, onSheet)
                    is ChatItem.Call -> CallLineRow(item, clock, state)
                    is ChatItem.Day -> DayRow(dayHeader(clock, item.date, today))
                    is ChatItem.Intro -> Intro(item, clock, today)
                }
            }
            if (state.olderLoading) {
                item(key = "older-loading") {
                    Box(Modifier.fillMaxWidth().padding(Space.lg), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    }
                }
            } else if (state.olderFailed) {
                item(key = "older-failed") {
                    Row(
                        Modifier.fillMaxWidth().padding(Space.sm),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(brandString(R.string.chat_older_failed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = actions::retryOlder) { Text(brandString(R.string.action_try_again)) }
                    }
                }
            }
        }
        if (!atBottom) {
            SmallFloatingActionButton(
                onClick = { scope.launch { list.animateScrollToItem(0) } },
                modifier = Modifier.align(Alignment.BottomEnd).padding(Space.lg),
                containerColor = MaterialTheme.colorScheme.secondaryContainer,
            ) {
                Icon(Icons.Filled.KeyboardArrowDown, contentDescription = brandString(R.string.chat_jump_newest))
            }
        }
    }
}

private const val TOP_MARGIN = 4

@Composable
private fun DayRow(text: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = Space.md), contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Text(
                text,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Space.md, vertical = Space.xs).semantics { heading() },
            )
        }
    }
}

@Composable
private fun Intro(item: ChatItem.Intro, clock: ChatClockText, today: LocalDate) {
    val conversation = item.conversation
    val name = isolate(conversation.peer.name)
    Column(
        Modifier.fillMaxWidth().padding(top = Space.xl, bottom = Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        PeerAvatar(conversation.peer.photo, size = 96.dp)
        Text(
            if (conversation.source == ConversationSource.Request) brandString(R.string.chat_intro_request, name)
            else brandString(R.string.chat_intro_matched, name),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            clock.day(clock.date(conversation.createdAt), today),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            brandString(R.string.chat_intro_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Space.xl),
        )
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
) {
    val message = item.message
    val mine = message.mine
    val haptics = LocalHapticFeedback.current
    val big = 20.dp
    val small = 6.dp
    // Corners on the sender's side flatten where a run continues.
    val shape = if (mine) {
        RoundedCornerShape(topStart = big, topEnd = if (item.joinsOlder) small else big, bottomEnd = if (item.joinsNewer) small else big, bottomStart = big)
    } else {
        RoundedCornerShape(topStart = if (item.joinsOlder) small else big, topEnd = big, bottomEnd = big, bottomStart = if (item.joinsNewer) small else big)
    }
    val colors = MaterialTheme.colorScheme
    val unsent = item.unsent != null
    val container = when {
        unsent -> Color.Transparent
        mine -> colors.primary
        else -> colors.surfaceContainerHigh
    }
    val content = when {
        unsent -> colors.onSurfaceVariant
        mine -> colors.onPrimary
        else -> colors.onSurface
    }
    val time = clock.time(message.at)
    val description = bubbleDescription(item, time)
    val openSheet = {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        onSheet(ChatSheet.Message(item))
    }
    val failed = item.delivery == Delivery.Failed
    val actionsLabel = brandString(R.string.chat_message_actions)

    Column(
        Modifier.fillMaxWidth().padding(top = if (item.joinsOlder) 2.dp else Space.sm),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        Box {
            Column(
                Modifier
                    .widthIn(max = maxWidth)
                    .clip(shape)
                    .background(container)
                    .then(if (unsent) Modifier.border(1.dp, colors.outlineVariant, shape) else Modifier)
                    .combinedClickable(
                        onClick = { if (failed) onSheet(ChatSheet.Message(item)) },
                        onLongClick = openSheet,
                        onLongClickLabel = actionsLabel,
                    )
                    .semantics(mergeDescendants = true) {
                        contentDescription = description
                        customActions = listOf(CustomAccessibilityAction(actionsLabel) { onSheet(ChatSheet.Message(item)); true })
                    }
                    .padding(horizontal = Space.md, vertical = Space.sm),
            ) {
                BubbleContent(item, content, mine)
                Row(
                    Modifier.align(Alignment.End).padding(top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.xxs),
                ) {
                    Text(time, style = MaterialTheme.typography.labelSmall, color = content.copy(alpha = 0.75f))
                    item.delivery?.let { DeliveryMark(it, content) }
                }
            }
            if (item.reactions.isNotEmpty() && !unsent) {
                Surface(
                    shape = RoundedCornerShape(50),
                    color = colors.surfaceContainerHighest,
                    shadowElevation = 1.dp,
                    modifier = Modifier
                        .align(if (mine) Alignment.BottomStart else Alignment.BottomEnd)
                        .offset(y = 14.dp),
                ) {
                    Text(
                        item.reactions.distinct().joinToString(" ") + if (item.reactions.size > 1) " ${clock.digits(item.reactions.size.toString())}" else "",
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(horizontal = Space.sm, vertical = 2.dp),
                    )
                }
            }
        }
        if (item.reactions.isNotEmpty() && !unsent) Spacer(Modifier.height(14.dp))
        if (failed || item.delivery == Delivery.Confirm) FailedLine(message.errorCode) { onSheet(ChatSheet.Message(item)) }
    }
}

@Composable
private fun BubbleContent(item: ChatItem.Bubble, content: Color, mine: Boolean) {
    val message = item.message
    when {
        item.unsent == Unsent.Removed -> Placeholder(brandString(R.string.chat_removed), content)
        item.unsent == Unsent.BySender -> Placeholder(brandString(if (mine) R.string.chat_unsent_mine else R.string.chat_unsent_theirs), content)
        else -> when (message.kind) {
            MessageKind.Text -> Text(message.body.orEmpty(), style = MaterialTheme.typography.bodyLarge, color = content)
            MessageKind.LikeNote -> Column(verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Icon(Icons.Filled.Favorite, contentDescription = null, tint = if (mine) content else AppTheme.colors.like, modifier = Modifier.size(14.dp))
                    Text(
                        brandString(if (mine) R.string.chat_like_note_mine else R.string.chat_like_note_theirs),
                        style = MaterialTheme.typography.labelMedium,
                        color = content.copy(alpha = 0.85f),
                    )
                }
                message.body?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = content) }
            }
            MessageKind.Image, MessageKind.Gif -> {
                val media = message.media
                if (media != null) {
                    val ratio = if ((media.w ?: 0) > 0 && (media.h ?: 0) > 0) (media.w!!.toFloat() / media.h!!).coerceIn(0.5f, 2f) else 1f
                    PhotoImage(
                        photo = Photo(id = message.localId, w = media.w ?: 0, h = media.h ?: 0, blurhash = media.blurhash.orEmpty(), url = media.url),
                        contentDescription = brandString(R.string.chat_photo),
                        modifier = Modifier.width(220.dp).aspectRatio(ratio).clip(RoundedCornerShape(14.dp)),
                    )
                } else {
                    Text(message.body ?: brandString(R.string.chat_photo), style = MaterialTheme.typography.bodyLarge, color = content)
                }
            }
            MessageKind.Voice -> Column {
                val clock = rememberChatClock()
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Icon(painterResource(R.drawable.ic_deck_voice), contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
                    Text(
                        brandString(R.string.chat_voice, callLength(clock, (message.media?.durationMs ?: 0) / 1000)),
                        style = MaterialTheme.typography.bodyLarge,
                        color = content,
                    )
                }
                Text(brandString(R.string.chat_voice_unavailable), style = MaterialTheme.typography.labelSmall, color = content.copy(alpha = 0.75f))
            }
            else -> Placeholder(brandString(R.string.chat_unknown), content)
        }
    }
}

@Composable
private fun Placeholder(text: String, content: Color) {
    Text(text, style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = content)
}

@Composable
private fun DeliveryMark(delivery: Delivery, content: Color) {
    val (icon, tint) = when (delivery) {
        Delivery.Pending -> R.drawable.ic_chat_pending to content.copy(alpha = 0.75f)
        Delivery.Sent -> R.drawable.ic_chat_sent to content.copy(alpha = 0.75f)
        Delivery.Delivered -> R.drawable.ic_chat_read to content.copy(alpha = 0.75f)
        Delivery.Read -> R.drawable.ic_chat_read to AppTheme.colors.success.let { if (content == MaterialTheme.colorScheme.onPrimary) content else it }
        Delivery.Failed, Delivery.Confirm -> R.drawable.ic_chat_error to MaterialTheme.colorScheme.error
    }
    val emphasis = if (delivery == Delivery.Read) Modifier else Modifier.alpha(0.9f)
    Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(14.dp).then(emphasis))
}

@Composable
private fun FailedLine(code: String?, onClick: () -> Unit) {
    val text = when (code) {
        ProblemCodes.MESSAGE_REFUSED, ProblemCodes.TEXT_REFUSED -> brandString(R.string.chat_not_sent_refused)
        ChatErrors.EXPIRED -> brandString(R.string.chat_not_sent_expired)
        ProblemCodes.CONVERSATION_ENDED -> brandString(R.string.chat_ended_title)
        else -> brandString(R.string.chat_not_sent)
    }
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = Space.xs, vertical = Space.xxs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Icon(painterResource(R.drawable.ic_chat_error), contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
    }
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
    return listOfNotNull(who, text, time, status, reactions).joinToString(", ")
}

@Composable
private fun CallLineRow(item: ChatItem.Call, clock: ChatClockText, state: ChatUiState) {
    val call = item.message.call ?: return
    val me = state.me
    val text = callLineText(call, mine = call.caller == me, clock = clock)
    val time = clock.time(item.message.at)
    val conversation = state.conversation
    val callBack = LocalChatCallBack.current
    val onCallBack = if (callBack != null && conversation != null && conversation.callsAllowed.both && !state.ended) {
        { callBack(conversation, call.kind) }
    } else {
        null
    }
    val missed = call.caller != me && call.outcome != app.core.model.CallOutcome.Completed
    Box(Modifier.fillMaxWidth().padding(vertical = Space.sm), contentAlignment = Alignment.Center) {
        Surface(
            shape = RoundedCornerShape(50),
            color = MaterialTheme.colorScheme.surfaceContainer,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .then(if (onCallBack != null) Modifier.clickable(onClickLabel = brandString(R.string.chat_call_back), onClick = onCallBack) else Modifier)
                .semantics(mergeDescendants = true) { },
        ) {
            Row(
                Modifier.padding(horizontal = Space.md, vertical = Space.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Icon(
                    Icons.Filled.Call,
                    contentDescription = null,
                    tint = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
                Text(text, style = MaterialTheme.typography.labelLarge)
                Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun TypingBubble(name: String) {
    val reduced = LocalReducedMotion.current
    val description = brandString(R.string.chat_typing_a11y, name)
    Row(Modifier.fillMaxWidth().padding(top = Space.sm)) {
        Row(
            Modifier
                .clip(RoundedCornerShape(20.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .padding(horizontal = Space.lg, vertical = Space.md)
                .clearAndSetSemantics {
                    contentDescription = description
                    liveRegion = LiveRegionMode.Polite
                },
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            val transition = rememberInfiniteTransition(label = "typing")
            repeat(3) { i ->
                val alpha = if (reduced) {
                    0.6f
                } else {
                    transition.animateFloat(
                        initialValue = 0.25f,
                        targetValue = 1f,
                        animationSpec = infiniteRepeatable(tween(durationMillis = 520, delayMillis = i * 160), RepeatMode.Reverse),
                        label = "dot$i",
                    ).value
                }
                Box(Modifier.size(8.dp).alpha(alpha).clip(CircleShape).background(MaterialTheme.colorScheme.onSurfaceVariant))
            }
        }
    }
}

@Composable
internal fun TranscriptSkeleton() {
    val loading = brandString(R.string.chat_loading_messages)
    Column(
        Modifier.fillMaxSize().padding(Space.md).semantics { contentDescription = loading },
        verticalArrangement = Arrangement.spacedBy(Space.md, Alignment.Bottom),
    ) {
        listOf(0.55f to false, 0.4f to true, 0.7f to false, 0.35f to true, 0.6f to true).forEach { (width, mine) ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
                Box(Modifier.fillMaxWidth(width).height(40.dp).clip(RoundedCornerShape(20.dp)).shimmer())
            }
        }
    }
}
