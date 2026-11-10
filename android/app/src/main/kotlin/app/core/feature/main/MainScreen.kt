package app.core.feature.main

import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.rememberNumbers
import app.core.feature.chat.ConversationsRoute
import app.core.feature.deck.DeckRoute
import app.core.feature.likes.LikesRoute
import app.core.feature.likes.LikesTotal
import app.core.feature.match.LocalMatchMessages
import app.core.feature.match.MatchMessages
import app.core.feature.profile.ProfileTab
import app.core.i18n.brandString
import app.core.model.Id
import app.core.model.RealtimeEvent
import app.core.ui.components.AppTabBar
import app.core.ui.components.LocalBottomBarRoom
import app.core.ui.components.LocalTabBarSpace
import app.core.ui.components.tabTopInsets
import app.core.ui.components.TabBadge
import app.core.ui.components.TabItem
import app.core.ui.components.rememberGlassBackdrop
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.TabBarStyle
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** The four main tabs. The order is the bar's, start to end in the reading direction. */
enum class MainTab(@StringRes val label: Int, val icon: ImageVector, val selectedIcon: ImageVector) {
    DISCOVER(R.string.tab_discover, AppIcons.Discover, AppIcons.DiscoverSolid),
    LIKES(R.string.tab_likes, AppIcons.HeartLine, AppIcons.Heart),
    CHATS(R.string.tab_chats, AppIcons.Chat, AppIcons.ChatSolid),
    PROFILE(R.string.tab_profile, AppIcons.Profile, AppIcons.ProfileSolid),
}

