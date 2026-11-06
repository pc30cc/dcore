package app.core.net

import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.AccountStatus
import app.core.model.AppEvent
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.model.BazaarPurchaseRequest
import app.core.model.BoostKind
import app.core.model.CallKind
import app.core.model.ConversationPatch
import app.core.model.DeviceInfo
import app.core.model.DeviceUpdate
import app.core.model.Gender
import app.core.model.LocationSource
import app.core.model.LocationUpdate
import app.core.model.MessageKind
import app.core.model.NotificationPrefsPatch
import app.core.model.OtpStartRequest
import app.core.model.PhoneStartRequest
import app.core.model.PhotoMime
import app.core.model.PlayPurchaseRequest
import app.core.model.PreferencesPatch
import app.core.model.ProfilePatch
import app.core.model.PurchaseKind
import app.core.model.ReceiptsRequest
import app.core.model.ReportContext
import app.core.model.ReportReason
import app.core.model.ReportRequest
import app.core.model.RequestBox
import app.core.model.RestorePurchase
import app.core.model.SendMessageRequest
import app.core.model.SettingsPatch
import app.core.model.Swipe
import app.core.model.SwipeAction
import app.core.storage.MemorySecretStore
import app.core.storage.SessionStore
import app.core.testing.Fixtures
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.LocalDate

class HttpServerApiTest {

    private val clock = FakeClock()
    private val secrets = MemorySecretStore()
    private val session = SessionStore(secrets, clock, Diag.Silent)
    private val cache = MemoryResponseCache()
    private val requests = mutableListOf<HttpRequestData>()

    /** What the mock server answers next: status, body and extra headers. */
    private var answer: Triple<HttpStatusCode, String, Map<String, String>> = Triple(HttpStatusCode.OK, "{}", emptyMap())

    private val device = object : DeviceIdentity {
        override suspend fun installId() = "8b0e7f3c-0000-4000-8000-000000000001"
        override fun deviceKey() = "ab".repeat(32)
    }

    private val engine = MockEngine { request ->
        requests += request
        val (status, body, extra) = answer
        val headers = mapOf(HttpHeaders.ContentType to "application/json") + extra
        respond(body, status, headersOf(*headers.map { it.key to listOf(it.value) }.toTypedArray()))
    }

    private val client = ApiClient(
        baseUrl = "https://api.test",
        tokens = session,
        cache = cache,
        engine = engine,
        clientHeader = "play/12030",
        language = { "en" },
        diag = Diag.Silent,
        clock = clock,
        retry = RetryPolicy.NONE,
        pause = {},
    )

    private val api = HttpServerApi(client, session, device, store = "play", clock = clock)

    private suspend fun signIn(id: String = "aaaaaaaaaaaaa") {
        session.signIn(
            AuthResult("at-1", clock.now().plusSeconds(900), "rt-1", null, AuthUser(id, AccountStatus.Active, 0)),
            receivedAtMillis = clock.nowMillis(),
        )
    }

    private fun HttpRequestData.bodyText(): String? = (body as? TextContent)?.text

    private class Case(
        val method: String,
        val verb: HttpMethod,
        val path: String,
        val fixture: String?,
        val status: HttpStatusCode = HttpStatusCode.OK,
        val authenticated: Boolean = true,
        val query: Map<String, String> = emptyMap(),
        val call: suspend ServerApi.() -> Unit,
    )

    private val conv = "1287390234923400001"
    private val callId = "1287390234923499001"
    private val photo = "1287390234923410099"
    private val uid = "bnegar2kq7xm4"

