package app.core.feature.likes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.DetailsNotice
import app.core.feature.card.DetailsSource
import app.core.feature.card.LikeTarget
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.card.isolate
import app.core.feature.card.nameAndAge
import app.core.feature.card.rememberNumbers
import app.core.feature.deck.ItemLikeSheet
import app.core.feature.deck.QuotaSheet
import app.core.feature.match.MatchMomentDialog
import app.core.feature.match.matchOpeners
import app.core.feature.paywall.LocalPaywall
import app.core.feature.paywall.PaywallEntry
import app.core.feature.paywall.PaywallRequest
import app.core.feature.call.rememberLanguage
import app.core.feature.chat.ReportSheet
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.media.BlurHashImage
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.Id
import app.core.model.LikeItem
import app.core.model.LikeKind
import app.core.model.LikesPage
import app.core.model.Me
import app.core.model.ProfileCard
import app.core.model.PublicUid
import app.core.model.ReportReason
import app.core.model.ReportRequest
import app.core.net.ServerApi
import app.core.net.internetAvailability
import app.core.ui.components.AppDialog
import app.core.ui.components.AppSnackbar
import app.core.ui.components.ChipRow
import app.core.ui.components.ChoiceChip
import app.core.ui.components.ChoiceKind
import app.core.ui.components.EmptyState
import app.core.ui.components.LocalTabBarSpace
import app.core.ui.components.Pill
import app.core.ui.components.PillKind
import app.core.ui.components.PrimaryButton
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.VerifiedBadge
import app.core.ui.components.listBottomPadding
import app.core.ui.components.skeleton
import app.core.ui.components.snackbarBottomPadding
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import app.core.ui.theme.TabBarStyle
import app.core.ui.theme.photoFilter

interface LikesActions {
    fun refresh()
    fun loadMore()
    fun open(item: LikeItem)
    fun closeDetails()
    fun likeBack()

    /** The like button on an open tile. */
    fun likeBack(item: LikeItem)
    fun pass()
    fun openItemLike(target: LikeTarget)
    fun sendItemLike(target: LikeTarget, comment: String)
    fun dismissItemLike()
    fun dismissUpsell()
    fun dismissQuota()
    fun dismissMatch()
    fun messageShown(id: Long)
    fun openChat(conversationId: Id?)
    fun browse()

    /** A report on [card] from their profile; [block] blocks them too. */
    fun report(card: ProfileCard, reason: ReportReason, details: String?, block: Boolean) {}

    /** Blocks [card] from their profile. */
    fun block(card: ProfileCard) {}
}

class ServerLikesServices(private val api: ServerApi) : LikesServices {
    override suspend fun likes(cursor: String?, limit: Int): LikesPage = api.likes(cursor, limit)
    override suspend fun me(): Me = api.me().value
    override suspend fun report(request: ReportRequest) {
        api.report(request)
    }
    override suspend fun block(target: PublicUid) = api.block(target)
}

