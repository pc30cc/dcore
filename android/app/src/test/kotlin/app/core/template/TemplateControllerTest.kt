package app.core.template

import app.core.common.Diag
import app.core.model.Config
import app.core.model.Settings
import app.core.model.UiConfig
import app.core.net.ApiError
import app.core.model.Problem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * The choice applies at once, is sent, is retried while pending, and a
 * server value never overwrites a pending (or a newer) local choice.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TemplateControllerTest {

    /** A server: what it holds, what it was sent, and how the next sends end. */
    private class Server {
        var template: String = "default"
        val sent = mutableListOf<String>()
        var failWith: Exception? = null
        var gate: CompletableDeferred<Unit>? = null
        var signedIn = true

        suspend fun send(choice: String): Settings {
            sent += choice
            gate?.await()
            failWith?.let { throw it }
            template = choice
            return Settings(template = template)
        }
    }

    private class Harness(scope: CoroutineScope, initial: TemplateState) {
        val server = Server()
        val store = TemplateStore(TemplatePersistence.InMemory(initial))
        lateinit var controller: TemplateController

        init {
            controller = TemplateController(
                store = store,
                // As HttpServerApi.updateSettings: a token as the request leaves, the answer handed to the tap.
                send = { choice ->
                    val begun = controller.begin()
                    server.send(choice).also { controller.received(begun, it) }
                },
                signedIn = { server.signedIn },
                scope = scope,
                diag = Diag.Silent,
            )
        }

        /** What `GET /v1/me` brings back: a token taken as it leaves, the server's value as it lands. */
        fun meLeaves(): Long = controller.begin()

        fun meLands(begun: Long, template: String? = server.template) = controller.received(begun, Settings(template = template))
    }

    /**
     * [body] with a harness whose coroutines run on the test's scheduler as
     * foreground work (so `advanceUntilIdle` runs them), cancelled at the end.
     */
    private fun test(initial: TemplateState = TemplateState(), body: suspend TestScope.(Harness) -> Unit) = runTest {
        val job = Job()
        try {
            body(Harness(CoroutineScope(StandardTestDispatcher(testScheduler) + job), initial))
        } finally {
            job.cancel()
        }
    }

    private fun http(status: Int) = ApiError.Http(status, Problem(status, if (status == 400) "validation_failed" else null))

    @Test
    fun `a choice is drawn at once and sent`() = test { h ->
        h.controller.setChoice("white")
        assertEquals("white", h.controller.effective.value)
        assertTrue(h.store.state.value.pending)
        advanceUntilIdle()
        assertEquals(listOf("white"), h.server.sent)
        assertFalse(h.store.state.value.pending)
        assertEquals("white", h.server.template)
    }

    @Test
    fun `offline the choice stays pending and a server value does not overwrite it`() = test { h ->
        h.server.failWith = ApiError.Network(IOException("offline"))
        h.controller.setChoice("white")
        advanceUntilIdle()
        assertTrue(h.store.state.value.pending)
        assertEquals("white", h.controller.effective.value)
        // The next settings sync still says "default": kept, and sent again.
        h.server.failWith = null
        h.meLands(h.meLeaves(), "default")
        assertEquals("white", h.store.state.value.choice)
        advanceUntilIdle()
        assertEquals(listOf("white", "white"), h.server.sent)
        assertFalse(h.store.state.value.pending)
        assertEquals("white", h.server.template)
    }

    @Test
    fun `a pending choice is sent on the next start`() = test(TemplateState(choice = "white", pending = true)) { h ->
        h.controller.start(MutableStateFlow<Config?>(null))
        advanceUntilIdle()
        assertEquals(listOf("white"), h.server.sent)
        assertFalse(h.store.state.value.pending)
    }

    @Test
    fun `signed out nothing is sent, and signing out drops the pending choice but keeps it drawn`() = test { h ->
        h.server.signedIn = false
        h.controller.setChoice("white")
        advanceUntilIdle()
        assertTrue(h.server.sent.isEmpty())
        assertTrue(h.store.state.value.pending)
        h.controller.onSignedOut()
        assertFalse(h.store.state.value.pending)
        assertEquals("white", h.controller.effective.value)
        // The next account's own value is adopted.
        h.server.signedIn = true
        h.meLands(h.meLeaves(), "default")
        assertEquals("default", h.store.state.value.choice)
    }

    @Test
    fun `the server's value is adopted when nothing is pending`() = test { h ->
        h.meLands(h.meLeaves(), "white")
        assertEquals("white", h.store.state.value.choice)
        assertEquals("white", h.controller.effective.value)
        assertTrue(h.server.sent.isEmpty())
        // A template this build does not ship stays stored; the default is drawn.
        h.meLands(h.meLeaves(), "sepia")
        assertEquals("sepia", h.store.state.value.choice)
        assertEquals("neon", h.controller.effective.value)
    }

    @Test
    fun `a server older than templates changes nothing`() = test(TemplateState(choice = "white")) { h ->
        h.meLands(h.meLeaves(), null)
        assertEquals("white", h.store.state.value.choice)
        h.meLands(h.meLeaves(), "Not An Id")
        assertEquals("white", h.store.state.value.choice)
    }

    @Test
    fun `an answer that left before the choice was sent does not undo it`() = test { h ->
        val early = h.meLeaves()
        h.controller.setChoice("white")
        advanceUntilIdle()
        assertFalse(h.store.state.value.pending)
        // The earlier GET /v1/me lands now, with the value from before the PATCH.
        h.meLands(early, "default")
        assertEquals("white", h.store.state.value.choice)
        // A fresh one is adopted again.
        h.server.template = "neon"
        h.meLands(h.meLeaves(), "neon")
        assertEquals("neon", h.store.state.value.choice)
    }

    @Test
    fun `a newer choice made while one is on its way is sent after it and wins`() = test { h ->
        h.server.gate = CompletableDeferred()
        h.controller.setChoice("white")
        advanceUntilIdle()
        assertEquals(listOf("white"), h.server.sent)
        h.controller.setChoice("neon")
        assertEquals("neon", h.controller.effective.value)
        h.server.gate!!.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf("white", "neon"), h.server.sent)
        assertEquals("neon", h.store.state.value.choice)
        assertFalse(h.store.state.value.pending)
        assertEquals("neon", h.server.template)
    }

    @Test
    fun `a refusal of the value drops the pending flag and keeps the choice here`() = test { h ->
        h.server.failWith = http(400)
        h.controller.setChoice("white")
        advanceUntilIdle()
        assertFalse(h.store.state.value.pending)
        assertEquals("white", h.store.state.value.choice)
        assertEquals(listOf("white"), h.server.sent)
    }

    @Test
    fun `a passing failure keeps the choice pending`() {
        for (status in listOf(408, 429, 500, 503)) {
            test { h ->
                h.server.failWith = http(status)
                h.controller.setChoice("white")
                advanceUntilIdle()
                assertTrue("$status", h.store.state.value.pending)
            }
        }
    }

    @Test
    fun `config ui is kept and a person on default follows its default`() = test { h ->
        val configs = MutableStateFlow<Config?>(null)
        h.controller.start(configs)
        advanceUntilIdle()
        assertEquals("neon", h.controller.effective.value)
        configs.value = Config(v = 1, ui = UiConfig("white", listOf("neon", "white")))
        advanceUntilIdle()
        assertEquals("white", h.controller.effective.value)
        // A config without ui (an older server) keeps the last one.
        configs.value = Config(v = 2)
        advanceUntilIdle()
        assertEquals(UiConfig("white", listOf("neon", "white")), h.store.state.value.ui)
        // A person who chose neon keeps it while it is offered...
        h.controller.setChoice("neon")
        advanceUntilIdle()
        assertEquals("neon", h.controller.effective.value)
        // ...and gets the default when the admin stops offering it, the choice still stored.
        configs.value = Config(v = 3, ui = UiConfig("white", listOf("white")))
        advanceUntilIdle()
        assertEquals("white", h.controller.effective.value)
        assertEquals("neon", h.store.state.value.choice)
    }

    @Test
    fun `an answer that shows the newest pick while an older send is on its way does not stop it being sent`() =
        test(TemplateState(choice = "white")) { h ->
            h.server.template = "white"
            h.server.gate = CompletableDeferred()
            h.controller.setChoice("neon")
            advanceUntilIdle()
            assertEquals("the PATCH neon is on its way", listOf("neon"), h.server.sent)
            h.controller.setChoice("white")
            // A GET /v1/me reads the server while it still holds white, before the PATCH neon lands.
            h.meLands(h.meLeaves(), "white")
            assertTrue("still pending: the older send has not landed", h.store.state.value.pending)
            h.server.gate!!.complete(Unit)
            advanceUntilIdle()
            assertEquals(listOf("neon", "white"), h.server.sent)
            assertEquals("white", h.server.template)
            assertFalse(h.store.state.value.pending)
            // The next GET /v1/me keeps the person's last pick.
            h.meLands(h.meLeaves())
            assertEquals("white", h.store.state.value.choice)
            assertEquals("white", h.controller.effective.value)
        }

    @Test
    fun `a pending choice the server already holds is confirmed by one more send`() =
        test(TemplateState(choice = "white", pending = true)) { h ->
            h.server.template = "white"
            h.meLands(h.meLeaves(), "white")
            assertTrue(h.store.state.value.pending)
            advanceUntilIdle()
            assertEquals(listOf("white"), h.server.sent)
            assertFalse(h.store.state.value.pending)
            assertEquals("white", h.store.state.value.choice)
        }

    @Test
    fun `starting again (a new activity) adds no second config follower`() = test { h ->
        val configs = MutableStateFlow<Config?>(null)
        val fresh = MutableStateFlow<Config?>(null)
        h.controller.start(configs, fresh)
        h.controller.start(configs, fresh)
        h.controller.start(configs, fresh)
        advanceUntilIdle()
        assertEquals(1, configs.subscriptionCount.value)
        assertEquals(1, fresh.subscriptionCount.value)
    }

    @Test
    fun `a stored config older than the ui kept here is skipped, a fresh one always applies`() =
        test(TemplateState(ui = UiConfig("white", listOf("neon", "white")), uiVersion = 9)) { h ->
            val configs = MutableStateFlow<Config?>(null)
            val fresh = MutableStateFlow<Config?>(null)
            h.controller.start(configs, fresh)
            // Another language's stored copy, from before the admin made white the default.
            configs.value = Config(v = 5, ui = UiConfig("neon", listOf("neon", "white")))
            advanceUntilIdle()
            assertEquals("white", h.controller.effective.value)
            assertEquals(9L, h.store.state.value.uiVersion)
            // A newer copy applies.
            configs.value = Config(v = 10, ui = UiConfig("neon", listOf("neon", "white")))
            advanceUntilIdle()
            assertEquals("neon", h.controller.effective.value)
            // The server's own answer applies even with a lower version (its counter started over).
            val reset = Config(v = 2, ui = UiConfig("white", listOf("white")))
            fresh.value = reset
            configs.value = reset
            advanceUntilIdle()
            assertEquals("white", h.controller.effective.value)
            assertEquals(2L, h.store.state.value.uiVersion)
        }

    @Test
    fun `a choice this build does not ship is ignored`() = test { h ->
        h.controller.setChoice("sepia")
        advanceUntilIdle()
        assertEquals("default", h.store.state.value.choice)
        assertTrue(h.server.sent.isEmpty())
    }
}
