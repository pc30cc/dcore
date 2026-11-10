package app.core.feature.requests

import app.core.feature.chat.rememberToday
import app.core.feature.chat.rememberMinuteNow
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.feature.chat.ReportSheet
import app.core.feature.chat.listTime
import app.core.feature.chat.rememberChatClock
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.Id
import app.core.model.MessageRequest
import app.core.model.ReportReason
import app.core.model.RequestBox
import app.core.model.RequestStatus
import app.core.sync.RequestsBox
import app.core.ui.components.AvatarFocus
import app.core.ui.components.AppBarTitle
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppMenu
import app.core.ui.components.AppMenuItem
import app.core.ui.components.AppSnackbar
import app.core.ui.components.Avatar
import app.core.ui.components.EmptyState
import app.core.ui.components.PrimaryButton
import app.core.ui.components.PushedAppBar
import app.core.ui.components.SecondaryButton
import app.core.ui.components.SegmentedControl
import app.core.ui.components.TextAction
import app.core.ui.components.VerifiedBadge
import app.core.ui.components.skeleton
import app.core.ui.components.templateCard
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import java.time.Instant
import java.time.LocalDate

interface RequestsActions {
    fun back()
    fun select(box: RequestBox)
    fun refresh()

    /** The end of the open box is on screen and the server has more. */
    fun loadMore()
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
            override fun loadMore() = vm.loadMore()
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

/**
 * Message requests (m11): the bar with «درخواست‌ها», «دریافتی، n» and
 * «فرستاده» as a segmented control, then one card per request: the face,
 * the name with the badge, when it came, the overflow (report), their
 * message, and «رد» / «قبول». Sent requests say they wait, or went
 * unanswered, with «پس بگیر». No explanation, no notes, no icons.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestsScreen(
    state: RequestsUiState,
    actions: RequestsActions,
    catalog: Catalog,
    now: Instant = rememberMinuteNow(),
    today: LocalDate = rememberToday(now),
) {
    val t = AppTheme.template
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
    // Its own page: opaque while it slides over the chats, and clear of the navigation bar at the bottom.
    val navigation = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Box(Modifier.fillMaxSize().background(t.colors.bg)) {
        Column(Modifier.fillMaxSize()) {
            PushedAppBar(onBack = actions::back, clear = true) { AppBarTitle(brandString(R.string.chat_requests)) }
            val number = rememberNumbers()
            val received = state.inbox.items.size
            SegmentedControl(
                options = listOf(
                    if (received > 0) brandString(R.string.requests_inbox_count, number(received)) else brandString(R.string.requests_inbox),
                    brandString(R.string.requests_sent),
                ),
                selected = if (state.box == RequestBox.Inbox) 0 else 1,
                onSelect = { actions.select(if (it == 0) RequestBox.Inbox else RequestBox.Sent) },
                modifier = Modifier.padding(start = Space.gutter, end = Space.gutter, top = RequestsLayout.segmentTop),
            )
            val box = state.current
            when {
                !box.loaded && (box.loading || !box.failed) -> SkeletonRequests()
                box.items.isEmpty() && box.failed && box.nextCursor == null -> Pane(
                    title = brandString(if (box.offline) R.string.error_offline else R.string.requests_load_failed),
                    action = brandString(R.string.action_try_again),
                    onAction = actions::refresh,
                )
                box.items.isEmpty() && box.nextCursor == null -> Pane(
                    title = brandString(if (state.box == RequestBox.Inbox) R.string.requests_empty_inbox_title else R.string.requests_empty_sent_title),
                )
                else -> PullToRefreshBox(isRefreshing = box.loading, onRefresh = actions::refresh, modifier = Modifier.fillMaxSize()) {
                    LazyColumn(
                        contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, top = RequestsLayout.listTop, bottom = RequestsLayout.listBottom + navigation),
                        verticalArrangement = Arrangement.spacedBy(RequestsLayout.cardGap),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(box.items, key = { it.id }) { request ->
                            RequestCard(
                                request = request,
                                inbox = state.box == RequestBox.Inbox,
                                working = request.id in state.working,
                                today = today,
                                now = now,
                                actions = actions,
                                onReport = { reporting = request },
                            )
                        }
                        if (box.nextCursor != null) {
                            item(key = "more:${state.box.wire}") { MoreRequests(box, actions) }
                        }
                    }
                }
            }
        }
        SnackbarHost(
            snackbar,
            Modifier.align(Alignment.BottomCenter).padding(start = Space.gutter, end = Space.gutter, bottom = RequestsLayout.snackbarBottom + navigation),
        ) { data ->
            AppSnackbar(data.visuals.message)
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

/** A title and, when there is one, the one thing that helps, centred. */
@Composable
private fun Pane(title: String, action: String? = null, onAction: (() -> Unit)? = null) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
        EmptyState(title = title, action = action, onAction = onAction)
    }
}

/**
 * One request (`.card.rq`): 16 dp inside (14 at the bottom); the 48 dp face,
 * the name (`--type-h3`) with the badge and when it came (`--type-body-sm`,
 * `--text-3`), the overflow at the end; their words (`--type-body`) 12 dp
 * under; then «رد» (secondary) and «قبول» (primary), 48 dp, 14 dp under.
 */