/** The Likes tab. [onBrowse] goes to the deck (from the empty state); [onTotal] hears each total a page brings (the tab's badge). */
@Composable
fun LikesRoute(onOpenChat: (Id?) -> Unit, onBrowse: () -> Unit, modifier: Modifier = Modifier, onTotal: (LikesTotal) -> Unit = {}) {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    val vm: LikesViewModel = viewModel { LikesViewModel(ServerLikesServices(graph.api), graph.deck, graph.entitlements, graph.clock) }
    val state by vm.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    val total by rememberUpdatedState(onTotal)
    LaunchedEffect(state.status, state.total, state.totalPlus) {
        if (state.status == LikesStatus.Ready) total(LikesTotal(state.total, state.totalPlus))
    }
    LifecycleStartEffect(vm) {
        vm.start()
        // The list on screen says what the "new likes" notification said.
        graph.push.notifications.clearLikes()
        onStopOrDispose { }
    }
    LaunchedEffect(vm) { context.internetAvailability().collect { if (it) vm.online() } }
    val chat by rememberUpdatedState(onOpenChat)
    val browse by rememberUpdatedState(onBrowse)
    val actions = remember(vm) {
        object : LikesActions {
            override fun refresh() = vm.refresh()
            override fun loadMore() = vm.loadMore()
            override fun open(item: LikeItem) = vm.open(item)
            override fun closeDetails() = vm.closeDetails()
            override fun likeBack() = vm.likeBack()
            override fun likeBack(item: LikeItem) = vm.likeBack(item)
            override fun pass() = vm.pass()
            override fun openItemLike(target: LikeTarget) = vm.openItemLike(target)
            override fun sendItemLike(target: LikeTarget, comment: String) = vm.sendItemLike(target, comment)
            override fun dismissItemLike() = vm.dismissItemLike()
            override fun dismissUpsell() = vm.dismissUpsell()
            override fun dismissQuota() = vm.dismissQuota()
            override fun dismissMatch() = vm.dismissMatch()
            override fun messageShown(id: Long) = vm.messageShown(id)
            override fun openChat(conversationId: Id?) = chat(conversationId)
            override fun browse() = browse()
            override fun report(card: ProfileCard, reason: ReportReason, details: String?, block: Boolean) = vm.report(card, reason, details, block)
            override fun block(card: ProfileCard) = vm.block(card)
        }
    }
    LikesScreen(
        state = state,
        catalog = config?.catalog ?: Catalog(),
        commentMax = config?.limits?.commentMax ?: 300,
        actions = actions,
        modifier = modifier,
    )
}

/** Which likes the grid shows: all, super likes, or those with a note. */
enum class LikesFilter { All, Super, Note }

/** The likes [filter] keeps, in the list's order. */
internal fun LikesUiState.shown(filter: LikesFilter): List<LikeItem> = when (filter) {
    LikesFilter.All -> items
    LikesFilter.Super -> items.filter { it.kind == LikeKind.Superlike }
    LikesFilter.Note -> items.filter { !it.comment.isNullOrBlank() }
}

