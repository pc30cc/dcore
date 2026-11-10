package app.core.feature.chat

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Conversation
import app.core.model.Id
import app.core.realtime.RealtimeHealth
import app.core.ui.components.AvatarFocus
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppTextField
import app.core.ui.components.ConversationRow
import app.core.ui.components.EmptyState
import app.core.ui.components.MatchTile
import app.core.ui.components.SectionLabel
import app.core.ui.components.UnreadCount
import app.core.ui.components.badgeCount
import app.core.ui.components.listBottomPadding
import app.core.ui.components.skeleton
import app.core.ui.components.templateCard
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import java.text.Normalizer
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.util.Locale

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

/**
 * The Chats tab (m09): the title with search, «مچ‌های تازه» and the strip
 * of new matches (fresh ones ringed), the requests as one row with their
 * count, then «پیام‌ها» and the conversations. Search narrows the strip and
 * the list to the names that match what is typed. Nothing else: no
 * subtitles, no icon tiles, no «نوبت توئه».
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    state: ConversationsUiState,
    actions: ConversationsActions,
    modifier: Modifier = Modifier,
    now: Instant = rememberMinuteNow(),
    today: LocalDate = rememberToday(now),
) {
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    // Back closes the search first (this handler comes after the tabs' own, so it is asked first).
    BackHandler(enabled = searching) {
        searching = false
        query = ""
    }
    Column(modifier.fillMaxSize()) {
        ListHeader(
            searching = searching,
            query = query,
            onQuery = { query = it },
            onSearch = { searching = true },
            onCloseSearch = {
                searching = false
                query = ""
            },
            searchable = !state.loading && !state.empty,
            onRequests = actions::openRequests,
        )
        ConnectionLine(state.connection, state.offline)
        AnimatedVisibility(state.pushUnavailable) { PushNotice(actions::dismissPushNotice) }
        when {
            state.loading -> SkeletonList()
            state.empty -> Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = listBottomPadding), contentAlignment = Alignment.Center) {
                EmptyState(title = brandString(R.string.chats_empty_title), action = brandString(R.string.chat_list_browse), onAction = actions::browse)
            }
            else -> PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions::refresh, modifier = Modifier.fillMaxSize()) {
                val search = query.takeIf { searching }?.trim().orEmpty()
                val found = search.isBlank() || state.newMatches.any { matchesSearch(it, search) } || state.conversations.any { matchesSearch(it, search) }
                if (found) {
                    ConversationList(state, actions, today, now, search)
                } else {
                    // The name may be on a page not read yet: read on (each page asks for the next) until it shows or none is left.
                    LaunchedEffect(search, state.conversations.size) { actions.nearEnd() }
                    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = listBottomPadding), contentAlignment = Alignment.Center) {
                        EmptyState(title = brandString(R.string.chats_search_none))
                    }
                }
            }
        }
    }
}

/**
 * The title (`--type-h1`), the requests button (always there, so the sent
 * box can be reached with nothing received; the row under it carries the
 * count) and the search button at its end; while searching, the field and
 * a close button.
 */
@Composable
private fun ListHeader(
    searching: Boolean,
    query: String,
    onQuery: (String) -> Unit,
    onSearch: () -> Unit,
    onCloseSearch: () -> Unit,
    searchable: Boolean,
    onRequests: () -> Unit,
) {
    val t = AppTheme.template
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = Space.gutter, end = ChatsLayout.headerEnd, top = ChatsLayout.headerTop)
            .heightIn(min = ChatsLayout.headerHeight),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (searching) {
            val focus = remember { FocusRequester() }
            AppTextField(
                value = query,
                onValueChange = onQuery,
                placeholder = brandString(R.string.chats_search),
                clearable = false,
                modifier = Modifier.weight(1f).focusRequester(focus),
            )
            LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
            AppIconButton(AppIcons.Close, brandString(R.string.action_close), onCloseSearch)
        } else {
            Text(
                brandString(R.string.tab_chats),
                style = t.type.h1,
                color = t.colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            AppIconButton(AppIcons.Mail, brandString(R.string.chat_requests), onRequests)
            if (searchable) AppIconButton(AppIcons.Search, brandString(R.string.chats_search), onSearch)
        }
    }
}