    private val cases = listOf(
        Case("config", HttpMethod.Get, "/v1/config", "config", authenticated = false, query = mapOf("store" to "play", "locale" to "fa")) { config("fa") },
        Case("startOtp", HttpMethod.Post, "/v1/auth/otp/start", "otp-start", authenticated = false) { startOtp(OtpStartRequest("+989121234567", "fa")) },
        Case("googleNonce", HttpMethod.Post, "/v1/auth/google/nonce", "google-nonce", authenticated = false) { googleNonce() },
        Case("startPhoneChange", HttpMethod.Post, "/v1/me/phone/start", "otp-start") { startPhoneChange(PhoneStartRequest("+905321234567", "tr")) },
        Case("verifyPhoneChange", HttpMethod.Post, "/v1/me/phone/verify", null, HttpStatusCode.NoContent) { verifyPhoneChange("ch_1", "123456") },
        Case("me", HttpMethod.Get, "/v1/me", "me") { me() },
        Case("setBasics", HttpMethod.Put, "/v1/me/basics", "own-profile") { setBasics(LocalDate.of(1995, 4, 2), Gender.Woman) },
        Case("updateProfile", HttpMethod.Patch, "/v1/me/profile", "own-profile") { updateProfile(ProfilePatch(about = "Hi")) },
        Case("updatePreferences", HttpMethod.Patch, "/v1/me/preferences", "preferences") { updatePreferences(PreferencesPatch(ageMax = 40)) },
        Case("updateSettings", HttpMethod.Patch, "/v1/me/settings", "settings") { updateSettings(SettingsPatch(hideAge = true)) },
        Case("updateNotifications", HttpMethod.Patch, "/v1/me/notifications", "notifications") { updateNotifications(NotificationPrefsPatch(previews = false)) },
        Case("updateLocation", HttpMethod.Put, "/v1/me/location", "location") { updateLocation(LocationUpdate(35.7, 51.4, LocationSource.Gps)) },
        Case("cities", HttpMethod.Get, "/v1/cities", "cities", query = mapOf("q" to "teh", "country" to "IR")) { cities("teh", "IR") },
        Case("startPhotoUpload", HttpMethod.Post, "/v1/me/photos", "photo-upload", HttpStatusCode.Created) { startPhotoUpload(3, PhotoMime.Jpeg, 2_000_000) },
        Case("completePhotoUpload", HttpMethod.Post, "/v1/me/photos/$photo/complete", "photo-complete", HttpStatusCode.Accepted) { completePhotoUpload(photo) },
        Case("reorderPhotos", HttpMethod.Put, "/v1/me/photos/order", "own-profile") { reorderPhotos(listOf(photo)) },
        Case("deletePhoto", HttpMethod.Delete, "/v1/me/photos/$photo", null, HttpStatusCode.NoContent) { deletePhoto(photo) },
        Case("profile", HttpMethod.Get, "/v1/profiles/$uid", "profile-card") { profile(uid) },
        Case("startVerification", HttpMethod.Post, "/v1/verification/sessions", "verification-session") { startVerification() },
        Case("submitVerification", HttpMethod.Post, "/v1/verification/1287390234923466001/submit", "verification-state") { submitVerification("1287390234923466001") },
        Case("verificationStatus", HttpMethod.Get, "/v1/verification/status", "verification-state") { verificationStatus() },
        Case("updateDevice", HttpMethod.Put, "/v1/devices/current", null, HttpStatusCode.NoContent) { updateDevice(DeviceUpdate("fcm-token", true, "1.0.0", "en")) },
        Case("deck", HttpMethod.Get, "/v1/deck", "deck", query = mapOf("limit" to "10")) { deck(10) },
        Case("swipe", HttpMethod.Post, "/v1/swipes", "swipes") { swipe(listOf(Swipe(uid, SwipeAction.Like))) },
        Case("likes", HttpMethod.Get, "/v1/likes", "likes", query = mapOf("limit" to "20")) { likes() },
        Case("conversations", HttpMethod.Get, "/v1/conversations", "conversations", query = mapOf("limit" to "50")) { conversations() },
        Case("messagesBefore", HttpMethod.Get, "/v1/conversations/$conv/messages", "messages", query = mapOf("before" to "1287390234923417605", "limit" to "50")) {
            messagesBefore(conv, "1287390234923417605")
        },
        Case("messagesAfter", HttpMethod.Get, "/v1/conversations/$conv/messages", "messages", query = mapOf("after" to "1287390234923417600", "limit" to "200")) {
            messagesAfter(conv, "1287390234923417600")
        },
        Case("sendMessage", HttpMethod.Post, "/v1/conversations/$conv/messages", "message-sent", HttpStatusCode.Created) {
            sendMessage(conv, SendMessageRequest("7d1c5b8e-3f2a-4c55-9a51-6e2f9d3c1b21", MessageKind.Text, "Hi"))
        },
        Case("sendReceipts", HttpMethod.Post, "/v1/conversations/$conv/receipts", null, HttpStatusCode.NoContent) { sendReceipts(conv, ReceiptsRequest(readUpTo = "1")) },
        Case("sendTyping", HttpMethod.Post, "/v1/conversations/$conv/typing", null, HttpStatusCode.NoContent) { sendTyping(conv) },
        Case("updateConversation", HttpMethod.Patch, "/v1/conversations/$conv", "conversation") { updateConversation(conv, ConversationPatch(muted = true)) },
        Case("unmatch", HttpMethod.Delete, "/v1/conversations/$conv", null, HttpStatusCode.NoContent) { unmatch(conv) },
        Case("sendMessageRequest", HttpMethod.Post, "/v1/message-requests", "request-sent", HttpStatusCode.Created) { sendMessageRequest(uid, "Hello", "c-1") },
        Case("messageRequests", HttpMethod.Get, "/v1/message-requests", "requests", query = mapOf("box" to "sent")) { messageRequests(RequestBox.Sent) },
        Case("acceptMessageRequest", HttpMethod.Post, "/v1/message-requests/1287390234923433002/accept", "conversation-body", HttpStatusCode.Created) {
            acceptMessageRequest("1287390234923433002")
        },
        Case("declineMessageRequest", HttpMethod.Post, "/v1/message-requests/1287390234923433002/decline", null, HttpStatusCode.NoContent) {
            declineMessageRequest("1287390234923433002")
        },
        Case("withdrawMessageRequest", HttpMethod.Delete, "/v1/message-requests/1287390234923433001", null, HttpStatusCode.NoContent) {
            withdrawMessageRequest("1287390234923433001")
        },
        Case("placeCall", HttpMethod.Post, "/v1/calls", "call", HttpStatusCode.Created) { placeCall(conv, CallKind.Video) },
        Case("call", HttpMethod.Get, "/v1/calls/$callId", "call") { call(callId) },
        Case("callRang", HttpMethod.Post, "/v1/calls/$callId/rang", null, HttpStatusCode.NoContent) { callRang(callId) },
        Case("acceptCall", HttpMethod.Post, "/v1/calls/$callId/accept", "call-accept") { acceptCall(callId) },
        Case("declineCall", HttpMethod.Post, "/v1/calls/$callId/decline", "call-ended") { declineCall(callId) },
        Case("cancelCall", HttpMethod.Post, "/v1/calls/$callId/cancel", "call-ended") { cancelCall(callId) },
        Case("endCall", HttpMethod.Post, "/v1/calls/$callId/end", "call-ended") { endCall(callId) },
        Case("callToken", HttpMethod.Post, "/v1/calls/$callId/token", "call-token") { callToken(callId) },
        Case("report", HttpMethod.Post, "/v1/reports", "report", HttpStatusCode.Accepted) {
            report(ReportRequest(uid, ReportContext.Profile, ReportReason.Fake))
        },
        Case("block", HttpMethod.Post, "/v1/blocks", null, HttpStatusCode.NoContent) { block(uid) },
        Case("blocks", HttpMethod.Get, "/v1/blocks", "blocks") { blocks() },
        Case("unblock", HttpMethod.Delete, "/v1/blocks/$uid", null, HttpStatusCode.NoContent) { unblock(uid) },
        Case("moderation", HttpMethod.Get, "/v1/me/moderation", "moderation") { moderation() },
        Case("appeal", HttpMethod.Post, "/v1/appeals", "appeal", HttpStatusCode.Created) { appeal("1287390234923455001", "This was a mistake.") },
        Case("products", HttpMethod.Get, "/v1/store/products", "products-play") { products() },
        Case("verifyPlayPurchase", HttpMethod.Post, "/v1/store/play/purchases", "purchase") {
            verifyPlayPurchase(PlayPurchaseRequest("sub.plus", "tok-1", PurchaseKind.Subscription))
        },
        Case("verifyBazaarPurchase", HttpMethod.Post, "/v1/store/bazaar/purchases", "purchase-pending", HttpStatusCode.Accepted) {
            verifyBazaarPurchase(BazaarPurchaseRequest("sub.plus.1m", "tok-2", "{}", "sig", PurchaseKind.Subscription))
        },
        Case("restorePurchases", HttpMethod.Post, "/v1/store/restore", "restore") { restorePurchases(listOf(RestorePurchase("sub.plus", "tok-1", PurchaseKind.Subscription))) },
        Case("entitlements", HttpMethod.Get, "/v1/me/entitlements", "entitlements") { entitlements() },
        Case("boost", HttpMethod.Post, "/v1/boosts", "boost", HttpStatusCode.Created) { boost(BoostKind.Boost) },
        Case("realtimeToken", HttpMethod.Post, "/v1/realtime/token", "realtime-token") { realtimeToken() },
        Case("deletionPreflight", HttpMethod.Get, "/v1/me/deletion/preflight", "deletion-preflight") { deletionPreflight() },
        Case("deleteAccount", HttpMethod.Post, "/v1/me/deletion", "deletion", HttpStatusCode.Accepted) { deleteAccount("break") },
        Case("restoreAccount", HttpMethod.Post, "/v1/me/restore", "restore-account") { restoreAccount() },
        Case("publicDeletionStart", HttpMethod.Post, "/v1/public/account-deletion/start", "public-deletion-start", HttpStatusCode.Accepted, authenticated = false) {
            publicDeletionStart("+989121234567", "fa")
        },
        Case("publicDeletionConfirm", HttpMethod.Post, "/v1/public/account-deletion/confirm", "deletion", HttpStatusCode.Accepted, authenticated = false) {
            publicDeletionConfirm("dr_9c1f", "123456")
        },
        Case("publicDeletionGoogle", HttpMethod.Post, "/v1/public/account-deletion/google", "deletion", HttpStatusCode.Accepted, authenticated = false) {
            publicDeletionGoogle("id-token")
        },
        Case("supportTickets", HttpMethod.Get, "/v1/support/tickets", "support-tickets") { supportTickets() },
        Case("openSupportTicket", HttpMethod.Post, "/v1/support/tickets", "support-ticket", HttpStatusCode.Created) { openSupportTicket("safety", "Help") },
        Case("supportMessages", HttpMethod.Get, "/v1/support/tickets/1287390234923488001/messages", "support-messages") { supportMessages("1287390234923488001") },
        Case("sendSupportMessage", HttpMethod.Post, "/v1/support/tickets/1287390234923488001/messages", "support-message", HttpStatusCode.Created) {
            sendSupportMessage("1287390234923488001", "Thanks")
        },
        Case("requestExport", HttpMethod.Post, "/v1/me/export", "export", HttpStatusCode.Accepted) { requestExport() },
        Case("sendEvents", HttpMethod.Post, "/v1/events", null, HttpStatusCode.NoContent) {
            sendEvents(listOf(AppEvent("app_open", Instant.parse("2026-11-06T09:14:03.120Z"))))
        },
    )

