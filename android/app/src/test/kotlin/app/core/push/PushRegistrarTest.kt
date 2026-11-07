package app.core.push

import app.core.common.Diag
import app.core.common.FakeClock
import app.core.net.ApiError
import app.core.storage.MemorySecretStore
import app.core.testing.ChatApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

/** The device registration: sent only when it changes (or weekly), never without someone signed in. */
class PushRegistrarTest {

    private class Transport(var availability: PushAvailability = PushAvailability.AVAILABLE, var token: String? = "tok-1") : PushTransport {
        var deleted = 0
        var fail = false
        override fun availability(): PushAvailability = availability
        override suspend fun token(): String? {
            if (fail) throw IOException("no service")
            return if (availability == PushAvailability.AVAILABLE) token else null
        }
        override suspend fun deleteToken() { deleted++ }
    }

    private val api = ChatApi()
    private val transport = Transport()
    private val clock = FakeClock()
    private var enabled = true
    private var locale = "fa"
    private var retries = 0
    private val registrar = PushRegistrar(
        api = api,
        transport = transport,
        state = StoredPushState(MemorySecretStore()),
        notificationsEnabled = { enabled },
        appVersion = "1.0.0",
        locale = { locale },
        clock = clock,
        diag = Diag.Silent,
        scheduleRetry = { retries++ },
    )

    @Test
    fun nobodySignedInRegistersNothing() = runTest {
        assertEquals(PushResult.SIGNED_OUT, registrar.sync("start"))
        assertEquals(0, api.devices.size)
    }

    @Test
    fun theSameRegistrationIsSentOnceAWeek() = runTest {
        assertEquals(PushResult.REGISTERED, registrar.bind("aaaaaaaaaaaaa", "signed in"))
        assertEquals("tok-1", api.devices.single().pushToken)
        assertEquals("fa", api.devices.single().locale)
        repeat(5) { assertEquals(PushResult.UNCHANGED, registrar.sync("foreground")) }
        assertEquals(1, api.devices.size)
        clock.advance(PushRegistrar.REFRESH_MS + 1)
        assertEquals(PushResult.REGISTERED, registrar.sync("foreground"))
        assertEquals(2, api.devices.size)
    }

    @Test
    fun aNewTokenAPermissionChangeOrALanguageIsSentAtOnce() = runTest {
        registrar.bind("aaaaaaaaaaaaa", "signed in")
        transport.token = "tok-2"
        assertEquals(PushResult.REGISTERED, registrar.onNewToken())
        enabled = false
        assertEquals(PushResult.REGISTERED, registrar.sync("foreground"))
        assertEquals(false, api.devices.last().notificationsEnabled)
        locale = "en"
        assertEquals(PushResult.REGISTERED, registrar.sync("language"))
        assertEquals(4, api.devices.size)
    }

    @Test
    fun aPhoneWithoutPlayServicesTellsTheServerItHasNoToken() = runTest {
        transport.availability = PushAvailability.NO_PLAY_SERVICES
        assertEquals(PushResult.REGISTERED, registrar.bind("aaaaaaaaaaaaa", "signed in"))
        assertNull(api.devices.single().pushToken)
        assertEquals(PushResult.UNCHANGED, registrar.sync("foreground"))
    }

    @Test
    fun aFailureIsRetriedByTheWorker() = runTest {
        transport.fail = true
        assertEquals(PushResult.RETRY_LATER, registrar.bind("aaaaaaaaaaaaa", "signed in"))
        assertEquals(1, retries)
        transport.fail = false
        val failing = object : app.core.net.ServerApi by api {
            override suspend fun updateDevice(update: app.core.model.DeviceUpdate) = throw ApiError.Network(IOException("offline"))
        }
        val second = PushRegistrar(failing, transport, StoredPushState(MemorySecretStore()), { true }, "1.0.0", { "fa" }, clock, Diag.Silent) { retries++ }
        second.bind("aaaaaaaaaaaaa", "signed in")
        assertEquals(2, retries)
    }

    @Test
    fun signOutClearsTheTokenOnTheServerThenHere() = runTest {
        registrar.bind("aaaaaaaaaaaaa", "signed in")
        registrar.beforeSignOut()
        assertNull("the server forgets the token while the session exists", api.devices.last().pushToken)
        registrar.afterSignOut()
        assertEquals(1, transport.deleted)
        assertEquals(PushResult.SIGNED_OUT, registrar.sync("foreground"))
    }

    @Test
    fun anotherAccountRegistersAgainEvenWithTheSameToken() = runTest {
        registrar.bind("aaaaaaaaaaaaa", "signed in")
        assertEquals(PushResult.REGISTERED, registrar.bind("bbbbbbbbbbbbb", "signed in"))
        assertEquals(2, api.devices.size)
    }
}
