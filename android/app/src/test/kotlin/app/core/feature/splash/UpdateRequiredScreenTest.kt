package app.core.feature.splash

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.brand.AppBrand
import app.core.common.Diag
import app.core.feature.auth.AuthGate
import app.core.feature.auth.deletionUrl
import app.core.model.AuthUser
import app.core.model.Config
import app.core.model.LegalLinks
import app.core.model.MinVersion
import app.core.net.ApiEvent
import app.core.net.ConfigRepository
import app.core.net.Fetched
import app.core.net.ServerApi
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import app.core.testing.unsupportedApi
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config as RobolectricConfig
import org.robolectric.shadows.ShadowLooper

/**
 * The update screen over the app, as the navigation host decides it
 * ([updateRequired]): «دوباره امتحان کن» reads the config again (a fake
 * server), leaves the screen when the fresh minimum is at or below the
 * build, and stays when it is still above; «به‌روزرسانی» goes to the store.
 */
@RunWith(AndroidJUnit4::class)
@RobolectricConfig(qualifiers = "w411dp-h891dp")
class UpdateRequiredScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Api : ServerApi by unsupportedApi() {
        val sent = MutableSharedFlow<ApiEvent>(extraBufferCapacity = 8)
        override val events: Flow<ApiEvent> = sent
        @Volatile var required = 0
        @Volatile var configReads = 0

        override suspend fun hasSession(): Boolean = false
        override suspend fun sessionUser(): AuthUser? = null
        override suspend fun config(locale: String): Fetched<Config> {
            configReads++
            return Fetched(Config(minVersion = MinVersion(required = required)), changed = true)
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val api = Api()
    private val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, scope, Diag.Silent)
    private val config = ConfigRepository(api, scope, Diag.Silent) { "en" }
    private var updates = 0

    @After fun tearDown() = scope.cancel()

    /** What the page asked the browser to open. */
    private val opened = mutableListOf<String>()
    private val uriHandler = object : UriHandler {
        override fun openUri(uri: String) {
            opened += uri
        }
    }

    /** The build is [build]; the server's 426 named [latched]; [deleteUrl] the deletion page, as the host passes it. */
    private fun show(build: Int, latched: Int, deleteUrl: String? = null) {
        gate.start()
        ShadowLooper.idleMainLooper()
        api.sent.tryEmit(ApiEvent.UpgradeRequired(latched))
        ShadowLooper.idleMainLooper()
        assertEquals("the 426 latched", latched, gate.upgrade.value)
        val recheck = UpgradeRecheck(config, gate, versionCode = build)
        compose.setContent {
            AppTheme(template = Templates.White) {
                val fresh by config.config.collectAsState()
                val upgrade by gate.upgrade.collectAsState()
                if (updateRequired(fresh, upgrade, versionCode = build)) {
                    CompositionLocalProvider(LocalUriHandler provides uriHandler) {
                        UpdateRequiredContent(recheck, onUpdate = { updates++ }, deleteUrl = deleteUrl)
                    }
                } else {
                    Text("In the app")
                }
            }
        }
        compose.waitForIdle()
    }

    private fun absent(text: String) = assertTrue("$text is shown", compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty())

    @Test
    fun aLoweredMinimumLeavesTheScreenOnTryAgain() {
        show(build = 110, latched = 120)
        compose.onNodeWithText("Update needed").assertIsDisplayed()
        compose.onNodeWithText("Update the app to keep using it.").assertIsDisplayed()
        // The screen was just decided: showing it asks nothing.
        assertEquals(0, api.configReads)
        api.required = 105
        compose.onNodeWithText("Try again").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("In the app").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(1, api.configReads)
        absent("Update needed")
    }

    @Test
    fun aMinimumStillAboveTheBuildKeepsTheScreen() {
        show(build = 110, latched = 120)
        api.required = 130
        compose.onNodeWithText("Try again").performClick()
        compose.waitUntil(5_000) { api.configReads == 1 }
        compose.waitForIdle()
        compose.onNodeWithText("Update needed").assertIsDisplayed()
        absent("In the app")
        // And «دوباره امتحان کن» is there for the next try.
        compose.onNodeWithText("Try again").assertIsDisplayed()
    }

    @Test
    fun deleteAccountOpensThePanelsDeletionPageAndNeedsNoUpdate() {
        val panel = "https://example.com/account/delete"
        show(build = 110, latched = 120, deleteUrl = deletionUrl(Config(legal = LegalLinks(deleteAccountUrl = panel))))
        compose.onNodeWithText("Delete account").assertIsDisplayed()
        compose.onNodeWithText("Delete account").performClick()
        assertEquals(listOf(panel), opened)
        assertEquals(0, updates)
        assertEquals(0, api.configReads)
    }

    @Test
    fun withoutAPanelLinkTheBrandsDeletionPageIsUsed() {
        val brand = AppBrand.Legal.deleteAccountUrl.takeIf { it.isNotBlank() }
        show(build = 110, latched = 120, deleteUrl = deletionUrl(Config(legal = LegalLinks(deleteAccountUrl = ""))))
        if (brand == null) {
            absent("Delete account")
        } else {
            compose.onNodeWithText("Delete account").performClick()
            assertEquals(listOf(brand), opened)
        }
    }

    @Test
    fun updateGoesToTheStore() {
        show(build = 110, latched = 120)
        compose.onNodeWithText("Update").performClick()
        assertEquals(1, updates)
        assertEquals(0, api.configReads)
    }
}