    /** Sign-in and sign-out change the session, so they have tests of their own below. */
    private val testedApart = setOf("verifyOtp", "signInWithGoogle", "logout")

    /** Members that are not routes. */
    private val notRoutes = setOf("getEvents", "hasSession", "sessionUser", "discardSession", "cachedConfig")

    @Test
    fun everyRouteOfTheInterfaceHasACase() {
        // Default arguments compile to static `name$default` helpers: not routes.
        val methods = ServerApi::class.java.methods
            .filterNot { java.lang.reflect.Modifier.isStatic(it.modifiers) || '$' in it.name }
            .map { it.name }.toSet() - notRoutes
        val covered = cases.map { it.method }.toSet() + testedApart
        assertEquals("ServerApi methods without a route case", emptySet<String>(), methods - covered)
        assertEquals("cases for methods ServerApi does not have", emptySet<String>(), covered - methods)
    }

    @Test
    fun everyRouteSendsItsMethodAndPathAndDecodesItsAnswer() = runTest {
        signIn()
        for (case in cases) {
            requests.clear()
            answer = Triple(case.status, case.fixture?.let(Fixtures::text) ?: "", emptyMap())
            try {
                case.call(api)
            } catch (e: Exception) {
                fail("${case.method}: ${e.javaClass.simpleName}: ${e.message}")
            }
            val request = requests.singleOrNull() ?: fail("${case.method}: expected one request, saw ${requests.size}")
            request as HttpRequestData
            assertEquals("${case.method}: method", case.verb, request.method)
            assertEquals("${case.method}: path", case.path, request.url.encodedPath)
            for ((name, value) in case.query) {
                assertEquals("${case.method}: query $name", value, request.url.parameters[name])
            }
            assertEquals("${case.method}: X-Client", "play/12030", request.headers[ApiClient.CLIENT_HEADER])
            if (case.authenticated) {
                assertEquals("${case.method}: bearer", "Bearer at-1", request.headers[HttpHeaders.Authorization])
            } else {
                assertNull("${case.method}: a public route sent the session", request.headers[HttpHeaders.Authorization])
            }
        }
    }