/**
 * The signed-in app: the tab in front and the template's tab bar
 * ([AppTabBar]). Back from any tab but Discover goes to Discover first, then
 * leaves the app, as people expect of a bottom bar.
 *
 * A floating bar (neon) lies over the tab: the deck's photo runs under it
 * (the bar then blurs the photo), lists keep [app.core.ui.components.listBottomPadding]
 * free and the deck reads [LocalTabBarSpace]. A docked bar (white) takes
 * its own room under the tab. Every tab but the deck starts under the
 * status bar; the deck places its own header.
 *
 * Discover is the deck, Likes the likes list, Chats the conversations
 * (feature/deck, feature/likes, feature/chat). A thread and the message
 * requests open over the tabs ([onOpenChat], [onOpenRequests]); a match's
 * first message goes out through [LocalMatchMessages] and then opens its
 * thread. A notification that names a tab selects it ([tabRequests]).
 * Settings and the profile editor open over the tabs too ([onOpenSettings],
 * [onOpenEditProfile]).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@Composable
fun MainRoute(
    onOpenChat: (Id) -> Unit = {},
    onOpenRequests: () -> Unit = {},
    tabRequests: Flow<MainTab> = emptyFlow(),
    onOpenSettings: () -> Unit = {},
    onOpenEditProfile: () -> Unit = {},
) {
    var tab by rememberSaveable { mutableStateOf(MainTab.DISCOVER) }
    BackHandler(enabled = tab != MainTab.DISCOVER) { tab = MainTab.DISCOVER }
    LaunchedEffect(tabRequests) { tabRequests.collect { tab = it } }
    val chat: (Id?) -> Unit = { id -> if (id != null) onOpenChat(id) else tab = MainTab.CHATS }

    val t = AppTheme.template
    val graph = LocalAppGraph.current
    val floating = t.switches.tabBar == TabBarStyle.Floating
    val density = LocalDensity.current
    var barHeight by remember { mutableStateOf(0.dp) }
    var deckPhoto by remember { mutableStateOf(false) }
    val backdrop = rememberGlassBackdrop()

    // A plain dot on Chats while anything is unread (the count is said, not drawn).
    val unread by remember(graph) {
        graph.chat.sync.account.flatMapLatest { who ->
            if (who == null) flowOf(0) else graph.chat.conversations.observeList(who).map { list -> list.sumOf { it.unread } }
        }
    }.collectAsStateWithLifecycle(0)
    // The likes count on Likes: the total of the last likes page, or of a `like` event on the open socket.
    // Nothing is fetched for it (an app start reads nothing from the database).
    var likes by remember { mutableStateOf<LikesTotal?>(null) }
    LaunchedEffect(graph) {
        graph.realtime.events.filterIsInstance<RealtimeEvent.LikeReceived>().collect { likes = LikesTotal(it.like.total) }
    }
    val number = rememberNumbers()
    val tabs = MainTab.entries.map { item ->
        val badge = when {
            item == MainTab.CHATS && unread > 0 -> TabBadge.Dot(brandString(R.string.ui_unread, number(unread)))
            item == MainTab.LIKES -> likesBadge(likes, number)
            else -> null
        }
        TabItem(brandString(item.label), item.icon, item.selectedIcon, badge)
    }
    val messages = remember(graph) {
        MatchMessages { conversationId, text -> graph.appScope.launch { graph.chat.sync.send(conversationId, text) } }
    }

    // What floats over the tabs from outside (the store's prompts) keeps above the bar.
    val room = LocalBottomBarRoom.current
    LaunchedEffect(room, barHeight) { room.height = barHeight }
    DisposableEffect(room) { onDispose { room.height = 0.dp } }

    Box(Modifier.fillMaxSize().background(t.colors.bg)) {
        CompositionLocalProvider(
            LocalTabBarSpace provides if (floating) barHeight else 0.dp,
            LocalMatchMessages provides messages,
        ) {
            Box(if (floating) Modifier.fillMaxSize() else Modifier.fillMaxSize().padding(bottom = barHeight)) {
                when (tab) {
                    MainTab.DISCOVER -> DeckRoute(
                        onOpenChat = chat,
                        onOpenProfile = { tab = MainTab.PROFILE },
                        backdrop = backdrop,
                        onPhotoBehindBar = { deckPhoto = it },
                    )
                    MainTab.LIKES -> LikesRoute(
                        onOpenChat = chat,
                        onBrowse = { tab = MainTab.DISCOVER },
                        modifier = Modifier.tabTopInsets(),
                        onTotal = { likes = it },
                    )
                    MainTab.CHATS -> ConversationsRoute(
                        onOpen = onOpenChat,
                        onOpenRequests = onOpenRequests,
                        onBrowse = { tab = MainTab.DISCOVER },
                        modifier = Modifier.tabTopInsets(),
                    )
                    MainTab.PROFILE -> ProfileTab(onOpenSettings = onOpenSettings, onOpenEdit = onOpenEditProfile)
                }
            }
        }
        AppTabBar(
            tabs = tabs,
            selected = tab.ordinal,
            onSelect = { tab = MainTab.entries[it] },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .onSizeChanged { barHeight = with(density) { it.height.toDp() } },
            overPhoto = tab == MainTab.DISCOVER && deckPhoto,
            backdrop = backdrop,
        )
    }
}

/**
 * The Likes tab's count (`--badge-fill`): «۱۲», «۹۹+» past [LIKES_BADGE_MAX]
 * or when the server's count is capped, and nothing at 0 or while unknown.
 * TalkBack reads how many like the account.
 */
@Composable
fun likesBadge(total: LikesTotal?, number: (Int) -> String): TabBadge.Count? {
    val count = total?.count?.takeIf { it > 0 } ?: return null
    val plus = total.capped || count > LIKES_BADGE_MAX
    val shown = number(minOf(count, LIKES_BADGE_MAX)) + if (plus) "+" else ""
    val description = when {
        plus -> brandString(R.string.likes_count_plus, number(minOf(count, LIKES_BADGE_MAX)))
        count == 1 -> brandString(R.string.likes_count_one)
        else -> brandString(R.string.likes_count, number(count))
    }
    return TabBadge.Count(shown, description)
}

private const val LIKES_BADGE_MAX = 99