/**
 * The Likes tab (m08, m08b): the title, the filter chips with their counts,
 * and a two-column grid of 244 dp tiles. An open like is its photo with the
 * name, age and badge on the scrim, a tag («سوپرلایک», «رایگان امروز»), the
 * note on its own chip, and a like button; a tap opens the profile. A like
 * the plan hides is its blurred photo only; under the grid, one button to
 * the plans. Nothing else: no subtitle, no captions, no icons on chips.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LikesScreen(
    state: LikesUiState,
    catalog: Catalog,
    commentMax: Int,
    actions: LikesActions,
    modifier: Modifier = Modifier,
) {
    val t = AppTheme.template
    val number = rememberNumbers()
    val snackbar = remember { SnackbarHostState() }
    val paywall = LocalPaywall.current
    var filter by rememberSaveable { mutableStateOf(LikesFilter.All) }

    // A notice while the profile is up is drawn over it (its window covers this screen's).
    val notice: DetailsNotice? = state.message?.let { message ->
        val text = when (message.notice) {
            LikesNotice.LikeOffline -> brandString(R.string.deck_like_offline)
            LikesNotice.LikeFailed -> brandString(R.string.deck_like_failed)
            LikesNotice.RateLimited -> brandString(R.string.deck_rate_limited)
            LikesNotice.Passed -> brandString(R.string.likes_pass_done, isolate(message.name.orEmpty()))
            LikesNotice.Reported -> brandString(R.string.deck_reported)
            LikesNotice.Blocked -> brandString(R.string.deck_blocked, isolate(message.name.orEmpty()))
            LikesNotice.Offline -> brandString(R.string.error_offline)
            LikesNotice.SafetyFailed -> brandString(R.string.deck_safety_failed)
        }
        DetailsNotice(message.id, text)
    }
    if (notice != null && state.details == null) {
        LaunchedEffect(notice.id) {
            snackbar.showSnackbar(notice.text)
            actions.messageShown(notice.id)
        }
    }
    // A hidden like opens the plans that show it, straight away (no sheet in between).
    LaunchedEffect(state.upsell) {
        if (state.upsell) {
            actions.dismissUpsell()
            // The title says how many like the person: the server's total, when it has one.
            paywall.open(PaywallRequest.Plans(PaywallEntry.SEE_LIKES, likes = state.total.takeIf { it > 0 }))
        }
    }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            // The title row as on Chats (`.thead`): 52 dp, the title centred in it, so it does not move between the tabs.
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(start = Space.gutter, end = Space.gutter, top = LikesLayout.titleTop)
                    .heightIn(min = LikesLayout.titleHeight),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    brandString(R.string.tab_likes),
                    style = t.type.h1,
                    color = t.colors.text,
                    maxLines = 1,
                    modifier = Modifier.semantics { heading() },
                )
            }
            val ready = state.status == LikesStatus.Ready && state.items.isNotEmpty()
            if (ready) FilterChips(state, filter, number) { filter = it }
            when {
                state.status == LikesStatus.Loading && state.items.isEmpty() -> SkeletonGrid()
                state.status == LikesStatus.Offline -> Pane(brandString(R.string.error_offline), brandString(R.string.action_try_again), actions::refresh)
                state.status == LikesStatus.Failed -> Pane(brandString(R.string.error_generic), brandString(R.string.action_try_again), actions::refresh)
                state.items.isEmpty() -> Pane(brandString(R.string.likes_empty_title), brandString(R.string.likes_empty_action), actions::browse)
                else -> PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = actions::refresh,
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LikesGrid(state, state.shown(filter), number, actions, filtered = filter != LikesFilter.All)
                    ListFade(Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(start = Space.gutter, end = Space.gutter, bottom = snackbarBottomPadding)) { data ->
            AppSnackbar(data.visuals.message)
        }
    }

    // Who is being reported or blocked survives the activity being made again; the card is looked up by id.
    var reportingId by rememberSaveable { mutableStateOf<String?>(null) }
    var blockingId by rememberSaveable { mutableStateOf<String?>(null) }
    fun known(id: String?): ProfileCard? = id?.let { wanted ->
        state.details?.takeIf { it.id == wanted } ?: state.items.firstNotNullOfOrNull { item -> item.liker?.takeIf { it.id == wanted } }
    }
    val reporting = known(reportingId)
    val blocking = known(blockingId)
    state.details?.let { card ->
        ProfileDetailsDialog(
            card = card,
            catalog = catalog,
            source = DetailsSource.Likes,
            onDismiss = actions::closeDetails,
            onPass = actions::pass,
            onLike = actions::likeBack,
            onSuperlike = null,
            onLikeItem = actions::openItemLike,
            onReport = { reportingId = card.id },
            onBlock = { blockingId = card.id },
            notice = notice,
            onNoticeShown = actions::messageShown,
        )
    }
    reporting?.let { card ->
        ReportSheet(
            name = card.name,
            catalog = catalog,
            withMessage = false,
            onDismiss = { reportingId = null },
            onSend = { reason, details, block ->
                reportingId = null
                actions.report(card, reason, details, block)
            },
            evidenceNote = brandString(R.string.report_profile_note),
        )
    }
    blocking?.let { card ->
        AppDialog(
            title = brandString(R.string.chat_block_title, isolate(card.name)),
            body = null,
            confirm = brandString(R.string.profile_block),
            onConfirm = {
                blockingId = null
                actions.block(card)
            },
            dismiss = brandString(R.string.action_cancel),
            onDismiss = { blockingId = null },
        )
    }
    state.itemLike?.let { target ->
        ItemLikeSheet(target, state.itemLikeState, commentMax, { actions.sendItemLike(target, it) }, actions::dismissItemLike)
    }
    state.quota?.let { (action, resetsAt) -> QuotaSheet(action, resetsAt, actions::dismissQuota) }
    state.match?.let { match ->
        MatchMomentDialog(
            their = match.card,
            myPhoto = match.myPhoto,
            onSendMessage = {
                actions.dismissMatch()
                actions.openChat(match.conversationId)
            },
            onDismiss = actions::dismissMatch,
            conversationId = match.conversationId,
            openers = matchOpeners(match.card, catalog),
        )
    }
}

/**
 * «همه ۱۲», «سوپرلایک ۲», «با یادداشت ۳»: the selected one in the selected
 * treatment with its check. All counts the server's total; the others count
 * the likes loaded so far (the server sends no count per kind). A filter
 * with nothing in it is left out, and the row with it when only «همه» is left.
 */
