package app.core.feature.requests

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.VerifiedBadge
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.feature.card.shimmer
import app.core.feature.chat.PeerAvatar
import app.core.feature.chat.ReportSheet
import app.core.feature.chat.listTime
import app.core.feature.chat.rememberChatClock
import app.core.i18n.brandString
import app.core.model.Catalog
import app.core.model.Id
import app.core.model.MessageRequest
import app.core.model.ReportReason
import app.core.model.RequestBox
import app.core.ui.components.EmptyState
import app.core.ui.theme.Space
import java.time.LocalDate

interface RequestsActions {
    fun back()
    fun select(box: RequestBox)
    fun refresh()
    fun accept(request: MessageRequest)
    fun decline(request: MessageRequest)
    fun withdraw(request: MessageRequest)
    fun report(request: MessageRequest, reason: ReportReason, details: String?, block: Boolean)
    fun noticeShown(id: Long)
}

/** Message requests: what others wrote before matching (and what this account sent). */
@Composable
fun RequestsRoute(onBack: () -> Unit, onOpenChat: (Id) -> Unit) {
    val graph = LocalAppGraph.current
    val vm: RequestsViewModel = viewModel { RequestsViewModel(graph.chat.sync) }
    val state by vm.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    val open by rememberUpdatedState(onOpenChat)
    LaunchedEffect(state.opened) {
        state.opened?.let {
            vm.openedShown()
            open(it)
        }
    }
    val back by rememberUpdatedState(onBack)
    val actions = remember(vm) {
        object : RequestsActions {
            override fun back() = back()
            override fun select(box: RequestBox) = vm.select(box)
            override fun refresh() = vm.refresh()
            override fun accept(request: MessageRequest) = vm.accept(request)
            override fun decline(request: MessageRequest) = vm.decline(request)
            override fun withdraw(request: MessageRequest) = vm.withdraw(request)
            override fun report(request: MessageRequest, reason: ReportReason, details: String?, block: Boolean) =
                vm.report(request, reason, details, block)
            override fun noticeShown(id: Long) = vm.noticeShown(id)
        }
    }
    RequestsScreen(state, actions, config?.catalog ?: Catalog())
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestsScreen(state: RequestsUiState, actions: RequestsActions, catalog: Catalog, today: LocalDate = LocalDate.now()) {
    val snackbar = remember { SnackbarHostState() }
    var reporting by remember { mutableStateOf<MessageRequest?>(null) }
    val noticeText = when (val n = state.notice) {
        null -> null
        is RequestsNotice.Declined -> brandString(R.string.requests_declined)
        is RequestsNotice.Withdrawn -> brandString(R.string.requests_withdrawn)
        is RequestsNotice.Reported -> brandString(R.string.report_sent)
        is RequestsNotice.Failed -> brandString(if (n.offline) R.string.chat_action_offline else R.string.chat_action_failed)
    }
    LaunchedEffect(state.notice?.id) {
        val notice = state.notice ?: return@LaunchedEffect
        noticeText?.let { snackbar.showSnackbar(it) }
        actions.noticeShown(notice.id)
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(brandString(R.string.chat_requests), modifier = Modifier.semantics { heading() }) },
                navigationIcon = {
                    IconButton(onClick = actions::back) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = brandString(R.string.action_back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            val number = rememberNumbers()
            PrimaryTabRow(selectedTabIndex = if (state.box == RequestBox.Inbox) 0 else 1) {
                // The tab not shown in the quieter colour: the accent alone marks the open box.
                val unselected = MaterialTheme.colorScheme.onSurfaceVariant
                Tab(
                    selected = state.box == RequestBox.Inbox,
                    onClick = { actions.select(RequestBox.Inbox) },
                    unselectedContentColor = unselected,
                    text = {
                        val n = state.inbox.items.size
                        Text(if (n > 0) brandString(R.string.requests_inbox_count, number(n)) else brandString(R.string.requests_inbox))
                    },
                )
                Tab(
                    selected = state.box == RequestBox.Sent,
                    onClick = { actions.select(RequestBox.Sent) },
                    unselectedContentColor = unselected,
                    text = { Text(brandString(R.string.requests_sent)) },
                )
            }
            val box = state.current
            when {
                !box.loaded && (box.loading || !box.failed) -> SkeletonRequests()
                box.items.isEmpty() && box.failed -> EmptyState(
                    icon = R.drawable.ic_chat_offline,
                    title = brandString(R.string.requests_load_failed),
                    body = brandString(if (box.offline) R.string.chat_load_failed_offline else R.string.error_generic),
                    modifier = Modifier.fillMaxSize(),
                    action = { Button(onClick = actions::refresh) { Text(brandString(R.string.action_try_again)) } },
                )
                box.items.isEmpty() -> EmptyState(
                    icon = R.drawable.ic_chat_requests,
                    title = brandString(if (state.box == RequestBox.Inbox) R.string.requests_empty_inbox_title else R.string.requests_empty_sent_title),
                    body = brandString(if (state.box == RequestBox.Inbox) R.string.requests_empty_inbox_body else R.string.requests_empty_sent_body),
                    modifier = Modifier.fillMaxSize(),
                )
                else -> PullToRefreshBox(isRefreshing = box.loading, onRefresh = actions::refresh, modifier = Modifier.fillMaxSize()) {
                    LazyColumn(
                        contentPadding = PaddingValues(Space.lg),
                        verticalArrangement = Arrangement.spacedBy(Space.md),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(box.items, key = { it.id }) { request ->
                            RequestCard(
                                request = request,
                                inbox = state.box == RequestBox.Inbox,
                                working = request.id in state.working,
                                today = today,
                                actions = actions,
                                onReport = { reporting = request },
                            )
                        }
                    }
                }
            }
        }
    }
    reporting?.let { request ->
        ReportSheet(
            name = isolate(request.peer.name),
            catalog = catalog,
            withMessage = true,
            evidenceNote = brandString(R.string.requests_report_note),
            onDismiss = { reporting = null },
            onSend = { reason, details, block ->
                actions.report(request, reason, details, block)
                reporting = null
            },
        )
    }
}

@Composable
private fun RequestCard(
    request: MessageRequest,
    inbox: Boolean,
    working: Boolean,
    today: LocalDate,
    actions: RequestsActions,
    onReport: () -> Unit,
) {
    val clock = rememberChatClock()
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                PeerAvatar(request.peer.photo, size = 48.dp)
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                        Text(request.peer.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (request.peer.verified) VerifiedBadge(16.dp, description = brandString(R.string.deck_verified))
                    }
                    Text(
                        listTime(clock, request.at, today),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (inbox) {
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = brandString(R.string.action_more)) }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(brandString(R.string.requests_report), color = MaterialTheme.colorScheme.error) },
                                leadingIcon = { Icon(painterResource(R.drawable.ic_chat_report), contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                                onClick = { menu = false; onReport() },
                            )
                        }
                    }
                }
            }
            // Their words in their own direction, whatever the app's language.
            Text(request.body, style = MaterialTheme.typography.bodyLarge.copy(textDirection = TextDirection.Content), modifier = Modifier.fillMaxWidth())
            if (inbox) {
                Row(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(
                        onClick = { actions.decline(request) },
                        enabled = !working,
                        modifier = Modifier.weight(1f).heightIn(min = Space.minTouch),
                    ) { Text(brandString(R.string.requests_decline)) }
                    Button(
                        onClick = { actions.accept(request) },
                        enabled = !working,
                        modifier = Modifier.weight(1f).heightIn(min = Space.minTouch),
                    ) {
                        if (working) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(brandString(R.string.requests_accept))
                    }
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        brandString(R.string.requests_pending),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(onClick = { actions.withdraw(request) }, enabled = !working) { Text(brandString(R.string.requests_withdraw)) }
                }
            }
        }
    }
}

@Composable
private fun SkeletonRequests() {
    val loading = brandString(R.string.requests_loading)
    Column(
        Modifier.fillMaxSize().padding(Space.lg).clearAndSetSemantics { contentDescription = loading },
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        repeat(3) {
            Box(Modifier.fillMaxWidth().height(148.dp).shimmer())
        }
    }
}
