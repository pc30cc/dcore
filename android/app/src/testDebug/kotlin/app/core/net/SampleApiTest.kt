package app.core.net

import app.core.common.FakeClock
import app.core.model.AccountStatus
import app.core.model.BazaarPurchaseRequest
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.CallState
import app.core.model.ConversationsPage
import app.core.model.DeckPage
import app.core.model.DeviceInfo
import app.core.model.Entitlements
import app.core.model.LikesPage
import app.core.model.LocationSource
import app.core.model.LocationUpdate
import app.core.model.Me
import app.core.model.MessageKind
import app.core.model.MessagesPage
import app.core.model.OtpStartRequest
import app.core.model.PhotoMime
import app.core.model.PhotoStatus
import app.core.model.Plan
import app.core.model.PlayPurchaseRequest
import app.core.model.PreferencesPatch
import app.core.model.ProblemCodes
import app.core.model.PurchaseKind
import app.core.model.ReportContext
import app.core.model.ReportReason
import app.core.model.ReportRequest
import app.core.model.RequestBox
import app.core.model.SendMessageRequest
import app.core.model.SettingsPatch
import app.core.model.StoreProducts
import app.core.model.Swipe
import app.core.model.SwipeAction
import app.core.model.SwipeOutcome
import app.core.model.Wire
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.UUID

/**
 * The sample backend behaves like the server where a screen can tell: the
 * same codes, quotas, idempotency and state moves, and answers that are valid
 * on the wire.
 */
class SampleApiTest {

    private val clock = FakeClock()
    private val device = DeviceInfo("Pixel 8", "16", "1.0.0", "fa")

    private suspend fun expectProblem(status: Int, code: String, block: suspend () -> Unit): ApiError.Http {
        try {
            block()
        } catch (e: ApiError.Http) {
            assertEquals("status of $code", status, e.status)
            assertEquals(code, e.code)
            return e
        }
        fail("expected $status $code")
        error("unreachable")
    }

    /** What the sample says must also be what the wire can carry. */
    private fun <T> roundTrips(value: T, serializer: KSerializer<T>) {
        val text = Wire.json.encodeToString(serializer, value)
        assertEquals(value, Wire.json.decodeFromString(serializer, text))
    }

    @Test
    fun signingInByPhoneFollowsTheCodeRules() = runTest {
        val api = SampleApi(clock = clock, signedIn = false)
        assertFalse(api.hasSession())
        expectProblem(400, ProblemCodes.PHONE_INVALID) { api.startOtp(OtpStartRequest("0912", "fa")) }

        val challenge = api.startOtp(OtpStartRequest("+989121112233", "fa"))
        assertEquals(6, challenge.codeLength)
        expectProblem(429, ProblemCodes.RATE_LIMITED) { api.startOtp(OtpStartRequest("+989121112233", "fa")) }

        val wrong = expectProblem(400, ProblemCodes.OTP_INVALID) { api.verifyOtp(challenge.challengeId, "000000", device) }
        assertEquals(4, wrong.problem.attemptsLeft)

        val result = api.verifyOtp(challenge.challengeId, "123456", device)
        assertTrue(result.isNew)
        assertEquals(AccountStatus.Onboarding, result.user.status)
        assertTrue(api.hasSession())
        expectProblem(403, ProblemCodes.ONBOARDING_INCOMPLETE) { api.deck() }
        expectProblem(410, ProblemCodes.OTP_EXPIRED) { api.verifyOtp(challenge.challengeId, "123456", device) }
    }

    @Test
    fun fiveWrongCodesKillTheChallenge() = runTest {
        val api = SampleApi(clock = clock, signedIn = false)
        val challenge = api.startOtp(OtpStartRequest("+905321112233", "tr"))
        repeat(4) { expectProblem(400, ProblemCodes.OTP_INVALID) { api.verifyOtp(challenge.challengeId, "111111", device) } }
        expectProblem(429, ProblemCodes.OTP_LOCKED) { api.verifyOtp(challenge.challengeId, "111111", device) }
        expectProblem(410, ProblemCodes.OTP_EXPIRED) { api.verifyOtp(challenge.challengeId, "123456", device) }
    }

