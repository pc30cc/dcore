package app.core.feature.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.VerifiedBadge
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.feature.card.shimmer
import app.core.i18n.brandString
import app.core.model.Conversation
import app.core.model.Id
import app.core.realtime.RealtimeHealth
import app.core.ui.components.EmptyState
import app.core.ui.theme.Space
import java.time.LocalDate

/** What the chat list can be asked to do. */
interface ConversationsActions {
    fun open(conversationId: Id)
    fun openRequests()
    fun browse()
    fun refresh()
    fun nearEnd()
    fun dismissPushNotice()
}

/** The Chats tab. */
@Composable
fun ConversationsRoute(onOpen: (Id) -> Unit, onOpenRequests: () -> Unit, onBrowse: () -> Unit, modifier: Modifier = Modifier) {
    val graph = LocalAppGraph.current
    val vm: ConversationsViewModel = viewModel { ConversationsViewModel(graph.chat.sync, graph.push.availability) }
    val state by vm.state.collectAsStateWithLifecycle()
    LifecycleStartEffect(vm) {
        vm.shown()
        graph.push.notifications.clearLikes()
        onStopOrDispose { }
    }
    val actions = remember(vm, onOpen, onOpenRequests, onBrowse) {
        object : ConversationsActions {
            override fun open(conversationId: Id) = onOpen(conversationId)
            override fun openRequests() = onOpenRequests()
            override fun browse() = onBrowse()
            override fun refresh() = vm.refresh()
            override fun nearEnd() = vm.nearEnd()
            override fun dismissPushNotice() = vm.dismissPushNotice()
        }
    }
    ConversationsScreen(state, actions, modifier)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(state: ConversationsUiState, actions: ConversationsActions, modifier: Modifier = Modifier, today: LocalDate = LocalDate.now()) {
    Column(modifier.fillMaxSize()) {
        ListHeader(state, actions)
        ConnectionLine(state.connection, state.offline)
        AnimatedVisibility(state.pushUnavailable) { PushNotice(actions::dismissPushNotice) }
        when {
            state.loading -> SkeletonList()
            state.empty -> EmptyState(
                icon = R.drawable.ic_tab_chats,
                title = brandString(R.string.chats_empty_title),
                body = brandString(R.string.chats_empty_body),
                modifier = Modifier.fillMaxSize(),
                action = { Button(onClick = actions::browse) { Text(brandString(R.string.chat_list_browse)) } },
            )
            else -> PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions::refresh, modifier = Modifier.fillMaxSize()) {
                ConversationList(state, actions, today)
            }
        }
    }
}

