package app.core.storage

import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.AccountStatus
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.model.TokenPair
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SessionStoreTest {

    private val clock = FakeClock(1_762_420_443_000L)
    private val secrets = MemorySecretStore()

    private fun store() = SessionStore(secrets, clock, Diag.Silent)

    private fun result(access: String = "at-1", refresh: String = "rt-1", expiresIn: Long = 900) = AuthResult(
        accessToken = access,
        accessExpiresAt = Instant.ofEpochMilli(clock.millis + expiresIn * 1000),
        refreshToken = refresh,
        refreshExpiresAt = Instant.ofEpochMilli(clock.millis + 90L * 86_400_000),
        user = AuthUser("aaaaaaaaaaaaa", AccountStatus.Active, 3),
    )

    @Test
    fun aSignInSurvivesARestartAsOneSealedValue() = runTest {
        store().signIn(result())
        assertEquals(setOf("session.tokens"), secrets.storedSecrets.keys)

        val reopened = store()
        assertTrue(reopened.hasSession())
        assertEquals("at-1", reopened.tokens()?.access)
        assertEquals("rt-1", reopened.tokens()?.refresh)
        assertEquals("aaaaaaaaaaaaa", reopened.accountId())
        assertEquals(3, reopened.account()?.onboardingStep)
    }

    @Test
    fun theDeadlineIsOnThisPhonesClockWhateverTheServersSays() = runTest {
        // The server's clock is two hours ahead of this phone's; its token lives 15 minutes.
        val serverNow = clock.millis + 2 * 3_600_000
        val pair = result().copy(accessExpiresAt = Instant.ofEpochMilli(serverNow + 900_000))
        val session = store()
        session.signIn(pair, receivedAtMillis = clock.millis, serverDateMillis = serverNow)
        assertEquals(clock.millis + 900_000, session.tokens()?.accessDeadlineMillis)
    }

    @Test
    fun aDeadlineIsNeverBeyondADayOrBeforeNow() = runTest {
        val session = store()
        session.signIn(result(expiresIn = 30L * 86_400), receivedAtMillis = clock.millis)
        assertEquals(clock.millis + 86_400_000, session.tokens()?.accessDeadlineMillis)
        session.signIn(result(expiresIn = -60), receivedAtMillis = clock.millis)
        assertEquals(clock.millis, session.tokens()?.accessDeadlineMillis)
    }

    @Test
    fun aRotationReplacesOnlyTheSessionItWasFor() = runTest {
        val session = store()
        session.signIn(result())
        val next = TokenPair("at-2", Instant.ofEpochMilli(clock.millis + 900_000), "rt-2")
        assertTrue(session.rotate("rt-1", next, clock.millis, null))
        assertEquals("rt-2", session.tokens()?.refresh)
        assertFalse("a stale refresh cannot rotate the new session", session.rotate("rt-1", next.copy(refreshToken = "rt-x"), clock.millis, null))
        assertEquals("rt-2", session.tokens()?.refresh)
    }

    @Test
    fun aRotationNeverBringsBackASignedOutSession() = runTest {
        val session = store()
        session.signIn(result())
        session.clear()
        assertFalse(session.rotate("rt-1", TokenPair("at-2", Instant.now(), "rt-2"), clock.millis, null))
        assertNull(session.tokens())
    }

    @Test
    fun clearingByRefreshTokenLeavesANewerSessionAlone() = runTest {
        val session = store()
        session.signIn(result(refresh = "rt-new"))
        assertFalse(session.clear(ifRefresh = "rt-old"))
        assertTrue(session.hasSession())
        assertTrue(session.clear(ifRefresh = "rt-new"))
        assertFalse(session.hasSession())
        assertNull(session.account())
        assertTrue(secrets.storedSecrets.isEmpty())
    }

    @Test
    fun anAnswerForAnotherAccountDoesNotRenameTheSession() = runTest {
        val session = store()
        session.signIn(result())
        session.updateAccount(AuthUser("bbbbbbbbbbbbb", AccountStatus.Banned, 0))
        assertEquals("aaaaaaaaaaaaa", session.accountId())
        session.updateAccount(AuthUser("aaaaaaaaaaaaa", AccountStatus.Snoozed, 9))
        assertEquals(AccountStatus.Snoozed, session.account()?.status)
    }

    @Test
    fun aStoredSessionThatNoLongerReadsIsSignedOut() = runTest {
        secrets.writeSecret("session.tokens", "{not json")
        assertFalse(store().hasSession())
    }

    @Test
    fun theInstallIdIsMadeOnceAndKept() = runTest {
        val preferences = Preferences(secrets)
        val first = preferences.installId()
        assertTrue(Regex("[0-9a-f-]{36}").matches(first))
        assertEquals(first, Preferences(secrets).installId())
    }
}
