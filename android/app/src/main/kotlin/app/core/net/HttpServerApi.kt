package app.core.net

import app.core.common.Clock
import app.core.model.AppEvent
import app.core.model.Appeal
import app.core.model.AppealBody
import app.core.model.AppealRequest
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.model.BasicsRequest
import app.core.model.ConsentKind
import app.core.model.ConsentList
import app.core.model.ConsentRecord
import app.core.model.ConsentUpdate
import app.core.model.ConsentVersions
import app.core.model.BazaarPurchaseRequest
import app.core.model.BlockList
import app.core.model.BlockRequest
import app.core.model.BoostKind
import app.core.model.BoostRequest
import app.core.model.BoostStarted
import app.core.model.Call
import app.core.model.CallAcceptance
import app.core.model.CallBody
import app.core.model.CallKind
import app.core.model.CallToken
import app.core.model.City
import app.core.model.CityList
import app.core.model.Config
import app.core.model.Conversation
import app.core.model.ConversationBody
import app.core.model.ConversationPatch
import app.core.model.ConversationsPage
import app.core.model.DeckPage
import app.core.model.DeletionPreflight
import app.core.model.DeletionRequest
import app.core.model.DeletionScheduled
import app.core.model.DeviceInfo
import app.core.model.DeviceUpdate
import app.core.model.DiscoveryPreferences
import app.core.model.Entitlements
import app.core.model.EventsRequest
import app.core.model.ExportStarted
import app.core.model.ExportStatus
import app.core.model.Gender
import app.core.model.GoogleNonce
import app.core.model.GoogleSignInRequest
import app.core.model.Id
import app.core.model.LikesPage
import app.core.model.LocationResult
import app.core.model.LocationUpdate
import app.core.model.LogoutRequest
import app.core.model.Me
import app.core.model.MessageRequestCreate
import app.core.model.MessageRequestsPage
import app.core.model.MessagesPage
import app.core.model.ModerationHistory
import app.core.model.NotificationPrefs
import app.core.model.NotificationPrefsPatch
import app.core.model.OtpChallenge
import app.core.model.OtpStartRequest
import app.core.model.OtpVerifyRequest
import app.core.model.OwnProfile
import app.core.model.PhoneStartRequest
import app.core.model.PhoneVerifyRequest
import app.core.model.PhotoCompleted
import app.core.model.PhotoMime
import app.core.model.PhotoOrderRequest
import app.core.model.PhotoProcessing
import app.core.model.PhotoUploadRequest
import app.core.model.PhotoUploadTicket
import app.core.model.PlaceCallRequest
import app.core.model.PlayPurchaseRequest
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.ProfilePatch
import app.core.model.PublicDeletionChallenge
import app.core.model.PublicDeletionConfirm
import app.core.model.PublicDeletionGoogle
import app.core.model.PublicDeletionStart
import app.core.model.PublicUid
import app.core.model.PurchaseResult
import app.core.model.RealtimeToken
import app.core.model.ReceiptsRequest
import app.core.model.ReportReceipt
import app.core.model.ReportRequest
import app.core.model.RequestBox
import app.core.model.RestorePurchase
import app.core.model.RestoreRequest
import app.core.model.RestoreResult
import app.core.model.RestoredAccount
import app.core.model.SendMessageRequest
import app.core.model.SentMessage
import app.core.model.SentMessageBody
import app.core.model.SentRequest
import app.core.model.SentRequestBody
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.StoreProducts
import app.core.model.SupportMessage
import app.core.model.SupportMessageBody
import app.core.model.SupportMessageCreate
import app.core.model.SupportMessages
import app.core.model.SupportTicket
import app.core.model.SupportTicketBody
import app.core.model.SupportTicketCreate
import app.core.model.SupportTickets
import app.core.model.Swipe
import app.core.model.SwipesRequest
import app.core.model.SwipesResult
import app.core.model.VerificationSession
import app.core.model.VerificationState
import app.core.storage.SessionStore
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import kotlinx.coroutines.flow.Flow
import java.time.LocalDate