    @Test
    fun aKnownNumberSignsIntoTheExistingAccount() = runTest {
        val api = SampleApi(clock = clock, signedIn = false)
        val challenge = api.startOtp(OtpStartRequest("+989120000000", "fa"))
        val result = api.verifyOtp(challenge.challengeId, "123456", device)
        assertFalse(result.isNew)
        assertEquals(AccountStatus.Active, result.user.status)
        assertTrue(api.deck().cards.isNotEmpty())
    }

    @Test
    fun googleSignInIsOnlyForThePlayBuild() = runTest {
        expectProblem(403, ProblemCodes.STORE_NOT_SUPPORTED) { SampleApi(store = "bazaar", clock = clock).googleNonce() }
        assertTrue(SampleApi(store = "play", clock = clock).googleNonce().nonce.isNotEmpty())
    }

    @Test
    fun publicIdsAndIdsHaveTheWireShape() = runTest {
        val api = SampleApi(clock = clock)
        val uid = Regex("^[a-z2-7]{13}$")
        val id = Regex("^[1-9][0-9]{0,18}$")
        SampleData.people.forEach { assertTrue(it.id, uid.matches(it.id)) }
        assertTrue(uid.matches(SampleData.ME))
        assertTrue(uid.matches(SampleApi.NEW_ACCOUNT))
        val conversations = api.conversations().value.items
        conversations.forEach { c ->
            assertTrue(c.id, id.matches(c.id))
            api.messagesBefore(c.id, null).items.forEach { m -> assertTrue(m.id, id.matches(m.id)) }
        }
    }

    @Test
    fun everySampleAnswerIsValidOnTheWire() = runTest {
        val api = SampleApi(store = "play", clock = clock)
        roundTrips(api.config("fa").value, app.core.model.Config.serializer())
        roundTrips(api.me().value, Me.serializer())
        roundTrips(api.deck(), DeckPage.serializer())
        roundTrips(api.likes(), LikesPage.serializer())
        roundTrips(api.conversations().value, ConversationsPage.serializer())
        roundTrips(api.entitlements().value, Entitlements.serializer())
        roundTrips(api.products(), StoreProducts.serializer())
        val first = api.conversations().value.items.first()
        roundTrips(api.messagesBefore(first.id, null).copy(writeLagMs = null), MessagesPage.serializer())
    }

    @Test
    fun aMutualLikeMakesAConversationAndAOneWayLikeDoesNot() = runTest {
        val api = SampleApi(clock = clock)
        val before = api.conversations().value.items.size
        val deck = api.deck(limit = 20).cards
        val liker = deck.first { it.likesYou }
        val other = deck.first { !it.likesYou }

        val results = api.swipe(listOf(Swipe(liker.id, SwipeAction.Like, comment = "Hello!"), Swipe(other.id, SwipeAction.Like))).results
        assertEquals(listOf(SwipeOutcome.Matched, SwipeOutcome.Liked), results.map { it.result })
        val conversation = results[0].conversation!!
        assertEquals(MessageKind.LikeNote, conversation.lastMessage?.kind)

        val after = api.conversations().value
        assertEquals(before + 1, after.items.size)
        assertEquals(conversation.id, after.items.first().id)
        assertEquals(SwipeOutcome.Duplicate, api.swipe(listOf(Swipe(liker.id, SwipeAction.Like))).results.single().result)
        assertFalse("swiped people leave the deck", api.deck(limit = 20).cards.any { it.id == liker.id || it.id == other.id })
    }

    @Test
    fun superLikesSpendTheQuotaThenTheWalletThenStop() = runTest {
        val api = SampleApi(clock = clock)
        val targets = api.deck(limit = 20).cards.filterNot { it.likesYou }.map { it.id }
        // 1 weekly super like, then 2 in the wallet, then none.
        val outcomes = targets.take(4).map { api.swipe(listOf(Swipe(it, SwipeAction.Superlike))).results.single().result }
        assertEquals(listOf(SwipeOutcome.Liked, SwipeOutcome.Liked, SwipeOutcome.Liked, SwipeOutcome.Quota), outcomes)
        assertEquals(0, api.entitlements().value.wallet.superlike)
    }