    @Test
    fun signingInKeepsTheSessionAndNamesTheDevice() = runTest {
        cache.write("u:someone-else:me", CachedResponse(null, "{}", 0))
        answer = Triple(HttpStatusCode.OK, Fixtures.text("auth-result"), mapOf(HttpHeaders.Date to "Fri, 06 Nov 2026 09:14:03 GMT"))
        val result = api.verifyOtp("ch_8f2a", "123456", DeviceInfo("Pixel 8", "16", "1.0.0", "fa"))

        assertTrue(result.isNew)
        val body = requests.single().bodyText()!!
        assertTrue(body.contains("\"installId\":\"8b0e7f3c-0000-4000-8000-000000000001\""))
        assertTrue(body.contains("\"deviceKey\":\"${"ab".repeat(32)}\""))
        assertTrue(api.hasSession())
        assertEquals(AuthUser("aaaaaaaaaaaaa", AccountStatus.Onboarding, 2), api.sessionUser())
        assertEquals("rt1.1287390234923401.Zm9v", session.tokens()?.refresh)
        assertNull("nothing stored for an earlier account survives a sign-in", cache.read("u:someone-else:me"))
    }

    @Test
    fun googleSignInSendsTheTokenAndTheNonce() = runTest {
        answer = Triple(HttpStatusCode.OK, Fixtures.text("auth-result"), emptyMap())
        api.signInWithGoogle("google-id-token", "gn_1", DeviceInfo("Pixel 8", "16", "1.0.0", "en"))
        val request = requests.single()
        assertEquals("/v1/auth/google", request.url.encodedPath)
        assertNull(request.headers[HttpHeaders.Authorization])
        assertTrue(request.bodyText()!!.contains("\"nonceId\":\"gn_1\""))
        assertTrue(api.hasSession())
    }

