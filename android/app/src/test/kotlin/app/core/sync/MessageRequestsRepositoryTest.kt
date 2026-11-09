package app.core.sync

import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.MessageRequest
import app.core.model.MessageRequestsPage
import app.core.model.PeerSummary
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.model.PublicUid
import app.core.model.RequestBox
import app.core.model.RequestStatus
import app.core.model.SentRequest
import app.core.model.Wire
import app.core.net.ApiError
import app.core.net.ServerApi
import app.core.testing.unsupportedApi
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Message requests as the server answers them: which statuses each box
 * shows, the refusals of a send (the day's cap, the quota, a spent client
 * id) and an accept heard over realtime.
 */
class MessageRequestsRepositoryTest {

    private val at = Instant.parse("2026-11-06T09:14:03.120Z")
    private fun peer(id: PublicUid) = PeerSummary(id, "N")
    private fun request(id: String, peer: PublicUid, status: RequestStatus) = MessageRequest(id, peer(peer), "hi", status, at)

    private class Api(private val pages: Map<RequestBox, MessageRequestsPage>) : ServerApi by unsupportedApi() {
        var sendError: ApiError? = null
        val clientIds = mutableListOf<String>()

        override suspend fun messageRequests(box: RequestBox, cursor: String?): MessageRequestsPage = pages.getValue(box)

        override suspend fun sendMessageRequest(to: PublicUid, body: String, clientId: String): SentRequest {
            clientIds += clientId
            sendError?.let { throw it }
            return SentRequest("1287390234923440099", PeerSummary(to, "N"), body, RequestStatus.Pending, Instant.parse("2026-11-06T09:14:03.120Z"))
        }
    }

    private fun repository(api: ServerApi): MessageRequestsRepository {
        var ids = 0
        return MessageRequestsRepository(api, FakeClock(), newClientId = { "c-${++ids}" }, diag = Diag.Silent)
    }

    /** The server's own example of a problem, from the shared fixtures. */
    private fun serverProblem(name: String): Problem {
        val file = generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
            .map { File(it, "server/packages/shared/fixtures/v1/$name.json") }
            .first { it.isFile }
        val text = file.readText()
        val status = Wire.json.parseToJsonElement(text).jsonObject.getValue("status").jsonPrimitive.int
        return Problem.parse(status, text)
    }

    @Test
    fun theSentBoxKeepsWhatWentUnansweredAndTheInboxOnlyWhatWaits() = runTest {
        val api = Api(
            mapOf(
                RequestBox.Inbox to MessageRequestsPage(
                    listOf(request("1", "aaaaaaaaaaaab", RequestStatus.Pending), request("2", "aaaaaaaaaaaac", RequestStatus.Expired)),
                    null,
                ),
                RequestBox.Sent to MessageRequestsPage(
                    listOf(
                        request("3", "aaaaaaaaaaaad", RequestStatus.Pending),
                        // A decline reads as pending to its sender, then as expired: both shown, neither as declined.
                        request("4", "aaaaaaaaaaaae", RequestStatus.Expired),
                        request("5", "aaaaaaaaaaaaf", RequestStatus.Accepted),
                        request("6", "aaaaaaaaaaaag", RequestStatus.Withdrawn),
                    ),
                    null,
                ),
            ),
        )
        val repo = repository(api)
        repo.refresh(RequestBox.Inbox)
        repo.refresh(RequestBox.Sent)
        assertEquals(listOf("1"), repo.inbox.value.items.map { it.id })
        assertEquals(listOf("3", "4"), repo.sent.value.items.map { it.id })
        assertEquals(RequestStatus.Expired, repo.sent.value.items.last().status)
    }

    @Test
    fun theStatusExpiredIsKnownOnTheWire() {
        val decoded = Wire.json.decodeFromString(
            MessageRequest.serializer(),
            """{"id":"1","peer":{"id":"aaaaaaaaaaaab","name":"N","photo":null,"verified":false},"body":"hi","status":"expired","at":"2026-11-06T09:14:03.120Z"}""",
        )
        assertEquals(RequestStatus.Expired, decoded.status)
    }

    @Test
    fun theDaysCapAndTheQuotaAreTwoDifferentAnswers() = runTest {
        val api = Api(emptyMap())
        val repo = repository(api)

        api.sendError = ApiError.Http(429, serverProblem("problem-quota"))
        assertEquals(RequestSendResult.OutOfQuota(Instant.parse("2026-11-07T00:00:00.000Z"), canBuy = true), repo.send("aaaaaaaaaaaab", "hi"))

        api.sendError = ApiError.Http(429, serverProblem("problem-rate-limited"))
        assertEquals(RequestSendResult.TooMany(42), repo.send("aaaaaaaaaaaab", "hi"))

        // A client id the server holds for a request to someone else: this attempt failed, the next one has a new id.
        api.sendError = ApiError.Http(409, Problem.of(409, ProblemCodes.CONFLICT))
        assertEquals(RequestSendResult.Failed(offline = false), repo.send("aaaaaaaaaaaab", "hi"))
        api.sendError = null
        assertTrue(repo.send("aaaaaaaaaaaab", "hi") is RequestSendResult.Sent)
        assertEquals(listOf("c-1", "c-2", "c-3", "c-4"), api.clientIds)

        api.sendError = ApiError.Http(409, Problem.of(409, ProblemCodes.ALREADY_REQUESTED))
        assertEquals(RequestSendResult.AlreadySent, repo.send("aaaaaaaaaaaab", "hi"))
    }

    @Test
    fun anAcceptHeardOverRealtimeEmptiesBothBoxesForThatPerson() = runTest {
        val api = Api(
            mapOf(
                RequestBox.Inbox to MessageRequestsPage(listOf(request("1", "aaaaaaaaaaaab", RequestStatus.Pending)), null),
                RequestBox.Sent to MessageRequestsPage(
                    listOf(request("2", "aaaaaaaaaaaab", RequestStatus.Pending), request("3", "aaaaaaaaaaaac", RequestStatus.Pending)),
                    null,
                ),
            ),
        )
        val repo = repository(api)
        repo.refresh(RequestBox.Inbox)
        repo.refresh(RequestBox.Sent)
        repo.onAccepted("aaaaaaaaaaaab")
        assertTrue(repo.inbox.value.items.isEmpty())
        assertEquals(listOf("3"), repo.sent.value.items.map { it.id })
    }
}