    @Test
    fun freeLikesAreBlurredUntilThePlanAllowsThem() = runTest {
        val api = SampleApi(store = "play", clock = clock)
        val free = api.likes()
        assertTrue(free.total > 1)
        // The super like is shown; the rest are a blurhash only.
        assertNotNull(free.items.first().liker)
        assertTrue(free.items.drop(1).all { it.liker == null && it.blurhash != null })

        api.verifyPlayPurchase(PlayPurchaseRequest("sub.premium", "tok-premium", PurchaseKind.Subscription))
        assertTrue(api.likes().items.all { it.liker != null })
    }

    @Test
    fun messagesAreIdempotentByClientId() = runTest {
        val api = SampleApi(clock = clock)
        val conversation = api.conversations().value.items.first()
        val request = SendMessageRequest(UUID.randomUUID().toString(), MessageKind.Text, "Are we still on for Friday?")
        val sent = api.sendMessage(conversation.id, request)
        val again = api.sendMessage(conversation.id, request)
        assertFalse(sent.replayed)
        assertTrue(again.replayed)
        assertEquals(sent.message, again.message)
        val page = api.messagesAfter(conversation.id, conversation.lastMessage?.id ?: "1")
        assertEquals(listOf(sent.message), page.items)
    }

    @Test
    fun aCautionWordAsksForConfirmationFirst() = runTest {
        val api = SampleApi(clock = clock)
        val conversation = api.conversations().value.items.first()
        val ask = SendMessageRequest(UUID.randomUUID().toString(), MessageKind.Text, "Can you send money to me?")
        val problem = expectProblem(409, ProblemCodes.CONFIRM_REQUIRED) { api.sendMessage(conversation.id, ask) }
        val sent = api.sendMessage(conversation.id, ask.copy(confirm = problem.problem.confirmToken))
        assertEquals("Can you send money to me?", sent.message.body)
        expectProblem(422, ProblemCodes.MESSAGE_REFUSED) {
            api.sendMessage(conversation.id, SendMessageRequest(UUID.randomUUID().toString(), MessageKind.Text, "a refusedword here"))
        }
    }

    @Test
    fun anUnchangedListIsReportedAsUnchanged() = runTest {
        val api = SampleApi(clock = clock)
        assertTrue(api.conversations().changed)
        assertFalse("nothing moved", api.conversations().changed)
        val conversation = api.conversations().value.items.first()
        api.sendMessage(conversation.id, SendMessageRequest(UUID.randomUUID().toString(), MessageKind.Text, "hi"))
        assertTrue(api.conversations().changed)
        assertFalse(api.me().changed && api.me().changed)
    }

    @Test
    fun readReceiptsClearTheUnreadCount() = runTest {
        val api = SampleApi(clock = clock)
        val unread = api.conversations().value.items.first { it.unread > 0 }
        api.sendReceipts(unread.id, app.core.model.ReceiptsRequest(readUpTo = unread.lastMessage!!.id))
        assertEquals(0, api.conversations().value.items.first { it.id == unread.id }.unread)
    }

    @Test
    fun aPlacedCallIsAnsweredLaterAndLeavesALineInTheChat() = runTest {
        val api = SampleApi(clock = clock, answerAfterMs = 4_000)
        val conversation = api.conversations().value.items.first { it.callsAllowed.both }
        val call = api.placeCall(conversation.id, CallKind.Video)
        assertEquals(CallState.Ringing, call.state)
        expectProblem(409, ProblemCodes.CALLER_BUSY) { api.placeCall(conversation.id, CallKind.Audio) }

        clock.advance(5_000)
        assertEquals(CallState.Active, api.call(call.id).state)
        assertNotNull(api.callToken(call.id).token)

        clock.advance(60_000)
        val ended = api.endCall(call.id)
        assertEquals(CallOutcome.Completed, ended.outcome)
        assertEquals("answered at 4 s, ended at 65 s", 61L, ended.durationSeconds)
        expectProblem(409, ProblemCodes.CALL_NOT_LIVE) { api.callToken(call.id) }

        val line = api.messagesBefore(conversation.id, null).items.last()
        assertEquals(MessageKind.Call, line.kind)
        assertEquals(call.id, line.call?.callId)
    }

