package app.core.feature.auth

import app.core.common.Diag
import app.core.feature.splash.UpgradeRecheck
import app.core.feature.splash.updateRequired
import app.core.model.AuthUser
import app.core.model.Config
import app.core.model.MinVersion
import app.core.net.ApiError
import app.core.net.ApiEvent
import app.core.net.ConfigRepository
import app.core.net.Fetched
import app.core.net.ServerApi
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import app.core.testing.unsupportedApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * A 426 latches the update screen; a fresh config whose minimum no longer
 * holds this build back lets it go (no restart), and the next 426 latches
 * it again. The config is read again on a tap, and on a resume at most
 * every 30 s.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AuthGateUpgradeTest {

    /** The funnel's events, and `GET /v1/config` with the minimum [required] (or lost while [offline]). */
    private class Api : ServerApi by unsupportedApi() {
        val sent = MutableSharedFlow<ApiEvent>(extraBufferCapacity = 8)
        override val events: Flow<ApiEvent> = sent
        var required = 0
        var offline = false
        var configReads = 0
            private set

        override suspend fun hasSession(): Boolean = false
        override suspend fun sessionUser(): AuthUser? = null
        override suspend fun config(locale: String): Fetched<Config> {
            configReads++
            if (offline) throw ApiError.Network(IOException("offline"))
            return Fetched(Config(minVersion = MinVersion(required = required)), changed = true)
        }
    }

    private class Setup(val api: Api, val gate: AuthGate, val config: ConfigRepository)

    private fun TestScope.setup(): Setup {
        val api = Api()
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, backgroundScope, Diag.Silent)
        gate.start()
        runCurrent()
        return Setup(api, gate, ConfigRepository(api, backgroundScope, Diag.Silent) { "en" })
    }

    @Test
    fun clearingTheLatchLetsGoAndTheNext426LatchesAgain() = runTest {
        val s = setup()
        s.api.sent.emit(ApiEvent.UpgradeRequired(12040))
        runCurrent()
        assertEquals(12040, s.gate.upgrade.value)
        s.gate.upgradeCleared()
        assertNull(s.gate.upgrade.value)
        // A 426 that names no minimum latches as "below, by how much unknown".
        s.api.sent.emit(ApiEvent.UpgradeRequired(null))
        runCurrent()
        assertEquals(0, s.gate.upgrade.value)
    }

    @Test
    fun theBuildIsBelowTheHigherOfTheConfigsMinimumAndThe426s() {
        val config = Config(minVersion = MinVersion(required = 100))
        assertTrue(updateRequired(config, upgrade = null, versionCode = 99))
        assertFalse(updateRequired(config, upgrade = null, versionCode = 100))
        assertTrue("a 426 above the config's", updateRequired(config, upgrade = 120, versionCode = 110))
        assertTrue("a 426 that named none", updateRequired(config, upgrade = 0, versionCode = 500))
        assertFalse("nothing known yet", updateRequired(null, upgrade = null, versionCode = 1))
    }

    @Test
    fun aLoweredMinimumLetsTheBuildBackInAndAHigherOneKeepsTheScreen() = runTest {
        val s = setup()
        s.api.sent.emit(ApiEvent.UpgradeRequired(120))
        runCurrent()
        val recheck = UpgradeRecheck(s.config, s.gate, now = { 0L }, versionCode = 110)

        s.api.required = 130
        assertFalse(recheck.check())
        assertEquals("still latched", 120, s.gate.upgrade.value)
        assertTrue(updateRequired(s.config.config.value, s.gate.upgrade.value, versionCode = 110))

        // Lowered by the admin: the fresh config and the cleared latch both let this build in.
        s.api.required = 105
        assertTrue(recheck.check())
        assertNull(s.gate.upgrade.value)
        assertEquals(105, s.config.config.value?.minVersion?.required)
        assertFalse(updateRequired(s.config.config.value, s.gate.upgrade.value, versionCode = 110))
    }

    @Test
    fun aConfigThatCannotBeReadKeepsTheScreen() = runTest {
        val s = setup()
        s.api.sent.emit(ApiEvent.UpgradeRequired(120))
        runCurrent()
        s.api.offline = true
        s.api.required = 1
        val recheck = UpgradeRecheck(s.config, s.gate, now = { 0L }, versionCode = 110)
        assertFalse(recheck.check())
        assertEquals(120, s.gate.upgrade.value)
    }

    @Test
    fun aResumeReadsAgainAtMostEveryThirtySeconds() = runTest {
        val s = setup()
        var now = 1_000L
        val recheck = UpgradeRecheck(s.config, s.gate, now = { now }, versionCode = 110)
        s.api.required = 130

        // The screen was just decided: the first resume asks nothing.
        assertFalse(recheck.resumed())
        assertEquals(0, s.api.configReads)
        now += UpgradeRecheck.RESUME_EVERY_MS - 1
        recheck.resumed()
        assertEquals(0, s.api.configReads)
        now += 1
        recheck.resumed()
        assertEquals(1, s.api.configReads)
        // A tap always reads, and counts as the last read.
        recheck.check()
        assertEquals(2, s.api.configReads)
        now += 10_000
        recheck.resumed()
        assertEquals(2, s.api.configReads)
        now += UpgradeRecheck.RESUME_EVERY_MS
        s.api.required = 100
        assertTrue(recheck.resumed())
        assertEquals(3, s.api.configReads)
    }
}