@Composable
private fun FilterChips(state: LikesUiState, filter: LikesFilter, number: (Int) -> String, onFilter: (LikesFilter) -> Unit) {
    val superlikes = state.items.count { it.kind == LikeKind.Superlike }
    val notes = state.items.count { !it.comment.isNullOrBlank() }
    if (superlikes == 0 && notes == 0 && filter == LikesFilter.All) return
    // The server's total can run to thousands: grouped as the language writes them («۱٬۲۴۵», "1,245", "1.245").
    val language = rememberLanguage()
    val all = Numerals.format(state.total.coerceAtLeast(state.items.size), language) + if (state.totalPlus) "+" else ""
    ChipRow(Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, top = LikesLayout.chipsTop), group = true) {
        ChoiceChip(brandString(R.string.likes_filter_all), filter == LikesFilter.All, { onFilter(LikesFilter.All) }, count = all, kind = ChoiceKind.Tab)
        if (superlikes > 0 || filter == LikesFilter.Super) {
            ChoiceChip(brandString(R.string.likes_filter_super), filter == LikesFilter.Super, { onFilter(LikesFilter.Super) }, count = number(superlikes), kind = ChoiceKind.Tab)
        }
        if (notes > 0 || filter == LikesFilter.Note) {
            ChoiceChip(brandString(R.string.likes_filter_note), filter == LikesFilter.Note, { onFilter(LikesFilter.Note) }, count = number(notes), kind = ChoiceKind.Tab)
        }
    }
}

/**
 * What the locked grid shows (m08): every open like (the day's free look, a
 * super like the server opened) and blurred ones up to [LOCKED_PREVIEW]
 * tiles in all, in the server's order; the button under them says the rest.
 */
internal fun lockedPreview(shown: List<LikeItem>): List<LikeItem> {
    var room = (LOCKED_PREVIEW - shown.count { it.liker != null }).coerceAtLeast(0)
    return shown.filter { item -> item.liker != null || room-- > 0 }
}

/** Two rows of the design's two columns. */
internal const val LOCKED_PREVIEW = 4

