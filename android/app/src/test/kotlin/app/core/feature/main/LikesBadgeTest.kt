package app.core.feature.main

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.card.rememberNumbers
import app.core.feature.likes.LikesTotal
import app.core.ui.components.AppTabBar
import app.core.ui.components.TabBadge
import app.core.ui.components.TabItem
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The Likes tab's count: the number, «+» past the cap or when the server caps it, nothing at 0; the tab's spoken label. */
@RunWith(AndroidJUnit4::class)
class LikesBadgeTest {

    @get:Rule val compose = createComposeRule()

    private fun badges(vararg totals: LikesTotal?): List<TabBadge.Count?> {
        val out = mutableListOf<TabBadge.Count?>()
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                val number = rememberNumbers()
                out.clear()
                totals.forEach { out += likesBadge(it, number) }
            }
        }
        compose.waitForIdle()
        return out
    }

    @Test
    fun theCountIsShownCappedAndHiddenAtZero() {
        val (twelve, many, capped, none, unknown) = badges(LikesTotal(12), LikesTotal(250), LikesTotal(40, capped = true), LikesTotal(0), null)
        assertEquals(TabBadge.Count("12", "12 people like you"), twelve)
        assertEquals(TabBadge.Count("99+", "99+ people like you"), many)
        assertEquals(TabBadge.Count("40+", "40+ people like you"), capped)
        assertNull(none)
        assertNull(unknown)
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianCountsInPersianDigits() {
        val (twelve) = badges(LikesTotal(12))
        assertEquals("۱۲", twelve?.text)
    }

    @Test
    fun theTabSaysItsLabelAndItsBadgeInTheScreensLanguage() {
        compose.setContent {
            AppTheme(template = Templates.White) {
                AppTabBar(
                    tabs = listOf(
                        TabItem("Discover", AppIcons.Discover),
                        TabItem("Likes", AppIcons.HeartLine, badge = TabBadge.Count("12", "12 people like you")),
                    ),
                    selected = 0,
                    onSelect = {},
                )
            }
        }
        compose.onNodeWithText("12").assertExists()
        compose.onNodeWithContentDescription("Likes, 12 people like you").assertExists()
    }
}