/** "Connecting…" or "Offline": a quiet line, only when it matters. Content stays usable under it. */
@Composable
fun ConnectionLine(health: RealtimeHealth, offline: Boolean, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    val text = when {
        offline -> brandString(R.string.chat_status_offline)
        health == RealtimeHealth.DEGRADED -> brandString(R.string.chat_status_reconnecting)
        health == RealtimeHealth.CONNECTING -> brandString(R.string.chat_status_connecting)
        else -> null
    }
    AnimatedVisibility(text != null, modifier = modifier) {
        Text(
            text.orEmpty(),
            style = t.type.caption,
            color = t.colors.text2,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(t.colors.surface2)
                .padding(horizontal = Space.gutter, vertical = ChatsLayout.connectionPad)
                .semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

/** No push on this phone: said once, in a quiet card that can be closed. */
@Composable
private fun PushNotice(onDismiss: () -> Unit) {
    val t = AppTheme.template
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.gutter, vertical = ChatsLayout.noticeGap)
            .templateCard(RoundedCornerShape(t.radii.card))
            .padding(start = ChatsLayout.cardPad, top = ChatsLayout.noticePad, bottom = ChatsLayout.noticePad),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f).padding(top = ChatsLayout.noticeTextTop), verticalArrangement = Arrangement.spacedBy(ChatsLayout.noticeLineGap)) {
            Text(brandString(R.string.chat_push_missing_title), style = t.type.bodyStrong, color = t.colors.text)
            Text(brandString(R.string.chat_push_missing_body), style = t.type.bodySm, color = t.colors.text2)
        }
        AppIconButton(AppIcons.Close, brandString(R.string.action_close), onDismiss, iconSize = ChatsLayout.closeIcon, tint = t.colors.text3)
    }
}

/** A match made in the last day: ringed in the strip. */
internal fun isFreshMatch(conversation: Conversation, now: Instant): Boolean =
    Duration.between(conversation.createdAt, now) < FRESH_MATCH

private val FRESH_MATCH: Duration = Duration.ofDays(1)

/**
 * Whether [conversation] is one the search for [query] keeps: its name, in
 * any case and without marks, Turkish's dotted and dotless i read as one
 * («İrem» for "irem", «Işıl» for "ışıl").
 */
internal fun matchesSearch(conversation: Conversation, query: String): Boolean =
    query.isBlank() || searchFold(conversation.peer.name).contains(searchFold(query))

private val MARKS = Regex("\\p{M}+")

/** [text] as the search compares it: lower case, decomposed with its marks dropped, «ı» as "i". */
internal fun searchFold(text: String): String =
    Normalizer.normalize(text.lowercase(Locale.ROOT), Normalizer.Form.NFD).replace(MARKS, "").replace('ı', 'i')

@Composable
private fun ConversationList(state: ConversationsUiState, actions: ConversationsActions, today: LocalDate, now: Instant, query: String) {
    val list = rememberLazyListState()
    LaunchedEffect(list, state.conversations.size) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .collect { last -> if (last >= list.layoutInfo.totalItemsCount - 3) actions.nearEnd() }
    }
    val clock = rememberChatClock()
    val matches = state.newMatches.filter { matchesSearch(it, query) }
    val conversations = state.conversations.filter { matchesSearch(it, query) }
    LazyColumn(state = list, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = listBottomPadding)) {
        if (matches.isNotEmpty()) {
            item(key = "matches-title") { Label(brandString(R.string.chat_new_matches), ChatsLayout.firstLabelTop) }
            item(key = "matches") {
                LazyRow(
                    contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, top = ChatsLayout.ringRoom),
                    horizontalArrangement = Arrangement.spacedBy(ChatsLayout.railGap),
                ) {
                    items(matches, key = { it.id }) { match -> NewMatch(match, fresh = isFreshMatch(match, now)) { actions.open(match.id) } }
                }
            }
        }
        if (state.requests > 0 && query.isBlank()) {
            item(key = "requests") {
                RequestsRow(
                    state.requests,
                    actions::openRequests,
                    Modifier.padding(top = if (matches.isNotEmpty()) ChatsLayout.requestsTop else ChatsLayout.firstLabelTop),
                )
            }
        }
        if (conversations.isNotEmpty()) {
            val first = matches.isEmpty() && (state.requests == 0 || query.isNotBlank())
            item(key = "messages-title") {
                Label(brandString(R.string.chat_messages), if (first) ChatsLayout.firstLabelTop else ChatsLayout.messagesTop, bottom = ChatsLayout.messagesLabelBottom)
            }
            itemsIndexed(conversations, key = { _, it -> it.id }) { index, conversation ->
                ConversationItem(conversation, state.me, typing = conversation.id in state.typing, clock = clock, today = today, now = now, divider = index > 0) {
                    actions.open(conversation.id)
                }
            }
        }
    }
}

