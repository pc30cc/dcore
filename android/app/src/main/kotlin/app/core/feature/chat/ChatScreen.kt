package app.core.feature.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.DetailsSource
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.card.VerifiedBadge
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.i18n.brandString
import app.core.model.CallKind
import app.core.model.Catalog
import app.core.model.Conversation
import app.core.model.Id
import app.core.model.ReportReason
import app.core.sync.ChatMessage
import app.core.ui.components.EmptyState
import app.core.ui.theme.Space

/**
 * What another feature adds to a thread's top bar, for the conversation on
 * screen: the call buttons. Provided around [ChatRoute]; nothing by default.
 */
val LocalChatHeaderActions = staticCompositionLocalOf<@Composable RowScope.(Conversation) -> Unit> { {} }

/** A tap on a call line ("call back"); the call layer provides it. Null: the line is not tappable. */
val LocalChatCallBack = staticCompositionLocalOf<((Conversation, CallKind) -> Unit)?> { null }

/** What the thread screen can be asked to do. */
interface ChatActions {
    fun back()
    fun send(text: String): Boolean
    fun typed()
    fun retry(message: ChatMessage)
    fun delete(message: ChatMessage)
    fun sendAnyway(message: ChatMessage)
    fun react(message: ChatMessage, emoji: String, current: String?)
    fun unsend(message: ChatMessage)
    fun copied()
    fun nearTop(shownRows: Int)
    fun retryOlder()
    fun reload()
    fun openProfile()
    fun closeProfile()
    fun setMuted(muted: Boolean)
    fun unmatch()
    fun block()
    fun report(reason: ReportReason, details: String?, block: Boolean, message: ChatMessage?)
    fun noticeShown(id: Long)
}

/** A thread, by its conversation (match) id. */
@Composable
fun ChatRoute(conversationId: Id, onBack: () -> Unit) {
    val graph = LocalAppGraph.current
    val vm: ChatViewModel = viewModel(key = "chat:$conversationId") {
        ChatViewModel(conversationId, graph.chat.sync, graph.entitlements, { graph.api.profile(it) }, graph.clock)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        vm.visible(true)
        graph.push.notifications.clearConversation(conversationId)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) { vm.visible(false) }
    val back by rememberUpdatedState(onBack)
    LaunchedEffect(state.left) { if (state.left) back() }

    val actions = remember(vm) {
        object : ChatActions {
            override fun back() = back()
            override fun send(text: String) = vm.send(text)
            override fun typed() = vm.typed()
            override fun retry(message: ChatMessage) = vm.retry(message)
            override fun delete(message: ChatMessage) = vm.delete(message)
            override fun sendAnyway(message: ChatMessage) = vm.sendAnyway(message)
            override fun react(message: ChatMessage, emoji: String, current: String?) = vm.react(message, emoji, current)
            override fun unsend(message: ChatMessage) = vm.unsend(message)
            override fun copied() = vm.copied()
            override fun nearTop(shownRows: Int) = vm.nearTop(shownRows)
            override fun retryOlder() = vm.retryOlder()
            override fun reload() = vm.open()
            override fun openProfile() = vm.openProfile()
            override fun closeProfile() = vm.closeProfile()
            override fun setMuted(muted: Boolean) = vm.setMuted(muted)
            override fun unmatch() = vm.unmatch()
            override fun block() = vm.block()
            override fun report(reason: ReportReason, details: String?, block: Boolean, message: ChatMessage?) =
                vm.report(reason, details, block, message)
            override fun noticeShown(id: Long) = vm.noticeShown(id)
        }
    }
    ChatScreen(
        state = state,
        actions = actions,
        messageMax = config?.limits?.messageMax ?: DEFAULT_MESSAGE_MAX,
        catalog = config?.catalog ?: Catalog(),
    )
}

private const val DEFAULT_MESSAGE_MAX = 2_000

