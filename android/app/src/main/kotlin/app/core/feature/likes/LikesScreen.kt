package app.core.feature.likes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.DetailsSource
import app.core.feature.card.LikeTarget
import app.core.feature.card.PhotoPill
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.card.VerifiedBadge
import app.core.feature.card.isolate
import app.core.feature.card.nameAndAge
import app.core.feature.card.rememberNumbers
import app.core.feature.card.shimmer
import app.core.feature.deck.ItemLikeSheet
import app.core.feature.deck.QuotaSheet
import app.core.feature.deck.UpsellSheet
import app.core.feature.match.MatchMomentDialog
import app.core.i18n.brandString
import app.core.media.BlurHashImage
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.Id
import app.core.model.ItemKind
import app.core.model.LikeItem
import app.core.model.LikeKind
import app.core.model.LikesPage
import app.core.model.Me
import app.core.net.ServerApi
import app.core.net.internetAvailability
import app.core.ui.components.EmptyState
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius
import app.core.ui.theme.Space

interface LikesActions {
    fun refresh()
    fun loadMore()
    fun open(item: LikeItem)
    fun closeDetails()
    fun likeBack()
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
}

class ServerLikesServices(private val api: ServerApi) : LikesServices {
    override suspend fun likes(cursor: String?, limit: Int): LikesPage = api.likes(cursor, limit)
    override suspend fun me(): Me = api.me().value
}

/** The Likes tab. [onBrowse] goes to the deck (from the empty state). */
@Composable
fun LikesRoute(onOpenChat: (Id?) -> Unit, onBrowse: () -> Unit, modifier: Modifier = Modifier) {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    val vm: LikesViewModel = viewModel { LikesViewModel(ServerLikesServices(graph.api), graph.deck, graph.entitlements, graph.clock) }
    val state by vm.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
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
        }
    }
    LikesScreen(
        state = state,
        catalog = config?.catalog ?: Catalog(),
        planNames = config?.planNames.orEmpty(),
        commentMax = config?.limits?.commentMax ?: 300,
        actions = actions,
        modifier = modifier,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LikesScreen(
    state: LikesUiState,
    catalog: Catalog,
    planNames: Map<String, String>,
    commentMax: Int,
    actions: LikesActions,
    modifier: Modifier = Modifier,
) {
    val number = rememberNumbers()
    val snackbar = remember { SnackbarHostState() }

    state.message?.let { message ->
        val text = when (message.notice) {
            LikesNotice.LikeOffline -> brandString(R.string.deck_like_offline)
            LikesNotice.LikeFailed -> brandString(R.string.deck_like_failed)
            LikesNotice.RateLimited -> brandString(R.string.deck_rate_limited)
            LikesNotice.Passed -> brandString(R.string.likes_pass_done, message.name.orEmpty())
        }
        LaunchedEffect(message.id) {
            snackbar.showSnackbar(text)
            actions.messageShown(message.id)
        }
    }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.padding(start = Space.xl, end = Space.xl, top = Space.md, bottom = Space.sm)) {
                Text(brandString(R.string.tab_likes), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                if (state.status == LikesStatus.Ready && state.total > 0) {
                    Text(
                        when {
                            state.totalPlus -> brandString(R.string.likes_count_plus, number(state.total))
                            state.total == 1 -> brandString(R.string.likes_count_one)
                            else -> brandString(R.string.likes_count, number(state.total))
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            when {
                state.status == LikesStatus.Loading && state.items.isEmpty() -> SkeletonGrid()
                state.status == LikesStatus.Offline -> Pane(
                    title = brandString(R.string.feed_offline_title),
                    body = brandString(R.string.feed_offline_body),
                    action = brandString(R.string.feed_retry),
                    onAction = actions::refresh,
                )
                state.status == LikesStatus.Failed -> Pane(
                    title = brandString(R.string.feed_error_title),
                    body = brandString(R.string.feed_error_body),
                    action = brandString(R.string.feed_retry),
                    onAction = actions::refresh,
                )
                state.items.isEmpty() -> Pane(
                    title = brandString(R.string.likes_empty_title),
                    body = brandString(R.string.likes_empty_body),
                    action = brandString(R.string.likes_empty_action),
                    onAction = actions::browse,
                )
                else -> PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = actions::refresh,
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LikesGrid(state, number, actions)
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }

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
        )
    }
    state.itemLike?.let { target ->
        ItemLikeSheet(target, state.itemLikeState, commentMax, { actions.sendItemLike(target, it) }, actions::dismissItemLike)
    }
    if (state.upsell) {
        UpsellSheet(
            title = brandString(R.string.likes_banner_title),
            body = brandString(R.string.likes_banner_body),
            planNames = planNames,
            onDismiss = actions::dismissUpsell,
            icon = R.drawable.ic_tab_likes,
            entry = app.core.feature.paywall.PaywallEntry.SEE_LIKES,
        )
    }
    state.quota?.let { (action, resetsAt) -> QuotaSheet(action, resetsAt, planNames, actions::dismissQuota) }
    state.match?.let { match ->
        MatchMomentDialog(
            their = match.card,
            myPhoto = match.myPhoto,
            onSendMessage = {
                actions.dismissMatch()
                actions.openChat(match.conversationId)
            },
            onDismiss = actions::dismissMatch,
        )
    }
}

@Composable
private fun LikesGrid(state: LikesUiState, number: (Int) -> String, actions: LikesActions) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 156.dp),
        contentPadding = PaddingValues(start = Space.md, end = Space.md, top = Space.sm, bottom = Space.xxl),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.md),
        modifier = Modifier.fillMaxSize(),
    ) {
        if (state.anyHidden) {
            item(key = "banner", span = { GridItemSpan(maxLineSpan) }) {
                Banner(onClick = { actions.open(state.items.first { it.liker == null }) })
            }
        }
        itemsIndexed(state.items, key = { index, item -> item.liker?.id ?: "hidden:$index" }) { _, item ->
            LikeTile(item, state.isDailyReveal(item), number, onClick = { actions.open(item) })
        }
        if (state.nextCursor != null || state.moreFailed) {
            item(key = "more", span = { GridItemSpan(maxLineSpan) }) {
                Box(Modifier.fillMaxWidth().padding(Space.lg), contentAlignment = Alignment.Center) {
                    if (state.moreFailed) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(brandString(R.string.likes_more_failed), style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = actions::loadMore) { Text(brandString(R.string.feed_retry)) }
                        }
                    } else {
                        CircularProgressIndicator(Modifier.size(28.dp))
                        LaunchedEffect(state.nextCursor) { actions.loadMore() }
                    }
                }
            }
        }
    }
}

