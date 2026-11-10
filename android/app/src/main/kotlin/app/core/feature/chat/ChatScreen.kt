package app.core.feature.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.DetailsSource
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.CallKind
import app.core.model.Catalog
import app.core.model.Conversation
import app.core.model.Id
import app.core.model.ReportReason
import app.core.sync.ChatMessage
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppMenu
import app.core.ui.components.AppMenuItem
import app.core.ui.components.AppSnackbar
import app.core.ui.components.Avatar
import app.core.ui.components.AvatarFocus
import app.core.ui.components.EmptyState
import app.core.ui.components.PushedAppBar
import app.core.ui.components.VerifiedBadge
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import app.core.ui.theme.insetShadow
import kotlinx.coroutines.launch

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

/**
 * The thread (m10): the bar with back, who it is (face, name, badge and
 * «آنلاین» while they are), the call buttons and the overflow; the
 * transcript; the composer. A thread that ended keeps its lines and says so
 * in place of the composer.
 */
@Composable
fun ChatScreen(
    state: ChatUiState,
    actions: ChatActions,
    messageMax: Int,
    catalog: Catalog,
    modifier: Modifier = Modifier,
) {
    val t = AppTheme.template
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var draft by rememberSaveable { mutableStateOf("") }
    var sheet by remember { mutableStateOf<ChatSheet?>(null) }
    val voiceUnavailable = brandString(R.string.chat_voice_unavailable)

    NoticeEffect(state.notice, snackbar, actions)

    Box(modifier.fillMaxSize().background(t.colors.bg)) {
        Column(Modifier.fillMaxSize()) {
            ChatTopBar(state, actions, onSheet = { sheet = it })
            ConnectionLine(state.connection, state.offline && !state.loadFailed)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    state.gone -> EmptyState(
                        title = brandString(R.string.chat_gone_title),
                        action = brandString(R.string.action_back),
                        onAction = actions::back,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    state.loading -> TranscriptSkeleton()
                    state.loadFailed && state.items.none { it is ChatItem.Bubble || it is ChatItem.Call } -> EmptyState(
                        title = brandString(if (state.offline) R.string.error_offline else R.string.chat_load_failed_title),
                        action = brandString(R.string.action_try_again),
                        onAction = actions::reload,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    else -> Transcript(state, actions, onSheet = { sheet = it }, onVoice = { scope.launch { snackbar.showSnackbar(voiceUnavailable) } })
                }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = Space.gutter, vertical = ChatLayout.snackbarGap)) { data ->
                    AppSnackbar(data.visuals.message)
                }
            }
            Box(Modifier.windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
                when {
                    state.gone -> Unit
                    state.ended -> EndedBar()
                    else -> Column {
                        Composer(
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

/**
 * The thread's bar (`.appbar`): back; the face (40 dp), the name
 * (`--type-h3`) with the badge and, while they are online, «آنلاین» in
 * `--online-text` (the only place the word is shown); then the call buttons
 * and the overflow. The face and the name open the profile.
 */
@Composable
private fun ChatTopBar(state: ChatUiState, actions: ChatActions, onSheet: (ChatSheet) -> Unit) {
    val t = AppTheme.template
    val conversation = state.conversation
    PushedAppBar(
        onBack = actions::back,
        actions = {
            if (conversation != null && !state.ended && !state.gone) {
                LocalChatHeaderActions.current.invoke(this, conversation)
                var menu by remember { mutableStateOf(false) }
                Box {
                    AppIconButton(AppIcons.More, brandString(R.string.action_more), { menu = true })
                    AppMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        AppMenuItem(brandString(R.string.chat_view_profile)) { menu = false; actions.openProfile() }
                        AppMenuItem(brandString(if (conversation.muted) R.string.chat_unmute else R.string.chat_mute)) { menu = false; actions.setMuted(!conversation.muted) }
                        AppMenuItem(brandString(R.string.chat_report)) { menu = false; onSheet(ChatSheet.Report(null)) }
                        AppMenuItem(brandString(R.string.chat_block), danger = true) { menu = false; onSheet(ChatSheet.Block) }
                        AppMenuItem(brandString(R.string.chat_unmatch), danger = true) { menu = false; onSheet(ChatSheet.Unmatch) }
                    }
                }
            }
        },
    ) {
        if (conversation != null) {
            val online = conversation.peer.online && !state.ended
            val openProfile = brandString(R.string.chat_view_profile)
            Row(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(t.radii.sm))
                    .clickable(onClickLabel = openProfile, onClick = actions::openProfile)
                    .padding(vertical = ChatLayout.whoPad),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(ChatLayout.whoGap),
            ) {
                Avatar(ChatLayout.avatar, photo = conversation.peer.photo?.let { photo -> { PhotoImage(photo, null, Modifier.fillMaxSize(), alignment = AvatarFocus) } })
                Column(Modifier.weight(1f, fill = false)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ChatLayout.nameGap)) {
                        Text(
                            conversation.peer.name,
                            style = t.type.h3,
                            color = t.colors.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false).semantics { heading() },
                        )
                        if (conversation.peer.verified) VerifiedBadge(ChatLayout.badge)
                    }
                    AnimatedVisibility(online) {
                        Text(brandString(R.string.chat_online), style = t.type.caption, color = t.colors.onlineText)
                    }
                }
            }
        } else {
            Box(Modifier.weight(1f))
        }
    }
}