/** The thread for a given state: every state drawn, with no server behind it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    state: ChatUiState,
    actions: ChatActions,
    messageMax: Int,
    catalog: Catalog,
    modifier: Modifier = Modifier,
) {
    val snackbar = remember { SnackbarHostState() }
    var draft by rememberSaveable { mutableStateOf("") }
    var sheet by remember { mutableStateOf<ChatSheet?>(null) }

    NoticeEffect(state.notice, snackbar, actions)

    Scaffold(
        modifier = modifier,
        topBar = { ChatTopBar(state, actions, onSheet = { sheet = it }) },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Box(Modifier.windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
                when {
                    state.gone -> Unit
                    state.ended -> EndedBar()
                    else -> Composer(
                        text = draft,
                        max = messageMax,
                        onText = { value ->
                            draft = value
                            if (value.isNotBlank()) actions.typed()
                        },
                        onSend = { if (actions.send(draft)) draft = "" },
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ConnectionLine(state.connection, state.offline && !state.loadFailed)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    state.gone -> EmptyState(
                        icon = R.drawable.ic_tab_chats,
                        title = brandString(R.string.chat_gone_title),
                        body = brandString(R.string.chat_gone_body),
                        modifier = Modifier.align(Alignment.Center),
                        action = { Button(onClick = actions::back) { Text(brandString(R.string.action_back)) } },
                    )
                    state.loading -> TranscriptSkeleton()
                    state.loadFailed && state.items.none { it is ChatItem.Bubble || it is ChatItem.Call } -> EmptyState(
                        icon = R.drawable.ic_chat_offline,
                        title = brandString(R.string.chat_load_failed_title),
                        body = brandString(if (state.offline) R.string.chat_load_failed_offline else R.string.error_generic),
                        modifier = Modifier.align(Alignment.Center),
                        action = { Button(onClick = actions::reload) { Text(brandString(R.string.action_try_again)) } },
                    )
                    else -> Transcript(state, actions, onSheet = { sheet = it })
                }
            }
        }
    }

    ChatSheets(
        sheet = sheet,
        state = state,
        catalog = catalog,
        actions = actions,
        onEdit = { text -> draft = text },
        onDismiss = { sheet = null },
        onSheet = { sheet = it },
    )

    state.confirm?.let { message ->
        ConfirmSendDialog(
            message = message,
            onSend = { actions.sendAnyway(message) },
            onEdit = {
                draft = message.body.orEmpty()
                actions.delete(message)
            },
        )
    }

    state.profile?.let { card ->
        ProfileDetailsDialog(
            card = card,
            catalog = catalog,
            source = DetailsSource.Match,
            onDismiss = actions::closeProfile,
            onPass = actions::closeProfile,
            onLike = actions::closeProfile,
            onSuperlike = null,
            onLikeItem = { },
        )
    }
}

@Composable
private fun NoticeEffect(notice: ChatNotice?, snackbar: SnackbarHostState, actions: ChatActions) {
    val text = when (notice) {
        null -> null
        is ChatNotice.ActionFailed -> brandString(if (notice.offline) R.string.chat_action_offline else R.string.chat_action_failed)
        is ChatNotice.Reported -> brandString(if (notice.blocked) R.string.report_sent_blocked else R.string.report_sent)
        is ChatNotice.UnsendFailed -> brandString(R.string.chat_unsend_failed)
        is ChatNotice.Copied -> brandString(R.string.chat_copied)
    }
    LaunchedEffect(notice?.id) {
        if (notice != null && text != null) {
            snackbar.showSnackbar(text)
            actions.noticeShown(notice.id)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatTopBar(state: ChatUiState, actions: ChatActions, onSheet: (ChatSheet) -> Unit) {
    val conversation = state.conversation
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = actions::back) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = brandString(R.string.action_back))
            }
        },
        title = {
            if (conversation != null) {
                val subtitle = when {
                    state.ended -> null
                    state.typing -> brandString(R.string.chat_typing)
                    conversation.peer.online -> brandString(R.string.chat_online)
                    conversation.peer.activeRecently -> brandString(R.string.chat_active_recently)
                    else -> null
                }
                val openProfile = brandString(R.string.chat_view_profile)
                Row(
                    Modifier
                        .clickable(onClickLabel = openProfile, onClick = actions::openProfile)
                        .padding(vertical = Space.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    PeerAvatar(conversation.peer.photo, size = 40.dp, online = conversation.peer.online && !state.ended)
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                            Text(
                                conversation.peer.name,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.semantics { heading() },
                            )
                            if (conversation.peer.verified) VerifiedBadge(16.dp, description = brandString(R.string.deck_verified))
                        }
                        AnimatedVisibility(subtitle != null) {
                            Text(
                                subtitle.orEmpty(),
                                style = MaterialTheme.typography.labelMedium,
                                color = if (state.typing) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        },
        actions = {
            if (conversation != null && !state.ended && !state.gone) {
                LocalChatHeaderActions.current.invoke(this, conversation)
                var menu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { menu = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = brandString(R.string.action_more))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(brandString(R.string.chat_view_profile)) },
                            onClick = { menu = false; actions.openProfile() },
                        )
                        DropdownMenuItem(
                            text = { Text(brandString(if (conversation.muted) R.string.chat_unmute else R.string.chat_mute)) },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_chat_muted), contentDescription = null) },
                            onClick = { menu = false; actions.setMuted(!conversation.muted) },
                        )
                        DropdownMenuItem(
                            text = { Text(brandString(R.string.chat_report)) },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_chat_report), contentDescription = null) },
                            onClick = { menu = false; onSheet(ChatSheet.Report(null)) },
                        )
                        DropdownMenuItem(
                            text = { Text(brandString(R.string.chat_block)) },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_chat_block), contentDescription = null) },
                            onClick = { menu = false; onSheet(ChatSheet.Block) },
                        )
                        DropdownMenuItem(
                            text = { Text(brandString(R.string.chat_unmatch), color = MaterialTheme.colorScheme.error) },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_chat_unmatch), contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                            onClick = { menu = false; onSheet(ChatSheet.Unmatch) },
                        )
                    }
                }
            }
        },
    )
}

@Composable
private fun Composer(text: String, max: Int, onText: (String) -> Unit, onSend: () -> Unit) {
    val number = rememberNumbers()
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Space.sm, vertical = Space.sm)) {
            val near = text.length >= max - COUNTER_AT
            if (near) {
                Text(
                    brandString(R.string.chat_counter, number(text.length), number(max)),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (text.length >= max) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.End).padding(horizontal = Space.md),
                )
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                TextField(
                    value = text,
                    onValueChange = { onText(it.take(max)) },
                    placeholder = { Text(brandString(R.string.chat_composer_hint)) },
                    maxLines = 6,
                    shape = RoundedCornerShape(24.dp),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                    ),
                    modifier = Modifier.weight(1f).heightIn(min = Space.minTouch),
                )
                FilledIconButton(
                    onClick = onSend,
                    enabled = text.isNotBlank(),
                    colors = IconButtonDefaults.filledIconButtonColors(),
                    modifier = Modifier.size(Space.minTouch + 4.dp),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = brandString(R.string.chat_send))
                }
            }
        }
    }
}

private const val COUNTER_AT = 100

@Composable
private fun EndedBar() {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Space.xl, vertical = Space.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.xxs),
        ) {
            Text(brandString(R.string.chat_ended_title), style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
            Text(
                brandString(R.string.chat_ended_body),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** The copy action, shared by the message sheet. */
@Composable
fun rememberCopy(actions: ChatActions): (String) -> Unit {
    @Suppress("DEPRECATION")
    val clipboard = LocalClipboardManager.current
    return remember(clipboard, actions) {
        { text ->
            clipboard.setText(AnnotatedString(text))
            actions.copied()
        }
    }
}

/** The name of the person, isolated for a sentence in any script. */
@Composable
fun peerName(state: ChatUiState): String = isolate(state.conversation?.peer?.name.orEmpty())

@Composable
internal fun OutlinedAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    OutlinedButton(onClick = onClick, modifier = modifier.heightIn(min = Space.minTouch)) { Text(text) }
}
