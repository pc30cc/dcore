package app.core.feature.profile

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.model.City
import app.core.model.Entitlements
import app.core.model.Me
import app.core.model.OwnPhoto
import app.core.model.OwnProfile
import app.core.model.PhotoStatus
import app.core.model.Wallet
import app.core.ui.theme.AppTemplate
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Profile tab (m16): the account's own name line, the two buttons and
 * one group of rows; no row that leads nowhere (face verification has no
 * flow yet), no developer note, every row once; settings reachable when the
 * account cannot be read; and in both templates.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MyProfileTest {

    @get:Rule val compose = createComposeRule()

    private val calls = mutableListOf<String>()

    private fun me(verified: Boolean = false, completeness: Int = 70) = Me(
        id = "aaaaaaaaaaaaa",
        profile = OwnProfile(
            id = "aaaaaaaaaaaaa",
            name = "Arash",
            age = 25,
            verified = verified,
            job = "Industrial designer",
            city = City(112931, "Tehran"),
            photos = listOf(OwnPhoto("8101", 0, PhotoStatus.Approved, url = "https://media.example.com/p/8101/1/640.webp")),
            completeness = completeness,
        ),
    )

    private fun show(me: Me, entitlements: Entitlements? = Entitlements(wallet = Wallet(superlike = 1)), template: AppTemplate = Templates.Neon) {
        compose.setContent {
            AppTheme(template = template) {
                MyProfile(
                    me = me,
                    entitlements = entitlements,
                    planNames = mapOf("plus" to "Plus", "premium" to "Premium"),
                    actions = MyProfileActions(
                        onSettings = { calls += "settings" },
                        onEdit = { calls += "edit" },
                        onPreview = { calls += "preview" },
                        onPlan = { calls += "plan" },
                        onPacks = { calls += "packs" },
                    ),
                )
            }
        }
        compose.waitForIdle()
    }

    private fun count(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size

    @Test
    fun theTabShowsTheProfileAndOneGroupOfRows() {
        show(me())
        compose.onNodeWithText("Arash", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Tehran, Industrial designer").assertIsDisplayed()
        compose.onNodeWithText("Profile completion").assertIsDisplayed()
        compose.onNodeWithText("70%").assertIsDisplayed()
        compose.onNodeWithText("Free").assertIsDisplayed()
        // No row that only says it does not work yet.
        assertEquals(0, count("Verify your face"))
        compose.onNodeWithText("1 super like").assertIsDisplayed()
        // Every row once (the subscription is not a second section), and nothing about the server's API.
        assertEquals(1, count("Subscription"))
        assertEquals(0, count("API"))
        assertEquals(0, count("server"))
    }

    @Test
    fun aVerifiedAccountHasTheBadgeAndNoVerifyRow() {
        show(me(verified = true))
        assertEquals(0, count("Verify your face"))
        assertTrue(compose.onAllNodes(hasContentDescription("Verified")).fetchSemanticsNodes().isNotEmpty())
    }

    @Test
    fun thePlanIsNamedByTheCatalogue() {
        show(me(), Entitlements(plan = "premium", wallet = Wallet(superlike = 5)))
        compose.onNodeWithText("Premium").assertIsDisplayed()
        compose.onNodeWithText("5 super likes").assertIsDisplayed()
    }

    @Test
    fun theButtonsAndRowsDoWhatTheySay() {
        show(me())
        compose.onNodeWithText("Edit profile").performClick()
        compose.onNodeWithText("Preview").performClick()
        compose.onNodeWithText("Profile completion").performClick()
        compose.onNodeWithText("Subscription").performClick()
        compose.onNodeWithText("Super likes and boosts").performClick()
        compose.onNode(hasContentDescription("Settings")).performClick()
        assertEquals(listOf("edit", "preview", "edit", "plan", "packs", "settings"), calls)
    }

    @Test
    fun beforeTheEntitlementsAreReadThePlanSaysNothing() {
        show(me(), entitlements = null)
        // A paying account never sees «Free» on the way to its plan.
        assertEquals(0, count("Free"))
        assertEquals(0, count("super like"))
        compose.onNodeWithText("Subscription").assertIsDisplayed()
    }

    @Test
    fun whenTheAccountCannotBeReadSettingsIsStillThere() {
        compose.setContent {
            AppTheme(template = Templates.White) {
                MyProfileFailed("Something went wrong. Try again.", onRetry = { calls += "retry" }, onOpenSettings = { calls += "settings" })
            }
        }
        compose.onNodeWithText("Try again").performClick()
        compose.onNode(hasContentDescription("Settings")).performClick()
        assertEquals(listOf("retry", "settings"), calls)
    }

    @Test
    @Config(qualifiers = "w360dp-h800dp", fontScale = 1.5f)
    fun aLongValueGivesWayToTheTitleAndTheChevron() {
        val job = "Senior industrial and interaction designer for medical devices and public spaces".take(80)
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                app.core.ui.components.SettingsGroup {
                    app.core.ui.components.SettingsRow("Work", value = job, onClick = {})
                }
            }
        }
        compose.waitForIdle()
        val title = compose.onNodeWithText("Work", useUnmergedTree = true).fetchSemanticsNode()
        val layout = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        title.config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult].action?.invoke(layout)
        // The title is whole, on one line, and drawn as wide as its own text.
        assertEquals(1, layout.single().lineCount)
        assertTrue(title.boundsInRoot.width >= layout.single().size.width - 1f)
        // The value ends in an ellipsis rather than pushing the title out.
        val value = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        compose.onNodeWithText(job, useUnmergedTree = true).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult].action?.invoke(value)
        assertTrue(value.single().isLineEllipsized(0))
        // And it stops short of the chevron (20 dp, 12 dp after the value, inside the group's 16 dp).
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val density = compose.density.density
        val valueRight = compose.onNodeWithText(job, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.right
        assertTrue("value ends at $valueRight of ${root.right}", valueRight <= root.right - (16 + 20 + 12) * density + 1f)
    }

    @Test
    fun whiteHasTheTitleAndTheSettingsIconInTheHeader() {
        show(me(), template = Templates.White)
        compose.onNode(hasText("Profile")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Settings")).assertIsDisplayed()
    }

    @Test
    @Config(fontScale = 2f)
    fun withLargeTextTheButtonsStackRatherThanCutTheirLabels() {
        show(me())
        val edit = compose.onNodeWithText("Edit profile").fetchSemanticsNode().boundsInRoot
        val preview = compose.onNodeWithText("Preview").fetchSemanticsNode().boundsInRoot
        assertTrue("one under the other: $edit / $preview", preview.top >= edit.bottom)
        // Each takes the whole width then.
        assertEquals(edit.width, preview.width, 1f)
    }

    @Test
    @Config(qualifiers = "+fa", fontScale = 2f)
    fun withLargePersianTextTheButtonsStackToo() {
        show(me())
        val edit = compose.onNodeWithText("ویرایش پروفایل").fetchSemanticsNode().boundsInRoot
        val preview = compose.onNodeWithText("پیش‌نمایش").fetchSemanticsNode().boundsInRoot
        assertTrue("one under the other: $edit / $preview", preview.top >= edit.bottom)
    }

    @Test
    fun atTheDesignsSizeTheButtonsSitSideBySide() {
        show(me())
        val edit = compose.onNodeWithText("Edit profile").fetchSemanticsNode().boundsInRoot
        val preview = compose.onNodeWithText("Preview").fetchSemanticsNode().boundsInRoot
        assertEquals(edit.center.y, preview.center.y, 1f)
    }

    @Test
    @Config(qualifiers = "+fa")
    fun persianNumbersArePersian() {
        show(me())
        compose.onNodeWithText("۷۰٪").assertIsDisplayed()
        compose.onNodeWithText("۱ سوپرلایک").assertIsDisplayed()
        compose.onNodeWithText("Tehran، Industrial designer").assertIsDisplayed()
    }
}