/** A plain section label (`--type-section`, `--text-3`) [top] under what is above it. */
@Composable
private fun Label(text: String, top: androidx.compose.ui.unit.Dp, bottom: androidx.compose.ui.unit.Dp = ChatsLayout.labelBottom) {
    SectionLabel(text, Modifier.padding(start = Space.gutter, end = Space.gutter, top = top, bottom = bottom))
}

/** A new match in the strip: [MatchTile] (fresh ones ringed, the online dot) and the first name under it. */
@Composable
private fun NewMatch(match: Conversation, fresh: Boolean, onClick: () -> Unit) {
    val t = AppTheme.template
    val description = brandString(R.string.chat_new_match_open, isolate(match.peer.name))
    Column(
        Modifier
            .width(ChatsLayout.tileWidth)
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = description
                role = Role.Button
            },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        MatchTile(isNew = fresh, online = match.peer.online) {
            PhotoImage(match.peer.photo, null, Modifier.fillMaxSize(), alignment = ChatsLayout.tileAlignment)
        }
        Spacer(Modifier.height(ChatsLayout.nameGap))
        Text(match.peer.name, style = t.type.caption, color = t.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** «درخواست‌ها» as one row in a group: the count and a chevron. */
@Composable
private fun RequestsRow(count: Int, onClick: () -> Unit, modifier: Modifier) {
    val t = AppTheme.template
    val number = rememberNumbers()
    val text = brandString(R.string.chat_requests_count, number(count))
    val shape = RoundedCornerShape(t.radii.card)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.gutter)
            .templateCard(shape)
            .clickable(onClick = onClick)
            .heightIn(min = ChatsLayout.requestsRow)
            .padding(horizontal = ChatsLayout.cardPad)
            .clearAndSetSemantics {
                contentDescription = text
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ChatsLayout.rowGap),
    ) {
        Text(brandString(R.string.chat_requests), style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        UnreadCount(requestsBadgeText(count, number))
        Icon(AppIcons.ChevronEnd, contentDescription = null, tint = t.colors.text3, modifier = Modifier.size(ChatsLayout.chevron))
    }
}

@Composable
private fun ConversationItem(
    conversation: Conversation,
    me: String?,
    typing: Boolean,
    clock: ChatClockText,
    today: LocalDate,
    now: Instant,
    divider: Boolean,
    onClick: () -> Unit,
) {
    val number = rememberNumbers()
    val unread = conversation.unread
    val preview = if (typing) brandString(R.string.chat_typing) else previewText(conversation.lastMessage, me).orEmpty()
    // What TalkBack reads: a call's length in words ("12 minutes, 34 seconds"), not the short units shown.
    val spokenPreview = if (typing) preview else previewText(conversation.lastMessage, me, spoken = true).orEmpty()
    val time = conversation.lastMessage?.at?.let { listTime(clock, it, today, now) }.orEmpty()
    val separator = brandString(R.string.chat_list_separator)
    val description = buildList {
        add(conversation.peer.name)
        if (conversation.peer.verified) add(brandString(R.string.deck_verified))
        if (conversation.peer.online) add(brandString(R.string.chat_online))
        if (unread > 0) add(brandString(R.string.chat_unread_count, number(unread)))
        if (spokenPreview.isNotEmpty()) add(spokenPreview)
        if (time.isNotEmpty()) add(time)
        if (conversation.muted) add(brandString(R.string.chat_muted))
    }.joinToString(separator)
    ConversationRow(
        name = conversation.peer.name,
        preview = preview,
        time = time,
        onClick = onClick,
        modifier = Modifier.padding(horizontal = Space.gutter),
        verified = conversation.peer.verified,
        online = conversation.peer.online,
        typing = typing,
        unread = unread,
        unreadText = badgeCount(unread, MAX_BADGE, number),
        muted = conversation.muted,
        divider = divider,
        description = description,
        photo = conversation.peer.photo?.let { photo -> { PhotoImage(photo, null, Modifier.fillMaxSize(), alignment = AvatarFocus) } },
    )
}

@Composable
private fun SkeletonList() {
    val loading = brandString(R.string.chat_list_loading)
    Column(Modifier.fillMaxSize().padding(top = ChatsLayout.firstLabelTop).clearAndSetSemantics { contentDescription = loading }) {
        repeat(SKELETON_ROWS) {
            Row(Modifier.fillMaxWidth().height(ChatsLayout.skeletonRow).padding(horizontal = Space.gutter), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(ChatsLayout.skeletonAvatar).skeleton(CircleShape))
                Spacer(Modifier.width(ChatsLayout.rowTextGap))
                Column(verticalArrangement = Arrangement.spacedBy(ChatsLayout.skeletonBarGap)) {
                    Box(Modifier.height(ChatsLayout.skeletonBar).width(ChatsLayout.skeletonName).skeleton())
                    Box(Modifier.height(ChatsLayout.skeletonBar).width(ChatsLayout.skeletonLine).skeleton())
                }
            }
        }
    }
}