    @Test
    fun anUnansweredRingIsMissedAfter45Seconds() = runTest {
        val api = SampleApi(clock = clock, answerAfterMs = null)
        val conversation = api.conversations().value.items.first { it.callsAllowed.both }
        val call = api.placeCall(conversation.id, CallKind.Audio)
        clock.advance(46_000)
        val missed = api.call(call.id)
        assertEquals(CallState.Missed, missed.state)
        assertEquals(CallOutcome.Missed, missed.outcome)
    }

    @Test
    fun anIncomingRingIsAnsweredOnceOnly() = runTest {
        val api = SampleApi(clock = clock)
        val conversation = api.conversations().value.items.first()
        val ring = api.ringFrom(conversation.id)
        api.callRang(ring.id)
        val accepted = api.acceptCall(ring.id)
        assertEquals(CallState.Connecting, accepted.call.state)
        expectProblem(409, ProblemCodes.ANSWERED_ELSEWHERE) { api.acceptCall(ring.id) }
    }

    @Test
    fun callsNeedBothSidesConsent() = runTest {
        val api = SampleApi(clock = clock)
        val noConsent = api.conversations().value.items.first { !it.callsAllowed.both }
        val e = expectProblem(403, ProblemCodes.CALLS_NOT_ALLOWED) { api.placeCall(noConsent.id, CallKind.Audio) }
        assertEquals("consent", e.problem.reason)
    }

    @Test
    fun aBlockRemovesThePersonEverywhereAtOnce() = runTest {
        val api = SampleApi(clock = clock)
        val conversation = api.conversations().value.items.first()
        val peer = conversation.peer.id
        api.report(ReportRequest(peer, ReportContext.Chat, ReportReason.Harassment, conversationId = conversation.id, block = true))

        assertFalse(api.conversations().value.items.any { it.peer.id == peer })
        expectProblem(404, ProblemCodes.NOT_FOUND) { api.profile(peer) }
        expectProblem(404, ProblemCodes.NOT_FOUND) { api.messagesBefore(conversation.id, null) }
        assertEquals(peer, api.blocks().items.single().user.id)

        api.unblock(peer)
        assertFalse("an unblocked pair stays out of each other's deck", api.deck(limit = 50).cards.any { it.id == peer })
    }

    @Test
    fun aSuspendedAccountKeepsOnlyItsOwnRoutes() = runTest {
        val api = SampleApi(clock = clock)
        api.setAccountStatus(AccountStatus.Suspended, "Spam reports.")
        val e = expectProblem(403, ProblemCodes.ACCOUNT_SUSPENDED) { api.deck() }
        assertEquals("Spam reports.", e.problem.reasonText)
        val me = api.me().value
        assertEquals(AccountStatus.Suspended, me.status)
        val action = me.moderation.single()
        assertEquals("Spam reports.", action.reasonText)
        val appeal = api.appeal(action.id, "I did not send spam.")
        expectProblem(409, ProblemCodes.APPEAL_OPEN) { api.appeal(action.id, "Again") }
        assertEquals(appeal.id, api.moderation().active.single().appeal?.id)
        expectProblem(422, ProblemCodes.NOT_APPEALABLE) { api.appeal(api.moderation().history.first().id, "warning") }
    }

    @Test
    fun snoozingPausesTheDeckButNotTheConversations() = runTest {
        val api = SampleApi(clock = clock)
        api.updateSettings(SettingsPatch(snoozed = true))
        expectProblem(403, ProblemCodes.SNOOZED) { api.deck() }
        expectProblem(403, ProblemCodes.SNOOZED) { api.likes() }
        assertTrue(api.conversations().value.items.isNotEmpty())
        api.updateSettings(SettingsPatch(snoozed = false))
        assertTrue(api.deck().cards.isNotEmpty())
    }