@Composable
private fun ListHeader(state: ConversationsUiState, actions: ConversationsActions) {
    Row(
        Modifier.fillMaxWidth().padding(start = Space.lg, end = Space.sm, top = Space.md, bottom = Space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            brandString(R.string.tab_chats),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        val number = rememberNumbers()
        val description = if (state.requests > 0) brandString(R.string.chat_requests_count, number(state.requests)) else brandString(R.string.chat_requests)
        IconButton(onClick = actions::openRequests, modifier = Modifier.semantics { contentDescription = description }) {
            BadgedBox(badge = { if (state.requests > 0) Badge { Text(number(state.requests)) } }) {
                Icon(painterResource(R.drawable.ic_chat_requests), contentDescription = null)
            }
        }
    }
}

/** "Connecting…" or "Offline": a quiet line, only when it matters. Content stays usable under it. */
@Composable
fun ConnectionLine(health: RealtimeHealth, offline: Boolean, modifier: Modifier = Modifier) {
    val text = when {
        offline -> brandString(R.string.chat_status_offline)
        health == RealtimeHealth.DEGRADED -> brandString(R.string.chat_status_reconnecting)
        health == RealtimeHealth.CONNECTING -> brandString(R.string.chat_status_connecting)
        else -> null
    }
    AnimatedVisibility(text != null, modifier = modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .padding(horizontal = Space.lg, vertical = Space.xs)
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            if (offline) {
                Icon(painterResource(R.drawable.ic_chat_offline), contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(text.orEmpty(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PushNotice(onDismiss: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
    ) {
        Row(Modifier.padding(start = Space.lg, top = Space.md, bottom = Space.md), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                Text(brandString(R.string.chat_push_missing_title), style = MaterialTheme.typography.titleSmall)
                Text(brandString(R.string.chat_push_missing_body), style = MaterialTheme.typography.bodySmall)
            }
            IconButton(onClick = onDismiss) {
                Icon(Icons.Filled.Close, contentDescription = brandString(R.string.action_close))
            }
        }
    }
}

@Composable
private fun ConversationList(state: ConversationsUiState, actions: ConversationsActions, today: LocalDate) {
    val list = rememberLazyListState()
    LaunchedEffect(list, state.conversations.size) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .collect { last -> if (last >= list.layoutInfo.totalItemsCount - 3) actions.nearEnd() }
    }
    val clock = rememberChatClock()
    LazyColumn(state = list, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = Space.xl)) {
        if (state.newMatches.isNotEmpty()) {
            item(key = "matches-title") { SectionTitle(brandString(R.string.chat_new_matches)) }
            item(key = "matches") {
                LazyRow(contentPadding = PaddingValues(horizontal = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                    items(state.newMatches, key = { it.id }) { match -> NewMatch(match) { actions.open(match.id) } }
                }
            }
        }
        if (state.requests > 0) {
            item(key = "requests") { RequestsRow(state.requests, actions::openRequests) }
        }
        if (state.conversations.isNotEmpty()) {
            item(key = "messages-title") { SectionTitle(brandString(R.string.chat_messages)) }
            items(state.conversations, key = { it.id }) { conversation ->
                ConversationRow(conversation, state.me, typing = conversation.id in state.typing, clock = clock, today = today) {
                    actions.open(conversation.id)
                }
            }
        } else if (state.newMatches.isNotEmpty()) {
            item(key = "say-hi") {
                Text(
                    brandString(R.string.chat_say_hi_hint),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.xl),
                )
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = Space.lg, end = Space.lg, top = Space.lg, bottom = Space.sm).semantics { heading() },
    )
}

@Composable
private fun NewMatch(match: Conversation, onClick: () -> Unit) {
    val description = brandString(R.string.chat_new_match_open, isolate(match.peer.name))
    Column(
        Modifier
            .width(76.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = description
                role = Role.Button
            }
            .padding(vertical = Space.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        PeerAvatar(match.peer.photo, size = 68.dp, ring = true, online = match.peer.online)
        Text(match.peer.name, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun RequestsRow(count: Int, onClick: () -> Unit) {
    val number = rememberNumbers()
    val text = brandString(R.string.chat_requests_count, number(count))
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = Space.minTouch)
            .padding(horizontal = Space.lg, vertical = Space.md)
            .clearAndSetSemantics {
                contentDescription = text
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_chat_requests), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
        }
        Column(Modifier.weight(1f)) {
            Text(brandString(R.string.chat_requests), style = MaterialTheme.typography.titleMedium)
            Text(brandString(R.string.chat_requests_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Badge(containerColor = MaterialTheme.colorScheme.primary) { Text(number(count), modifier = Modifier.padding(horizontal = 2.dp)) }
    }
    HorizontalDivider(Modifier.padding(start = 76.dp), color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun ConversationRow(
    conversation: Conversation,
    me: String?,
    typing: Boolean,
    clock: ChatClockText,
    today: LocalDate,
    onClick: () -> Unit,
) {
    val number = rememberNumbers()
    val unread = conversation.unread
    val preview = if (typing) brandString(R.string.chat_typing) else previewText(conversation.lastMessage, me, clock).orEmpty()
    val time = conversation.lastMessage?.at?.let { listTime(clock, it, today) }.orEmpty()
    val description = buildList {
        add(conversation.peer.name)
        if (conversation.peer.verified) add(brandString(R.string.deck_verified))
        if (conversation.peer.online) add(brandString(R.string.chat_online))
        if (unread > 0) add(brandString(R.string.chat_unread_count, number(unread)))
        if (preview.isNotEmpty()) add(preview)
        if (time.isNotEmpty()) add(time)
        if (conversation.muted) add(brandString(R.string.chat_muted))
    }.joinToString(", ")
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = Space.lg, vertical = Space.md)
            .clearAndSetSemantics {
                contentDescription = description
                role = Role.Button
                onClick { onClick(); true }
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        PeerAvatar(conversation.peer.photo, size = 56.dp, online = conversation.peer.online)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                Text(
                    conversation.peer.name,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (conversation.peer.verified) VerifiedBadge(16.dp)
                if (conversation.muted) {
                    Icon(painterResource(R.drawable.ic_chat_muted), contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    time,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (unread > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    preview,
                    style = MaterialTheme.typography.bodyMedium,
                    color = when {
                        typing -> MaterialTheme.colorScheme.primary
                        unread > 0 -> MaterialTheme.colorScheme.onSurface
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    fontWeight = if (unread > 0) FontWeight.Medium else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (unread > 0) {
                    Spacer(Modifier.width(Space.sm))
                    Badge(
                        containerColor = if (conversation.muted) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.primary,
                    ) { Text(number(unread.coerceAtMost(MAX_BADGE)) + if (unread > MAX_BADGE) "+" else "", modifier = Modifier.padding(horizontal = 2.dp)) }
                }
            }
        }
    }
}

@Composable
private fun SkeletonList() {
    val loading = brandString(R.string.chat_list_loading)
    Column(Modifier.fillMaxSize().padding(top = Space.md).clearAndSetSemantics { contentDescription = loading }) {
        repeat(SKELETON_ROWS) {
            Row(Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.md), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(56.dp).clip(CircleShape).shimmer())
                Spacer(Modifier.width(Space.md))
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Box(Modifier.height(14.dp).widthIn(min = 120.dp).width(140.dp).clip(RoundedCornerShape(7.dp)).shimmer())
                    Box(Modifier.height(12.dp).width(220.dp).clip(RoundedCornerShape(6.dp)).shimmer())
                }
            }
        }
    }
}

private const val SKELETON_ROWS = 6
private const val MAX_BADGE = 99