private const val SKELETON_ROWS = 6
private const val MAX_BADGE = 99

/** The requests count: up to "99+". */
internal fun requestsBadgeText(count: Int, number: (Int) -> String): String = badgeCount(count, MAX_BADGE, number)

/** The Chats tab's layout, from the design's 412 × 892 board (status bar 32 dp). */
private object ChatsLayout {
    /** The title row (`.thead`): 12 dp under the status bar, 52 dp tall; the search button 2 dp from the end. */
    val headerTop = 12.dp
    val headerHeight = 52.dp
    val headerEnd = 2.dp
    val connectionPad = 6.dp

    /** «مچ‌های تازه» 14 dp under the title row (at 110). */
    val firstLabelTop = 14.dp
    val labelBottom = 10.dp

    /** The ring's room above the tiles (`.rail{padding-top:4px}`). */
    val ringRoom = 4.dp
    val railGap = 12.dp
    val tileWidth = 76.dp
    val nameGap = 8.dp
    val tileAlignment = androidx.compose.ui.BiasAlignment(0f, -0.64f)

    /** The requests group 16 dp under the strip's names, the messages label 24 dp under it. */
    val requestsTop = 16.dp

    /** The rows start 22 dp under the top of «پیام‌ها» (`.sl2` at 366, `.convs` at 388): its 20 dp line, then 2. */
    val messagesLabelBottom = 2.dp
    val requestsRow = 56.dp
    val messagesTop = 24.dp
    val cardPad = 16.dp
    val rowGap = 12.dp
    val chevron = 20.dp
    val rowTextGap = 14.dp
    val noticeGap = 8.dp
    val noticePad = 4.dp
    val noticeTextTop = 10.dp
    val noticeLineGap = 2.dp
    val closeIcon = 20.dp
    val skeletonRow = 76.dp
    val skeletonAvatar = 54.dp
    val skeletonBar = 12.dp
    val skeletonBarGap = 8.dp
    val skeletonName = 120.dp
    val skeletonLine = 200.dp
}