    @Test
    fun paidFeaturesAreRefusedWithTheFeatureName() = runTest {
        val api = SampleApi(clock = clock)
        val filters = expectProblem(403, ProblemCodes.ENTITLEMENT_REQUIRED) { api.updatePreferences(PreferencesPatch(filters = mapOf("smoking" to listOf(21)))) }
        assertEquals("advanced_filters", filters.problem.feature)
        val dm = api.deck(limit = 20).cards.first { !it.likesYou }
        api.sendMessageRequest(dm.id, "Hi!", "c-1")
        assertEquals("a resend is the same request", api.sendMessageRequest(dm.id, "Hi!", "c-1").id, api.messageRequests(RequestBox.Sent).items.single().id)
        val other = api.deck(limit = 20).cards.filterNot { it.likesYou || it.id == dm.id }.first()
        val quota = expectProblem(429, ProblemCodes.QUOTA_EXCEEDED) { api.sendMessageRequest(other.id, "Hi!", "c-2") }
        assertEquals("dm", quota.problem.feature)
        assertEquals(true, quota.problem.canBuy)
    }

    @Test
    fun purchasesAreGrantedOnceAndRespectTheStore() = runTest {
        val bazaar = SampleApi(store = "bazaar", clock = clock)
        expectProblem(403, ProblemCodes.STORE_NOT_SUPPORTED) {
            bazaar.verifyPlayPurchase(PlayPurchaseRequest("sub.plus", "t", PurchaseKind.Subscription))
        }
        val products = bazaar.products()
        assertTrue(products.subscriptions.all { it.basePlanId == null && it.productId.startsWith("sub.") })
        assertTrue("no weekly plan in this store", products.subscriptions.none { it.period == app.core.model.BillingPeriod.Week })

        val first = bazaar.verifyBazaarPurchase(BazaarPurchaseRequest("superlike.5", "tok-1", "{}", "sig", PurchaseKind.Consumable))
        val again = bazaar.verifyBazaarPurchase(BazaarPurchaseRequest("superlike.5", "tok-1", "{}", "sig", PurchaseKind.Consumable))
        assertEquals(first, again)
        assertEquals("credited once", 7, bazaar.entitlements().value.wallet.superlike)

        val pending = bazaar.verifyBazaarPurchase(BazaarPurchaseRequest("sub.plus.1m", "pending-1", "{}", "sig", PurchaseKind.Subscription))
        assertTrue(pending.purchase.pending)
        assertEquals("a pending purchase grants nothing", Plan.Free, bazaar.entitlements().value.plan)
        expectProblem(422, ProblemCodes.PURCHASE_INVALID) {
            bazaar.verifyBazaarPurchase(BazaarPurchaseRequest("no.such", "tok-2", "{}", "sig", PurchaseKind.Subscription))
        }
    }

    @Test
    fun aPhotoIsProcessedAFewSecondsAfterItsUpload() = runTest {
        val api = SampleApi(clock = clock)
        expectProblem(409, ProblemCodes.POSITION_TAKEN) { api.startPhotoUpload(0, PhotoMime.Jpeg, 1_000) }
        expectProblem(413, ProblemCodes.PAYLOAD_TOO_LARGE) { api.startPhotoUpload(5, PhotoMime.Jpeg, 20L * 1024 * 1024) }
        val ticket = api.startPhotoUpload(5, PhotoMime.Webp, 900_000)
        assertEquals("PUT", ticket.upload.method)
        expectProblem(422, ProblemCodes.UPLOAD_MISSING) { api.completePhotoUpload(ticket.photoId) }
        api.put(ticket.upload, ByteArray(1_024), "image/webp")
        assertEquals(PhotoStatus.Processing, api.completePhotoUpload(ticket.photoId).status)
        assertEquals(PhotoStatus.Processing, api.me().value.profile!!.photos.single { it.id == ticket.photoId }.status)
        clock.advance(6_000)
        val photo = api.me().value.profile!!.photos.single { it.id == ticket.photoId }
        assertEquals(PhotoStatus.Approved, photo.status)
        assertNotNull(photo.url)
    }

    @Test
    fun aShownProfileKeepsTheMinimumOfPhotos() = runTest {
        val api = SampleApi(clock = clock)
        val photos = api.me().value.profile!!.photos
        photos.drop(2).forEach { api.deletePhoto(it.id) }
        expectProblem(422, ProblemCodes.PHOTO_MIN) { api.deletePhoto(photos[1].id) }
    }

