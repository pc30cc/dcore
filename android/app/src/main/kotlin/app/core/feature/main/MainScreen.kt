package app.core.feature.main

import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import app.core.R
import app.core.feature.chat.ConversationsRoute
import app.core.feature.deck.DeckRoute
import app.core.feature.likes.LikesRoute
import app.core.feature.settings.ProfileTab
import app.core.i18n.brandString
import app.core.model.Id

/** The four main tabs. The order is the bar's, start to end in the reading direction. */
enum class MainTab(@StringRes val label: Int, @DrawableRes val icon: Int) {
    DISCOVER(R.string.tab_discover, R.drawable.ic_tab_discover),
    LIKES(R.string.tab_likes, R.drawable.ic_tab_likes),
    CHATS(R.string.tab_chats, R.drawable.ic_tab_chats),
    PROFILE(R.string.tab_profile, R.drawable.ic_tab_profile),
}

/**
 * The signed-in app: a bottom bar and the tab in front. Back from any tab but
 * Discover goes to Discover first, then leaves the app, as people expect of
 * a bottom bar.
 *
 * Discover is the deck, Likes the likes list, Chats the conversations
 * (feature/deck, feature/likes, feature/chat). A thread and the message
 * requests open over the tabs ([onOpenChat], [onOpenRequests]); "send a
 * message" after a match opens its thread. A notification that names a tab
 * selects it ([tabRequests]).
 */
@Composable
fun MainRoute(
    onOpenChat: (Id) -> Unit = {},
    onOpenRequests: () -> Unit = {},
    tabRequests: kotlinx.coroutines.flow.Flow<MainTab> = kotlinx.coroutines.flow.emptyFlow(),
) {
    var tab by rememberSaveable { mutableStateOf(MainTab.DISCOVER) }
    BackHandler(enabled = tab != MainTab.DISCOVER) { tab = MainTab.DISCOVER }
    androidx.compose.runtime.LaunchedEffect(tabRequests) { tabRequests.collect { tab = it } }
    val chat: (Id?) -> Unit = { id -> if (id != null) onOpenChat(id) else tab = MainTab.CHATS }

    Scaffold(
        bottomBar = {
            NavigationBar {
                MainTab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = item == tab,
                        onClick = { tab = item },
                        icon = { Icon(painterResource(item.icon), contentDescription = null) },
                        label = { Text(brandString(item.label)) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
            when (tab) {
                MainTab.DISCOVER -> DeckRoute(
                    onOpenChat = chat,
                    onOpenProfile = { tab = MainTab.PROFILE },
                )
                MainTab.LIKES -> LikesRoute(
                    onOpenChat = chat,
                    onBrowse = { tab = MainTab.DISCOVER },
                )
                MainTab.CHATS -> ConversationsRoute(
                    onOpen = onOpenChat,
                    onOpenRequests = onOpenRequests,
                    onBrowse = { tab = MainTab.DISCOVER },
                )
                MainTab.PROFILE -> ProfileTab()
            }
        }
    }
}