    @Test
    fun personalAnswersAreKeptPerAccount() = runTest {
        signIn("aaaaaaaaaaaaa")
        answer = Triple(HttpStatusCode.OK, Fixtures.text("me"), mapOf(HttpHeaders.ETag to "\"m1\""))
        api.me()
        assertNotNull(cache.read("u:aaaaaaaaaaaaa:me"))

        api.discardSession()
        signIn("bbbbbbbbbbbbb")
        requests.clear()
        api.me()
        assertNull("another account never revalidates the first one's copy", requests.single().headers[HttpHeaders.IfNoneMatch])
    }

    @Test
    fun theWriteLagComesFromItsHeader() = runTest {
        signIn()
        answer = Triple(HttpStatusCode.OK, Fixtures.text("messages"), mapOf(ApiClient.WRITE_LAG_HEADER to "2500"))
        val page = api.messagesAfter(conv, "1287390234923417600")
        assertEquals(2_500L, page.writeLagMs)
        assertTrue(page.lagging)
    }

    @Test
    fun aResentMessageIsReportedAsAReplay() = runTest {
        signIn()
        val send = SendMessageRequest("7d1c5b8e-3f2a-4c55-9a51-6e2f9d3c1b21", MessageKind.Text, "Hi")
        answer = Triple(HttpStatusCode.Created, Fixtures.text("message-sent"), emptyMap())
        assertFalse(api.sendMessage(conv, send).replayed)
        answer = Triple(HttpStatusCode.OK, Fixtures.text("message-sent"), emptyMap())
        assertTrue(api.sendMessage(conv, send).replayed)
    }

    @Test
    fun logoutForgetsTheSessionEvenWhenTheServerAlreadyHas() = runTest {
        signIn()
        answer = Triple(HttpStatusCode.Unauthorized, """{"code":"unauthorized"}""", emptyMap())
        // The 401 is answered by a refresh attempt first; that is refused too.
        api.logout()
        assertFalse(api.hasSession())
        assertTrue(secrets.storedSecrets.isEmpty())
    }

    @Test
    fun logoutWithoutANetworkKeepsTheSessionToTryAgain() = runTest {
        signIn()
        val offline = ApiClient(
            "https://api.test", session, cache, MockEngine { throw IOException("offline") }, "play/1", { "en" },
            Diag.Silent, clock = clock, retry = RetryPolicy.NONE, pause = {},
        )
        val api = HttpServerApi(offline, session, device, "play", clock)
        try {
            api.logout()
            fail("expected Network")
        } catch (expected: ApiError.Network) {
        }
        assertTrue(api.hasSession())
    }

    @Test
    fun oversizedBatchesAreRefusedBeforeAnyRequest() = runTest {
        signIn()
        try {
            api.swipe(List(21) { Swipe(uid, SwipeAction.Pass) })
            fail("expected a refusal")
        } catch (expected: IllegalArgumentException) {
        }
        api.sendEvents(emptyList())
        assertTrue(requests.isEmpty())
    }
}