    @Test
    fun aPositionPicksACityAndIsNeverEchoed() = runTest {
        val api = SampleApi(clock = clock)
        val result = api.updateLocation(LocationUpdate(41.0, 29.0, LocationSource.Gps))
        assertEquals(745044, result.city?.id)
        assertEquals("TR", result.country)
        expectProblem(429, ProblemCodes.RATE_LIMITED) { api.updateLocation(LocationUpdate(41.0, 29.0, LocationSource.Gps)) }
        val text = Wire.json.encodeToString(Me.serializer(), api.me().value)
        assertFalse("no coordinate in the account's answer", text.contains("41.0") || text.contains("29.0"))
    }

    @Test
    fun deletionHasAGracePeriodAndCanBeUndone() = runTest {
        val api = SampleApi(clock = clock)
        val scheduled = api.deleteAccount("break")
        val me = api.me().value
        assertEquals(AccountStatus.Deleted, me.status)
        assertNull("a deleting account gets a minimal answer", me.profile)
        assertEquals(scheduled.purgeAt, me.deletion?.purgeAt)
        expectProblem(403, ProblemCodes.ACCOUNT_DELETED) { api.deck() }
        assertEquals(AccountStatus.Active, api.restoreAccount().status)
        assertTrue(api.deck().cards.isNotEmpty())
    }

    @Test
    fun theRequestLogHoldsRouteLabelsOnly() = runTest {
        val api = SampleApi(clock = clock)
        api.config("en")
        api.me()
        api.conversations()
        assertEquals(listOf("config", "me", "conversations"), api.requestLog)
        assertTrue(api.requestLog.none { it.any(Char::isDigit) })
    }

    @Test
    fun aClientIdNamesOneMessageAndOneRequestForGood() = runTest {
        val api = SampleApi(clock = clock)
        val (a, b) = api.conversations().value.items.take(2)
        val request = SendMessageRequest(UUID.randomUUID().toString(), MessageKind.Text, "hi")
        val sent = api.sendMessage(a.id, request)
        // The same id for another conversation is refused, never answered with the first one's message.
        expectProblem(409, ProblemCodes.CONFLICT) { api.sendMessage(b.id, request) }
        assertEquals(sent.message, api.sendMessage(a.id, request).message)

        val cards = api.deck().cards
        val stranger = cards[0].id
        val other = cards[1].id
        val first = api.sendMessageRequest(stranger, "Hello there", "c-request-1")
        expectProblem(409, ProblemCodes.CONFLICT) { api.sendMessageRequest(other, "Hello there", "c-request-1") }
        assertEquals(first, api.sendMessageRequest(stranger, "Hello there", "c-request-1"))
    }

    @Test
    fun theExportIsAskedOnceAWeekReadyAfterItIsBuiltAndAnnouncedOnce() = runTest {
        val api = SampleApi(clock = clock)
        assertEquals(app.core.model.ExportState.None, api.exportStatus().status)
        val started = api.requestExport()
        assertEquals("a repeat within minutes is the same export", started, api.requestExport())
        assertEquals(app.core.model.ExportState.Pending, api.exportStatus().status)

        clock.advance(10_000)
        val before = api.channel.top
        val ready = api.exportStatus()
        assertEquals(app.core.model.ExportState.Ready, ready.status)
        val link = ready.link(clock.now())!!
        assertTrue(link, link.startsWith("https://") && started.exportId in link)
        roundTrips(ready, app.core.model.ExportStatus.serializer())
        val announced = api.channel.since(before, api.channel.epoch)!!.map { Wire.json.parseToJsonElement(it.second) }
            .mapNotNull { app.core.model.RealtimeEvents.decode(it) as? app.core.model.RealtimeEvent.AccountChanged }
        assertEquals(link, announced.single().account.export?.url)
        api.exportStatus()
        assertEquals("announced once", before + 1, api.channel.top)

        clock.advance(5 * 60_000)
        val again = expectProblem(429, ProblemCodes.RATE_LIMITED) { api.requestExport() }
        assertTrue((again.problem.retryAfterSeconds ?: 0) > 6 * 24 * 3600)
        clock.advance(24L * 3600 * 1000)
        assertEquals("the link ran out", app.core.model.ExportState.None, api.exportStatus().status)
    }
}