@Composable
private fun LikesGrid(state: LikesUiState, shown: List<LikeItem>, number: (Int) -> String, actions: LikesActions, filtered: Boolean = false) {
    // Without `see_likes` the grid is a preview over one button; more blurred pages would add nothing.
    val locked = state.anyHidden
    val tiles = if (locked) lockedPreview(shown) else shown
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = LikesLayout.tileMin),
        contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, top = LikesLayout.gridTop, bottom = listBottomPadding),
        horizontalArrangement = Arrangement.spacedBy(LikesLayout.gap),
        verticalArrangement = Arrangement.spacedBy(LikesLayout.gap),
        modifier = Modifier.fillMaxSize(),
    ) {
        itemsIndexed(tiles, key = { index, item -> item.liker?.id ?: "hidden:$index" }) { _, item ->
            LikeTile(
                item = item,
                dailyReveal = state.isDailyReveal(item),
                number = number,
                onClick = { actions.open(item) },
                onLike = { actions.likeBack(item) },
                liking = item.liker?.id in state.liking,
            )
        }
        if (state.anyHidden) {
            item(key = "see-all", span = { GridItemSpan(maxLineSpan) }) {
                PrimaryButton(
                    brandString(R.string.likes_see_all),
                    onClick = { actions.open(state.items.first { it.liker == null }) },
                    modifier = Modifier.padding(top = LikesLayout.buttonTop - LikesLayout.gap),
                )
            }
        }
        if (!locked && (state.nextCursor != null || state.moreFailed)) {
            item(key = "more", span = { GridItemSpan(maxLineSpan) }) {
                val t = AppTheme.template
                Box(Modifier.fillMaxWidth().padding(vertical = Space.lg), contentAlignment = Alignment.Center) {
                    if (state.moreFailed) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(brandString(R.string.likes_more_failed), style = t.type.bodySm, color = t.colors.text2)
                            TextAction(brandString(R.string.action_try_again), actions::loadMore)
                        }
                    } else if (filtered && !state.loadingMore) {
                        // A filter may leave a few tiles, so this row stays in view: the next page waits to be asked
                        // for, or every page would be read back to back.
                        TextAction(brandString(R.string.likes_show_more), actions::loadMore)
                    } else {
                        CircularProgressIndicator(color = t.colors.text3, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                        LaunchedEffect(state.nextCursor) { actions.loadMore() }
                    }
                }
            }
        }
    }
}

/**
 * Under a floating tab bar the grid fades into the page behind it (neon's
 * `.listfade`: the bar's room plus 40 dp, the page colour from 46 %). A
 * docked bar is opaque and takes its own room: nothing.
 */
@Composable
private fun ListFade(modifier: Modifier) {
    val t = AppTheme.template
    if (t.switches.tabBar != TabBarStyle.Floating) return
    val bar = LocalTabBarSpace.current ?: return
    Box(
        modifier
            .fillMaxWidth()
            .height(bar + LikesLayout.fadeAbove)
            .background(Brush.verticalGradient(0f to Color.Transparent, LikesLayout.fadeStop to t.colors.bg, 1f to t.colors.bg)),
    )
}

/**
 * One like. Open: the photo, the bottom scrim, the tag at the top start,
 * the note on its chip, «نام، سن» with the badge (and the online dot) at the
 * bottom start, and the 40 dp like button (48 dp target) at the bottom end;
 * a tap opens the profile. Hidden: the blurhash under `--photo-locked-filter`
 * and its tag; a tap opens the plans.
 */