@Composable
private fun Banner(onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Radius.lg),
        color = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(Space.lg), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Lock, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(Space.md))
            Column(Modifier.weight(1f)) {
                Text(brandString(R.string.likes_banner_title), style = MaterialTheme.typography.titleMedium)
                Text(brandString(R.string.likes_banner_body), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/**
 * One like: the person's photo, name and age, the badge, the part they liked
 * and their comment, or, when the plan does not include it, only a blur and
 * a lock.
 */
@Composable
private fun LikeTile(item: LikeItem, dailyReveal: Boolean, number: (Int) -> String, onClick: () -> Unit) {
    val card = item.liker
    val label = if (card != null) brandString(R.string.likes_open_profile, card.name) else brandString(R.string.likes_hidden_person)
    val describe = card?.let { nameAndAge(it, number) } ?: brandString(R.string.likes_hidden_person)
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(0.75f)
            .clip(RoundedCornerShape(Radius.lg))
            .clickable(onClickLabel = label, role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = describe },
    ) {
        if (card != null) {
            PhotoImage(card.photos.firstOrNull(), null, Modifier.fillMaxSize())
        } else {
            BlurHashImage(item.blurhash, Modifier.fillMaxSize())
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.18f)))
            Box(
                Modifier
                    .align(Alignment.Center)
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.35f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Lock, null, tint = Color.White, modifier = Modifier.size(22.dp))
            }
        }
        when {
            item.kind == LikeKind.Superlike -> PhotoPill(
                brandString(R.string.likes_superlike),
                vector = Icons.Filled.Star,
                accent = androidx.compose.ui.graphics.lerp(AppTheme.colors.superLike, Color.White, 0.35f),
                modifier = Modifier.align(Alignment.TopStart).padding(Space.sm),
            )
            dailyReveal -> PhotoPill(
                brandString(R.string.likes_daily_reveal),
                icon = R.drawable.ic_deck_sparkle,
                modifier = Modifier.align(Alignment.TopStart).padding(Space.sm),
            )
        }
        if (card != null) {
            Column(
                Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.8f))))
                    .padding(start = Space.md, end = Space.md, bottom = Space.md, top = Space.xxl),
                verticalArrangement = Arrangement.spacedBy(Space.xxs),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        nameAndAge(card, number),
                        style = MaterialTheme.typography.titleMedium,
                        color = Color.White,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (card.verified) {
                        Spacer(Modifier.width(Space.xs))
                        VerifiedBadge(18.dp)
                    }
                }
                item.item?.let {
                    Text(
                        brandString(if (it.kind == ItemKind.Prompt) R.string.likes_liked_prompt else R.string.likes_liked_photo),
                        style = MaterialTheme.typography.labelMedium,
                        color = Color.White.copy(alpha = 0.85f),
                    )
                }
                item.comment?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        brandString(R.string.likes_comment_quote, isolate(it)),
                        style = MaterialTheme.typography.bodySmall,
                        color = Color.White,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun SkeletonGrid() {
    val label = brandString(R.string.deck_loading)
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 156.dp),
        contentPadding = PaddingValues(Space.md),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.md),
        userScrollEnabled = false,
        modifier = Modifier.fillMaxSize().semantics { contentDescription = label },
    ) {
        items(6) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(0.75f)
                    .clip(RoundedCornerShape(Radius.lg))
                    .shimmer(),
            )
        }
    }
}

@Composable
private fun Pane(title: String, body: String, action: String, onAction: () -> Unit) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
        EmptyState(
            icon = R.drawable.ic_tab_likes,
            title = title,
            body = body,
            action = { Button(onClick = onAction, modifier = Modifier.heightIn(min = Space.minTouch)) { Text(action) } },
        )
    }
}
