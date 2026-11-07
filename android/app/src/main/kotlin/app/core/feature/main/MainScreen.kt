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
import app.core.feature.deck.DeckRoute
import app.core.feature.likes.LikesRoute
import app.core.feature.settings.ProfileTab
import app.core.i18n.brandString
import app.core.ui.components.EmptyState

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
 * Discover is the deck and Likes the likes list (feature/deck, feature/likes).
 * Chats is still an empty state: "send a message" after a match switches to
 * it, and opening that conversation is the chat's to do once it exists.
 */
@Composable
fun MainRoute() {
    var tab by rememberSaveable { mutableStateOf(MainTab.DISCOVER) }
    BackHandler(enabled = tab != MainTab.DISCOVER) { tab = MainTab.DISCOVER }

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
                    onOpenChat = { _ -> tab = MainTab.CHATS },
                    onOpenProfile = { tab = MainTab.PROFILE },
                )
                MainTab.LIKES -> LikesRoute(
                    onOpenChat = { _ -> tab = MainTab.CHATS },
                    onBrowse = { tab = MainTab.DISCOVER },
                )
                MainTab.CHATS -> EmptyState(
                    icon = R.drawable.ic_tab_chats,
                    title = brandString(R.string.chats_empty_title),
                    body = brandString(R.string.chats_empty_body),
                )
                MainTab.PROFILE -> ProfileTab()
            }
        }
    }
}