@Composable
private fun RequestCard(
    request: MessageRequest,
    inbox: Boolean,
    working: Boolean,
    today: LocalDate,
    now: Instant,
    actions: RequestsActions,
    onReport: () -> Unit,
) {
    val t = AppTheme.template
    val clock = rememberChatClock()
    Column(
        Modifier
            .fillMaxWidth()
            .templateCard(RoundedCornerShape(t.radii.card))
            .padding(start = RequestsLayout.cardPad, end = RequestsLayout.cardPad, top = RequestsLayout.cardPad, bottom = RequestsLayout.cardPadBottom),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(RequestsLayout.headGap)) {
            Avatar(RequestsLayout.avatar, photo = request.peer.photo?.let { photo -> { PhotoImage(photo, null, Modifier.fillMaxSize(), alignment = AvatarFocus) } })
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(RequestsLayout.nameGap)) {
                    Text(request.peer.name, style = t.type.h3, color = t.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (request.peer.verified) VerifiedBadge(RequestsLayout.badge)
                }
                Text(listTime(clock, request.at, today, now, hoursToday = true), style = t.type.bodySm, color = t.colors.text3, maxLines = 1)
            }
            if (inbox) {
                var menu by remember { mutableStateOf(false) }
                Box(Modifier.offset(x = RequestsLayout.moreOverhang)) {
                    AppIconButton(AppIcons.More, brandString(R.string.action_more), { menu = true }, tint = t.colors.text2)
                    AppMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        AppMenuItem(brandString(R.string.requests_report), danger = true) { menu = false; onReport() }
                    }
                }
            }
        }
        // Their words in their own direction, whatever the app's language.
        Text(
            request.body,
            style = t.type.body.copy(textDirection = TextDirection.Content),
            color = t.colors.text,
            modifier = Modifier.fillMaxWidth().padding(top = RequestsLayout.messageTop),
        )
        Spacer(Modifier.height(RequestsLayout.buttonsTop))
        if (inbox) {
            Row(horizontalArrangement = Arrangement.spacedBy(RequestsLayout.buttonGap), verticalAlignment = Alignment.CenterVertically) {
                SecondaryButton(brandString(R.string.requests_decline), { actions.decline(request) }, Modifier.weight(1f), enabled = !working, medium = true)
                PrimaryButton(brandString(R.string.requests_accept), { actions.accept(request) }, Modifier.weight(1f), enabled = !working, loading = working, medium = true)
            }
        } else {
            // The sender sees waiting, then unanswered; never whether it was declined.
            val expired = request.status == RequestStatus.Expired
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    brandString(if (expired) R.string.requests_expired else R.string.requests_pending),
                    style = t.type.bodySm,
                    color = t.colors.text3,
                    modifier = Modifier.weight(1f),
                )
                if (!expired) SecondaryButton(brandString(R.string.requests_withdraw), { actions.withdraw(request) }, enabled = !working, small = true)
            }
        }
    }
}

/**
 * The end of a box with more on the server: read on its own when it comes
 * into view; a button when that read failed, or when it read on through
 * pages whose senders are all hidden and found nothing to show.
 */
@Composable
private fun MoreRequests(box: RequestsBox, actions: RequestsActions) {
    val t = AppTheme.template
    Box(Modifier.fillMaxWidth().padding(vertical = Space.md), contentAlignment = Alignment.Center) {
        when {
            box.loadingMore -> Spinner()
            box.moreFailed -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(brandString(R.string.requests_more_failed), style = t.type.bodySm, color = t.colors.text2)
                TextAction(brandString(R.string.action_try_again), actions::loadMore)
            }
            box.moreHidden -> TextAction(brandString(R.string.requests_show_more), actions::loadMore)
            else -> {
                Spinner()
                // Again after a refresh that ran meanwhile (the ask is dropped while one runs).
                LaunchedEffect(box.nextCursor, box.loading) { if (!box.loading) actions.loadMore() }
            }
        }
    }
}

@Composable
private fun Spinner() {
    val t = AppTheme.template
    val loading = brandString(R.string.requests_loading)
    CircularProgressIndicator(color = t.colors.text3, strokeWidth = 2.dp, modifier = Modifier.size(24.dp).semantics { contentDescription = loading })
}

@Composable
private fun SkeletonRequests() {
    val t = AppTheme.template
    val loading = brandString(R.string.requests_loading)
    Column(
        Modifier.fillMaxSize().padding(start = Space.gutter, end = Space.gutter, top = RequestsLayout.listTop).clearAndSetSemantics { contentDescription = loading },
        verticalArrangement = Arrangement.spacedBy(RequestsLayout.cardGap),
    ) {
        repeat(SKELETON_CARDS) {
            Box(Modifier.fillMaxWidth().height(RequestsLayout.skeletonCard).skeleton(RoundedCornerShape(t.radii.card)))
        }
    }
}

private const val SKELETON_CARDS = 3

/** The requests' layout, from the design's 412 × 892 board (the bar ends at 88). */
private object RequestsLayout {
    /** The segmented control at 100, the cards from 168 (20 dp under it). */
    val segmentTop = 12.dp
    val listTop = 20.dp
    val listBottom = 24.dp
    val cardGap = 12.dp
    val cardPad = 16.dp
    val cardPadBottom = 14.dp
    val avatar = 48.dp
    val headGap = 12.dp
    val nameGap = 6.dp
    val badge = 16.dp

    /** The overflow's 48 dp target reaches 10 dp past the card's inner edge (`margin-left:-10px`). */
    val moreOverhang = 10.dp
    val messageTop = 12.dp
    val buttonsTop = 14.dp
    val buttonGap = 10.dp
    val snackbarBottom = 16.dp
    val skeletonCard = 180.dp
}