@Composable
private fun LikeTile(item: LikeItem, dailyReveal: Boolean, number: (Int) -> String, onClick: () -> Unit, onLike: () -> Unit, liking: Boolean = false) {
    val t = AppTheme.template
    val card = item.liker
    val shape = RoundedCornerShape(t.radii.card)
    val label = if (card != null) brandString(R.string.likes_open_profile, isolate(card.name)) else brandString(R.string.likes_hidden_person)
    val describe = card?.let { nameAndAge(it, number) } ?: brandString(R.string.likes_hidden_person)
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(LikesLayout.tileAspect)
            .clip(shape)
            .background(t.colors.photoPlaceholder)
            .clickable(onClickLabel = label, role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = describe },
    ) {
        if (card != null) {
            PhotoImage(card.photos.firstOrNull(), null, Modifier.fillMaxSize(), alignment = LikesLayout.photoAlignment)
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .fillMaxHeight(LikesLayout.scrimShare)
                    .background(t.paints.photoScrimBottom),
            )
        } else {
            BlurHashImage(
                item.blurhash,
                Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = LikesLayout.lockedScale
                        scaleY = LikesLayout.lockedScale
                    }
                    .photoFilter(t.filters.photoLockedFilter),
            )
        }
        val tag = when {
            item.kind == LikeKind.Superlike -> brandString(R.string.likes_superlike)
            dailyReveal -> brandString(R.string.likes_free_today)
            else -> null
        }
        if (tag != null) Pill(tag, Modifier.align(Alignment.TopStart).padding(LikesLayout.tagInset), kind = PillKind.Tag)
        if (card == null) return@Box
        // The note sits on its own, 64 dp up from the tile's bottom (`.note{bottom:64px}`).
        item.comment?.takeIf { it.isNotBlank() }?.let { comment ->
            val rtl = startsRightToLeft(comment)
            Text(
                // The note's own script picks its quotes and its direction: «…» right to left, “…” left to right.
                if (rtl) "«$comment»" else "“$comment”",
                style = t.type.bodySm.copy(textDirection = if (rtl) TextDirection.Rtl else TextDirection.Ltr),
                color = t.colors.onPhoto,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxWidth()
                    .padding(start = LikesLayout.noteInset, end = LikesLayout.noteInset, bottom = LikesLayout.noteBottom)
                    .background(t.colors.noteFill, RoundedCornerShape(t.sizes.noteR))
                    .padding(t.sizes.notePad),
            )
        }
        // «نام، سن», the badge and the online dot, centred on the like button's 40 dp
        // circle; the line stays clear of the circle, and the dot goes before the name is cut.
        Box(
            Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .padding(start = LikesLayout.nameStart, end = LikesLayout.nameEnd, bottom = LikesLayout.likeInset)
                .height(LikesLayout.like),
            contentAlignment = Alignment.CenterStart,
        ) {
            TileName(nameAndAge(card, number), verified = card.verified, online = card.activeRecently)
        }
        LikeButton(onLike, enabled = !liking, modifier = Modifier.align(Alignment.BottomEnd).padding(LikesLayout.likeInset - (LikesLayout.likeTarget - LikesLayout.like) / 2))
    }
}

/**
 * The tile's name line: the name and age (`--type-h3`, one line), the badge
 * and the online dot, as wide as they need up to the room there is. The dot
 * is left out when the three do not fit; then the name is cut, never the badge.
 * One measure pass, no subcomposition: a grid draws many of these.
 */
@Composable
private fun TileName(name: String, verified: Boolean, online: Boolean) {
    val t = AppTheme.template
    Layout(
        content = {
            Text(name, style = t.type.h3, color = t.colors.onPhoto, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (verified) VerifiedBadge(LikesLayout.badge)
            if (online) Box(Modifier.size(LikesLayout.onlineDot).background(t.colors.online, CircleShape))
        },
    ) { measurables, constraints ->
        val gap = LikesLayout.nameGap.roundToPx()
        val dotGap = LikesLayout.dotGap.roundToPx()
        val free = Constraints()
        val badge = if (verified) measurables[1].measure(free) else null
        val dot = if (online) measurables.last().measure(free) else null
        val badgeWidth = badge?.let { it.width + gap } ?: 0
        val dotWidth = dot?.let { it.width + dotGap } ?: 0
        val room = constraints.maxWidth
        val natural = measurables[0].maxIntrinsicWidth(Constraints.Infinity)
        val showDot = dot != null && natural + badgeWidth + dotWidth <= room
        val nameRoom = (room - badgeWidth - if (showDot) dotWidth else 0).coerceAtLeast(0)
        val text = measurables[0].measure(Constraints(maxWidth = nameRoom))
        val height = maxOf(text.height, badge?.height ?: 0, dot?.height ?: 0)
        val width = text.width + badgeWidth + if (showDot) dotWidth else 0
        layout(width, height) {
            text.placeRelative(0, (height - text.height) / 2)
            var x = text.width
            badge?.let {
                x += gap
                it.placeRelative(x, (height - it.height) / 2)
                x += it.width
            }
            if (showDot) dot?.let { it.placeRelative(x + dotGap, (height - it.height) / 2) }
        }
    }
}

/** Whether [text]'s first strong letter is written right to left (Persian, Arabic, Hebrew). */
internal fun startsRightToLeft(text: String): Boolean {
    for (c in text) {
        when (Character.getDirectionality(c)) {
            Character.DIRECTIONALITY_RIGHT_TO_LEFT, Character.DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC -> return true
            Character.DIRECTIONALITY_LEFT_TO_RIGHT -> return false
        }
    }
    return false
}

/** The tile's like: 40 dp in `--like-fill` with the heart, in its 48 dp target. */
@Composable
private fun LikeButton(onClick: () -> Unit, enabled: Boolean, modifier: Modifier) {
    val t = AppTheme.template
    val label = brandString(R.string.deck_action_like)
    Box(
        modifier
            .size(LikesLayout.likeTarget)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(LikesLayout.like).background(t.paints.likeFill, CircleShape), contentAlignment = Alignment.Center) {
            Icon(AppIcons.Heart, contentDescription = null, tint = t.colors.onLike, modifier = Modifier.size(LikesLayout.heart))
        }
    }
}