/**
 * The composer (`.cbar`): the field (52 dp, `--surface-field` with
 * `--field-line`, `--r-button` but never rounder than its one-line height,
 * «یه پیام بفرست…»), growing to five lines, and the 52 dp send button at the
 * end: `--surface-2` while there is nothing to send, `--primary-fill` with
 * `--on-primary` once there is. No attach or voice button: this version
 * sends text only. The count shows near the limit.
 */
@Composable
private fun Composer(text: String, max: Int, onText: (String) -> Unit, onSend: () -> Unit) {
    val t = AppTheme.template
    val number = rememberNumbers()
    val shape = RoundedCornerShape(min(t.radii.button, ChatLayout.composer / 2))
    val canSend = text.isNotBlank()
    // The design's 24 dp under the field holds its gesture bar: the navigation bar's own
    // height (already under the composer) comes off it, and over the keyboard a small gap.
    val density = LocalDensity.current
    val navigation = with(density) { WindowInsets.navigationBars.getBottom(density).toDp() }
    val keyboard = WindowInsets.ime.getBottom(density) > 0
    val bottom = if (keyboard) ChatLayout.composerMinBottom else maxOf(ChatLayout.composerMinBottom, ChatLayout.composerBottom - navigation)
    Column(Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, top = ChatLayout.composerTop, bottom = bottom)) {
        if (text.length >= max - COUNTER_AT) {
            Text(
                brandString(R.string.chat_counter, number(text.length), number(max)),
                style = t.type.caption,
                color = if (text.length >= max) t.colors.error else t.colors.text3,
                modifier = Modifier.align(Alignment.End).padding(bottom = ChatLayout.counterGap),
            )
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(ChatLayout.composerGap)) {
            val hint = brandString(R.string.chat_composer_hint)
            BasicTextField(
                value = text,
                onValueChange = { onText(it.take(max)) },
                // The draft follows the direction of what is typed, not the app's.
                textStyle = t.type.field.copy(color = t.colors.text, textDirection = TextDirection.Content),
                cursorBrush = SolidColor(t.colors.caret),
                maxLines = COMPOSER_LINES,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = ChatLayout.composer)
                    .background(t.colors.surfaceField, shape)
                    .insetShadow(shape, t.shadows.fieldLine)
                    .semantics { contentDescription = hint },
                decorationBox = { field ->
                    Box(Modifier.padding(horizontal = ChatLayout.fieldPadH, vertical = ChatLayout.fieldPadV), contentAlignment = Alignment.CenterStart) {
                        if (text.isEmpty()) Text(hint, style = t.type.fieldPlaceholder, color = t.colors.text3, maxLines = 1)
                        field()
                    }
                },
            )
            val send = brandString(R.string.chat_send)
            Box(
                Modifier
                    .size(ChatLayout.composer)
                    .clip(CircleShape)
                    .then(if (canSend) Modifier.background(t.paints.primaryFill, CircleShape) else Modifier.background(t.colors.surface2, CircleShape))
                    .clickable(enabled = canSend, role = androidx.compose.ui.semantics.Role.Button, onClick = onSend)
                    .semantics { contentDescription = send },
                contentAlignment = Alignment.Center,
            ) {
                Icon(AppIcons.Forward, contentDescription = null, tint = if (canSend) t.colors.onPrimary else t.colors.text3, modifier = Modifier.size(ChatLayout.sendIcon))
            }
        }
    }
}

private const val COUNTER_AT = 100
private const val COMPOSER_LINES = 5

@Composable
private fun EndedBar() {
    val t = AppTheme.template
    Column(
        Modifier.fillMaxWidth().background(t.colors.surface2).padding(horizontal = Space.gutter, vertical = ChatLayout.endedPad),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(brandString(R.string.chat_ended_title), style = t.type.bodyStrong, color = t.colors.text, textAlign = TextAlign.Center)
        Text(brandString(R.string.chat_ended_body), style = t.type.bodySm, color = t.colors.text2, textAlign = TextAlign.Center)
    }
}

/** The thread's layout, from the design's board (`.appbar .who`, `.cbar`). */
private object ChatLayout {
    val avatar = 40.dp
    val whoGap = 10.dp
    val whoPad = 4.dp
    val nameGap = 6.dp
    val badge = 16.dp
    val composer = 52.dp
    val composerGap = 8.dp
    val composerTop = 8.dp

    /** The composer's bottom 24 dp over the screen's edge on the design's phone (its gesture bar inside). */
    val composerBottom = 24.dp
    val composerMinBottom = 8.dp
    val counterGap = 4.dp
    val sendIcon = 22.dp
    val fieldPadH = 18.dp
    val fieldPadV = 12.dp
    val endedPad = 16.dp
    val snackbarGap = 12.dp
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