/**
 * [ServerApi] on the real server, through the [ApiClient] funnel.
 *
 * Each route says what retrying it would mean ([Idempotency]) and whether it
 * needs the session. The route labels (`me.profile`, `calls.accept`) are what
 * logs and tests see: they never contain an id.
 */
class HttpServerApi(
    private val client: ApiClient,
    private val session: SessionStore,
    private val device: DeviceIdentity,
    /** The store this build is for (`bazaar`, `play`): config is per store. */
    private val store: String,
    private val clock: Clock = Clock.System,
) : ServerApi {

    override val events: Flow<ApiEvent> get() = client.events

    override suspend fun hasSession(): Boolean = session.hasSession()

    override suspend fun sessionUser(): AuthUser? =
        session.account()?.let { AuthUser(it.id, it.status, it.onboardingStep) }

    override suspend fun discardSession() {
        session.clear()
        client.clearCache()
    }

    /** A cache key for an answer that belongs to the signed-in account; null (no caching) without one. */
    private suspend fun personal(name: String): String? = session.accountId()?.let { "u:$it:$name" }

    // MARK: - Config

    private fun configKey(locale: String) = "config:$store:$locale"

    override suspend fun config(locale: String): Fetched<Config> =
        client.revalidate(
            route = "config",
            path = "v1/config",
            response = Config.serializer(),
            cacheKey = configKey(locale),
            query = listOf("store" to store, "locale" to locale),
            // Cached at the edge for everyone: it must not carry a session.
            authenticated = false,
        )

    override suspend fun cachedConfig(locale: String): Config? = client.cached(configKey(locale), Config.serializer())

    // MARK: - Auth

    override suspend fun startOtp(request: OtpStartRequest): OtpChallenge =
        client.send(
            "auth.otp.start", HttpMethod.Post, "v1/auth/otp/start",
            request, OtpStartRequest.serializer(), OtpChallenge.serializer(),
            Idempotency.NONE, authenticated = false,
        ).value

    override suspend fun verifyOtp(challengeId: String, code: String, device: DeviceInfo): AuthResult {
        val body = OtpVerifyRequest(challengeId, code, this.device.installId(), this.device.deviceKey(), device)
        val answer = client.send(
            "auth.otp.verify", HttpMethod.Post, "v1/auth/otp/verify",
            body, OtpVerifyRequest.serializer(), AuthResult.serializer(),
            Idempotency.NONE, authenticated = false,
        )
        return signedIn(answer)
    }

    override suspend fun googleNonce(): GoogleNonce =
        client.post("auth.google.nonce", "v1/auth/google/nonce", GoogleNonce.serializer(), Idempotency.NONE, authenticated = false).value

    override suspend fun signInWithGoogle(idToken: String, nonceId: String, device: DeviceInfo): AuthResult {
        val body = GoogleSignInRequest(idToken, nonceId, this.device.installId(), this.device.deviceKey(), device)
        val answer = client.send(
            "auth.google", HttpMethod.Post, "v1/auth/google",
            body, GoogleSignInRequest.serializer(), AuthResult.serializer(),
            Idempotency.NONE, authenticated = false,
        )
        return signedIn(answer)
    }

    /** Keeps a fresh sign-in and drops anything stored for whoever was signed in before. */
    private suspend fun signedIn(answer: Answer<AuthResult>): AuthResult {
        client.clearCache()
        session.signIn(answer.value, receivedAtMillis = clock.nowMillis(), serverDateMillis = answer.serverDateMillis)
        return answer.value
    }

    override suspend fun logout(allSessions: Boolean) {
        try {
            client.sendNoContent(
                "auth.logout", HttpMethod.Post, "v1/auth/logout",
                LogoutRequest(allSessions), LogoutRequest.serializer(), Idempotency.IDEMPOTENT,
            )
        } catch (e: ApiError.Unauthorized) {
            // Already over on the server: nothing left to end there.
        }
        discardSession()
    }

    override suspend fun startPhoneChange(request: PhoneStartRequest): OtpChallenge =
        client.send(
            "me.phone.start", HttpMethod.Post, "v1/me/phone/start",
            request, PhoneStartRequest.serializer(), OtpChallenge.serializer(), Idempotency.NONE,
        ).value

    override suspend fun verifyPhoneChange(challengeId: String, code: String) =
        client.sendNoContent(
            "me.phone.verify", HttpMethod.Post, "v1/me/phone/verify",
            PhoneVerifyRequest(challengeId, code), PhoneVerifyRequest.serializer(), Idempotency.NONE,
        )

    // MARK: - Me, profile, photos, location

    override suspend fun me(): Fetched<Me> {
        val fetched = client.revalidate("me", "v1/me", Me.serializer(), cacheKey = personal("me"))
        if (fetched.changed) {
            val me = fetched.value
            session.updateAccount(AuthUser(me.id, me.status, me.onboardingStep))
        }
        return fetched
    }

    override suspend fun setBasics(birthDate: LocalDate, gender: Gender, consents: ConsentVersions): OwnProfile =
        client.send(
            "me.basics", HttpMethod.Put, "v1/me/basics",
            BasicsRequest(birthDate, gender, consents), BasicsRequest.serializer(), OwnProfile.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun consents(): List<ConsentRecord> =
        client.get("me.consents", "v1/me/consents", ConsentList.serializer()).value.consents

    override suspend fun setConsent(kind: ConsentKind, version: Int, accepted: Boolean) =
        client.sendNoContent(
            "me.consents.set", HttpMethod.Put, "v1/me/consents/${seg(kind.wire)}",
            ConsentUpdate(version, accepted), ConsentUpdate.serializer(), Idempotency.IDEMPOTENT,
        )

    override suspend fun updateProfile(patch: ProfilePatch): OwnProfile =
        client.send(
            "me.profile", HttpMethod.Patch, "v1/me/profile",
            patch, ProfilePatch.serializer(), OwnProfile.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun updatePreferences(patch: PreferencesPatch): DiscoveryPreferences =
        client.send(
            "me.preferences", HttpMethod.Patch, "v1/me/preferences",
            patch, PreferencesPatch.serializer(), DiscoveryPreferences.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun updateSettings(patch: SettingsPatch): Settings =
        client.send(
            "me.settings", HttpMethod.Patch, "v1/me/settings",
            patch, SettingsPatch.serializer(), Settings.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun updateNotifications(patch: NotificationPrefsPatch): NotificationPrefs =
        client.send(
            "me.notifications", HttpMethod.Patch, "v1/me/notifications",
            patch, NotificationPrefsPatch.serializer(), NotificationPrefs.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun updateLocation(update: LocationUpdate): LocationResult =
        client.send(
            "me.location", HttpMethod.Put, "v1/me/location",
            update, LocationUpdate.serializer(), LocationResult.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun cities(query: String, country: String?): List<City> =
        client.get("cities", "v1/cities", CityList.serializer(), listOf("q" to query, "country" to country)).value.items

    override suspend fun startPhotoUpload(position: Int, mime: PhotoMime, bytes: Long): PhotoUploadTicket =
        client.send(
            "me.photos.start", HttpMethod.Post, "v1/me/photos",
            PhotoUploadRequest(position, mime, bytes), PhotoUploadRequest.serializer(), PhotoUploadTicket.serializer(),
            Idempotency.NONE,
        ).value

    override suspend fun completePhotoUpload(photoId: Id): PhotoProcessing =
        client.post(
            "me.photos.complete", "v1/me/photos/${seg(photoId)}/complete", PhotoCompleted.serializer(),
            // The photo id is the key: completing twice finds the same upload.
            Idempotency.KEYED,
        ).value.photo

    override suspend fun reorderPhotos(photoIds: List<Id>): OwnProfile =
        client.send(
            "me.photos.order", HttpMethod.Put, "v1/me/photos/order",
            PhotoOrderRequest(photoIds), PhotoOrderRequest.serializer(), OwnProfile.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun deletePhoto(photoId: Id) =
        client.sendNoContent<Unit>(
            "me.photos.delete", HttpMethod.Delete, "v1/me/photos/${seg(photoId)}", null, null, Idempotency.IDEMPOTENT,
        )

    override suspend fun profile(id: PublicUid): ProfileCard =
        client.get("profiles.get", "v1/profiles/${seg(id)}", ProfileCard.serializer()).value

    override suspend fun startVerification(): VerificationSession =
        client.post("verification.start", "v1/verification/sessions", VerificationSession.serializer(), Idempotency.NONE).value

    override suspend fun submitVerification(sessionId: Id): VerificationState =
        client.post(
            "verification.submit", "v1/verification/${seg(sessionId)}/submit", VerificationState.serializer(), Idempotency.KEYED,
        ).value

    override suspend fun verificationStatus(): VerificationState =
        client.get("verification.status", "v1/verification/status", VerificationState.serializer()).value

    // MARK: - Devices

    override suspend fun updateDevice(update: DeviceUpdate) =
        client.sendNoContent(
            "devices.current", HttpMethod.Put, "v1/devices/current", update, DeviceUpdate.serializer(), Idempotency.IDEMPOTENT,
        )

    // MARK: - Deck and swipes

    override suspend fun deck(limit: Int): DeckPage =
        client.get("deck", "v1/deck", DeckPage.serializer(), listOf("limit" to limit.toString())).value

    override suspend fun swipe(swipes: List<Swipe>): SwipesResult {
        require(swipes.size in 1..MAX_SWIPES) { "1-$MAX_SWIPES swipes per request, got ${swipes.size}" }
        return client.send(
            "swipes", HttpMethod.Post, "v1/swipes",
            SwipesRequest(swipes), SwipesRequest.serializer(), SwipesResult.serializer(), Idempotency.NONE,
        ).value
    }

    // MARK: - Likes

    override suspend fun likes(cursor: String?, limit: Int): LikesPage =
        client.get("likes", "v1/likes", LikesPage.serializer(), listOf("cursor" to cursor, "limit" to limit.toString())).value

    // MARK: - Conversations and messages

    override suspend fun conversations(cursor: String?, limit: Int): Fetched<ConversationsPage> =
        client.revalidate(
            route = "conversations",
            path = "v1/conversations",
            response = ConversationsPage.serializer(),
            // Only the first page has a version the server can answer 304 for.
            cacheKey = if (cursor == null) personal("conversations:$limit") else null,
            query = listOf("cursor" to cursor, "limit" to limit.toString()),
        )

    override suspend fun messagesBefore(conversationId: Id, before: Id?, limit: Int): MessagesPage =
        messages(conversationId, listOf("before" to before, "limit" to limit.toString()))

    override suspend fun messagesAfter(conversationId: Id, after: Id, limit: Int): MessagesPage =
        messages(conversationId, listOf("after" to after, "limit" to limit.toString()))

    private suspend fun messages(conversationId: Id, query: List<Pair<String, String?>>): MessagesPage {
        val answer = client.get(
            "conversations.messages", "v1/conversations/${seg(conversationId)}/messages", MessagesPage.serializer(), query,
        )
        val lag = answer.headers[ApiClient.WRITE_LAG_HEADER]?.trim()?.toLongOrNull()
        return if (lag == null) answer.value else answer.value.copy(writeLagMs = lag)
    }

    override suspend fun sendMessage(conversationId: Id, request: SendMessageRequest): SentMessage {
        val answer = client.send(
            "conversations.send", HttpMethod.Post, "v1/conversations/${seg(conversationId)}/messages",
            request, SendMessageRequest.serializer(), SentMessageBody.serializer(),
            // The client id is the key: a resend returns the message already made.
            Idempotency.KEYED,
        )
        return SentMessage(answer.value.message, replayed = answer.status == STATUS_OK)
    }

    override suspend fun sendReceipts(conversationId: Id, receipts: ReceiptsRequest) =
        client.sendNoContent(
            "conversations.receipts", HttpMethod.Post, "v1/conversations/${seg(conversationId)}/receipts",
            // Pointers only move forward: sending one twice changes nothing.
            receipts, ReceiptsRequest.serializer(), Idempotency.KEYED,
        )

    override suspend fun sendTyping(conversationId: Id) =
        // Stale a second later: never worth a retry.
        client.sendNoContent<Unit>(
            "conversations.typing", HttpMethod.Post, "v1/conversations/${seg(conversationId)}/typing", null, null, Idempotency.NONE,
        )

    override suspend fun updateConversation(conversationId: Id, patch: ConversationPatch): Conversation =
        client.send(
            "conversations.update", HttpMethod.Patch, "v1/conversations/${seg(conversationId)}",
            patch, ConversationPatch.serializer(), Conversation.serializer(), Idempotency.IDEMPOTENT,
        ).value

    override suspend fun unmatch(conversationId: Id) =
        client.sendNoContent<Unit>(
            "conversations.unmatch", HttpMethod.Delete, "v1/conversations/${seg(conversationId)}", null, null, Idempotency.IDEMPOTENT,
        )

    // MARK: - Message requests

    override suspend fun sendMessageRequest(to: PublicUid, body: String, clientId: String): SentRequest =
        client.send(
            "requests.send", HttpMethod.Post, "v1/message-requests",
            MessageRequestCreate(to, body, clientId), MessageRequestCreate.serializer(), SentRequestBody.serializer(),
            Idempotency.KEYED,
        ).value.request

    override suspend fun messageRequests(box: RequestBox, cursor: String?): MessageRequestsPage =
        client.get("requests", "v1/message-requests", MessageRequestsPage.serializer(), listOf("box" to box.wire, "cursor" to cursor)).value

    override suspend fun acceptMessageRequest(requestId: Id): Conversation =
        client.post(
            "requests.accept", "v1/message-requests/${seg(requestId)}/accept", ConversationBody.serializer(), Idempotency.NONE,
        ).value.conversation

    override suspend fun declineMessageRequest(requestId: Id) =
        client.sendNoContent<Unit>(
            "requests.decline", HttpMethod.Post, "v1/message-requests/${seg(requestId)}/decline", null, null, Idempotency.KEYED,
        )

    override suspend fun withdrawMessageRequest(requestId: Id) =
        client.sendNoContent<Unit>(
            "requests.withdraw", HttpMethod.Delete, "v1/message-requests/${seg(requestId)}", null, null, Idempotency.IDEMPOTENT,
        )

    // MARK: - Calls
    //
    // Call moves are never retried here: each is a decision in a state machine
    // the server owns (the first answer wins), and the caller already re-reads
    // the call when an answer is lost.

    override suspend fun placeCall(conversationId: Id, kind: CallKind): Call =
        client.send(
            "calls.place", HttpMethod.Post, "v1/calls",
            PlaceCallRequest(conversationId, kind), PlaceCallRequest.serializer(), CallBody.serializer(), Idempotency.NONE,
        ).value.call

    override suspend fun call(callId: Id): Call =
        client.get("calls.get", "v1/calls/${seg(callId)}", CallBody.serializer()).value.call

    override suspend fun callRang(callId: Id) =
        client.sendNoContent<Unit>("calls.rang", HttpMethod.Post, "v1/calls/${seg(callId)}/rang", null, null, Idempotency.KEYED)

    override suspend fun acceptCall(callId: Id): CallAcceptance =
        client.post("calls.accept", "v1/calls/${seg(callId)}/accept", CallAcceptance.serializer(), Idempotency.NONE).value

    override suspend fun declineCall(callId: Id): Call =
        client.post("calls.decline", "v1/calls/${seg(callId)}/decline", CallBody.serializer(), Idempotency.NONE).value.call

    override suspend fun cancelCall(callId: Id): Call =
        client.post("calls.cancel", "v1/calls/${seg(callId)}/cancel", CallBody.serializer(), Idempotency.NONE).value.call

    override suspend fun endCall(callId: Id): Call =
        client.post("calls.end", "v1/calls/${seg(callId)}/end", CallBody.serializer(), Idempotency.NONE).value.call

    override suspend fun callToken(callId: Id): CallToken =
        client.post("calls.token", "v1/calls/${seg(callId)}/token", CallToken.serializer(), Idempotency.KEYED).value

    // MARK: - Safety

    override suspend fun report(request: ReportRequest): Id =
        client.send(
            "reports", HttpMethod.Post, "v1/reports",
            request, ReportRequest.serializer(), ReportReceipt.serializer(), Idempotency.NONE,
        ).value.reportId

    override suspend fun block(target: PublicUid) =
        client.sendNoContent(
            "blocks.add", HttpMethod.Post, "v1/blocks", BlockRequest(target), BlockRequest.serializer(), Idempotency.KEYED,
        )

    override suspend fun blocks(): BlockList = client.get("blocks", "v1/blocks", BlockList.serializer()).value

    override suspend fun unblock(target: PublicUid) =
        client.sendNoContent<Unit>("blocks.remove", HttpMethod.Delete, "v1/blocks/${seg(target)}", null, null, Idempotency.IDEMPOTENT)

    override suspend fun moderation(): ModerationHistory =
        client.get("me.moderation", MODERATION_PATH, ModerationHistory.serializer()).value

    override suspend fun appeal(actionId: Id, body: String): Appeal =
        client.send(
            "appeals", HttpMethod.Post, "v1/appeals",
            AppealRequest(actionId, body), AppealRequest.serializer(), AppealBody.serializer(),
            // One open appeal per action: a second one is refused, not doubled.
            Idempotency.KEYED,
        ).value.appeal

    // MARK: - Store

    override suspend fun products(): StoreProducts = client.get("store.products", "v1/store/products", StoreProducts.serializer()).value

    override suspend fun verifyPlayPurchase(request: PlayPurchaseRequest): PurchaseResult =
        client.send(
            "store.play.purchase", HttpMethod.Post, "v1/store/play/purchases",
            request, PlayPurchaseRequest.serializer(), PurchaseResult.serializer(),
            // The purchase token is the key: a repeat costs the server nothing.
            Idempotency.KEYED,
        ).value

    override suspend fun verifyBazaarPurchase(request: BazaarPurchaseRequest): PurchaseResult =
        client.send(
            "store.bazaar.purchase", HttpMethod.Post, "v1/store/bazaar/purchases",
            request, BazaarPurchaseRequest.serializer(), PurchaseResult.serializer(), Idempotency.KEYED,
        ).value

    override suspend fun restorePurchases(purchases: List<RestorePurchase>): RestoreResult {
        require(purchases.size <= MAX_RESTORE) { "at most $MAX_RESTORE purchases per restore, got ${purchases.size}" }
        return client.send(
            "store.restore", HttpMethod.Post, "v1/store/restore",
            RestoreRequest(purchases), RestoreRequest.serializer(), RestoreResult.serializer(), Idempotency.KEYED,
        ).value
    }

    override suspend fun entitlements(): Fetched<Entitlements> =
        client.revalidate("me.entitlements", "v1/me/entitlements", Entitlements.serializer(), cacheKey = personal("entitlements"))

    override suspend fun boost(kind: BoostKind): BoostStarted =
        client.send(
            "boosts", HttpMethod.Post, "v1/boosts", BoostRequest(kind), BoostRequest.serializer(), BoostStarted.serializer(), Idempotency.NONE,
        ).value

    // MARK: - Realtime

    override suspend fun realtimeToken(): RealtimeToken =
        client.post("realtime.token", "v1/realtime/token", RealtimeToken.serializer(), Idempotency.KEYED).value

    // MARK: - Account deletion

    override suspend fun deletionPreflight(): DeletionPreflight =
        client.get("me.deletion.preflight", "v1/me/deletion/preflight", DeletionPreflight.serializer()).value

    override suspend fun deleteAccount(reason: String?): DeletionScheduled =
        client.send(
            "me.deletion", HttpMethod.Post, "v1/me/deletion",
            DeletionRequest(reason), DeletionRequest.serializer(), DeletionScheduled.serializer(),
            // Deleting a deleting account changes nothing.
            Idempotency.KEYED,
        ).value

    override suspend fun restoreAccount(): AuthUser {
        val user = client.post("me.restore", "v1/me/restore", RestoredAccount.serializer(), Idempotency.KEYED).value.user
        session.updateAccount(user)
        return user
    }

    override suspend fun publicDeletionStart(phone: String, locale: String): PublicDeletionChallenge =
        client.send(
            "public.deletion.start", HttpMethod.Post, "v1/public/account-deletion/start",
            PublicDeletionStart(phone, locale), PublicDeletionStart.serializer(), PublicDeletionChallenge.serializer(),
            Idempotency.NONE, authenticated = false,
        ).value

    override suspend fun publicDeletionConfirm(requestToken: String, code: String): DeletionScheduled =
        client.send(
            "public.deletion.confirm", HttpMethod.Post, "v1/public/account-deletion/confirm",
            PublicDeletionConfirm(requestToken, code), PublicDeletionConfirm.serializer(), DeletionScheduled.serializer(),
            Idempotency.NONE, authenticated = false,
        ).value

    override suspend fun publicDeletionGoogle(idToken: String): DeletionScheduled =
        client.send(
            "public.deletion.google", HttpMethod.Post, "v1/public/account-deletion/google",
            PublicDeletionGoogle(idToken), PublicDeletionGoogle.serializer(), DeletionScheduled.serializer(),
            Idempotency.NONE, authenticated = false,
        ).value

    // MARK: - Support, export, events

    override suspend fun supportTickets(cursor: String?): SupportTickets =
        client.get("support.tickets", "v1/support/tickets", SupportTickets.serializer(), listOf("cursor" to cursor)).value

    override suspend fun openSupportTicket(category: String, body: String, subject: String?): SupportTicket =
        client.send(
            "support.open", HttpMethod.Post, "v1/support/tickets",
            SupportTicketCreate(category, body, subject), SupportTicketCreate.serializer(), SupportTicketBody.serializer(),
            Idempotency.NONE,
        ).value.ticket

    override suspend fun supportMessages(ticketId: Id, cursor: String?): SupportMessages =
        client.get(
            "support.messages", "v1/support/tickets/${seg(ticketId)}/messages", SupportMessages.serializer(), listOf("cursor" to cursor),
        ).value

    override suspend fun sendSupportMessage(ticketId: Id, body: String): SupportMessage =
        client.send(
            "support.send", HttpMethod.Post, "v1/support/tickets/${seg(ticketId)}/messages",
            SupportMessageCreate(body), SupportMessageCreate.serializer(), SupportMessageBody.serializer(), Idempotency.NONE,
        ).value.message

    override suspend fun requestExport(): ExportStarted =
        client.post("me.export", "v1/me/export", ExportStarted.serializer(), Idempotency.KEYED).value

    override suspend fun exportStatus(): ExportStatus =
        // Not cached: a stored "ready" would outlive its link.
        client.get("me.export.status", "v1/me/export", ExportStatus.serializer()).value

    override suspend fun sendEvents(events: List<AppEvent>) {
        require(events.size <= MAX_EVENTS) { "at most $MAX_EVENTS events per request, got ${events.size}" }
        if (events.isEmpty()) return
        client.sendNoContent("events", HttpMethod.Post, "v1/events", EventsRequest(events), EventsRequest.serializer(), Idempotency.NONE)
    }

    private fun seg(id: String): String = id.encodeURLPathPart()

    companion object {
        const val MAX_SWIPES = 20
        const val MAX_RESTORE = 20
        const val MAX_EVENTS = 100

        /** The account's warnings, suspensions and bans, active and past. */
        const val MODERATION_PATH = "v1/me/moderation"

        private const val STATUS_OK = 200
    }
}