@Composable
private fun SkeletonGrid() {
    val t = AppTheme.template
    val label = brandString(R.string.deck_loading)
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = LikesLayout.tileMin),
        contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, top = LikesLayout.gridTop),
        horizontalArrangement = Arrangement.spacedBy(LikesLayout.gap),
        verticalArrangement = Arrangement.spacedBy(LikesLayout.gap),
        userScrollEnabled = false,
        modifier = Modifier.fillMaxSize().semantics { contentDescription = label },
    ) {
        items(SKELETON_TILES) {
            Box(Modifier.fillMaxWidth().aspectRatio(LikesLayout.tileAspect).skeleton(RoundedCornerShape(t.radii.card)))
        }
    }
}

/** The title and one action, centred (empty, offline, failed). */
@Composable
private fun Pane(title: String, action: String, onAction: () -> Unit) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = listBottomPadding), contentAlignment = Alignment.Center) {
        EmptyState(title = title, action = action, onAction = onAction)
    }
}

private const val SKELETON_TILES = 6

/** The Likes tab's layout, from the design's 412 × 892 board (status bar 32 dp). */
private object LikesLayout {
    /** The title row: 12 dp under the status bar, 52 dp tall (`.thead`). */
    val titleTop = 12.dp
    val titleHeight = 52.dp

    /** The chips' 48 dp targets start 6 dp under the title row (the chips themselves at 104). */
    val chipsTop = 6.dp

    /** The grid's first row, 14 dp under the chips' targets (at 164). */
    val gridTop = 14.dp
    val gap = 10.dp

    /** A tile is 181 × 244 dp on the design's phone; two columns down to 156 dp each. */
    val tileMin = 156.dp
    const val tileAspect = 181f / 244f

    /** The faces sit high in a portrait (`background-position: 50% 20%`). */
    val photoAlignment = androidx.compose.ui.BiasAlignment(0f, -0.6f)
    const val scrimShare = 0.58f
    const val lockedScale = 1.15f
    val tagInset = 10.dp
    val noteInset = 10.dp

    /** The note's bottom 64 dp above the tile's (`.note{bottom:64px}`). */
    val noteBottom = 64.dp
    val nameStart = 12.dp

    /**
     * The name line may run up to the like circle (10 + 40 dp from the
     * tile's end): on the board «یاسمن، ۲۳» with its badge and dot ends
     * 1.5 dp from it (`.lname` runs on past `left:60px`).
     */
    val nameEnd = 50.dp
    val nameGap = 6.dp

    /** The online dot 4 dp after the badge, so an ordinary name keeps it on a narrow tile. */
    val dotGap = 4.dp
    val badge = 18.dp
    val onlineDot = 10.dp

    val like = 40.dp
    val likeTarget = 48.dp
    val heart = 20.dp
    val likeInset = 10.dp

    /** The button 24 dp under the grid. */
    val buttonTop = 24.dp
    val fadeAbove = 40.dp
    const val fadeStop = 0.46f
}
