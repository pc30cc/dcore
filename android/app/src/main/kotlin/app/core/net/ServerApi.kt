package app.core.net

import app.core.model.AppEvent
import app.core.model.Appeal
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.model.BazaarPurchaseRequest
import app.core.model.BlockList
import app.core.model.BoostKind
import app.core.model.BoostStarted
import app.core.model.Call
import app.core.model.CallAcceptance
import app.core.model.CallKind
import app.core.model.CallToken
import app.core.model.City
import app.core.model.Config
import app.core.model.ConsentKind
import app.core.model.ConsentRecord
import app.core.model.ConsentVersions
import app.core.model.Conversation
import app.core.model.ConversationPatch
import app.core.model.ConversationsPage
import app.core.model.DeckPage
import app.core.model.DeletionPreflight
import app.core.model.DeletionScheduled
import app.core.model.DeviceInfo
import app.core.model.DeviceUpdate
import app.core.model.DiscoveryPreferences
import app.core.model.Entitlements
import app.core.model.ExportStarted
import app.core.model.ExportStatus
import app.core.model.GoogleNonce
import app.core.model.Id
import app.core.model.LikesPage
import app.core.model.LocationResult
import app.core.model.LocationUpdate
import app.core.model.Me
import app.core.model.MessageRequestsPage
import app.core.model.MessagesPage
import app.core.model.ModerationHistory
import app.core.model.NotificationPrefs
import app.core.model.NotificationPrefsPatch
import app.core.model.OtpChallenge
import app.core.model.OtpStartRequest
import app.core.model.OwnProfile
import app.core.model.PhoneStartRequest
import app.core.model.PhotoMime
import app.core.model.PhotoProcessing
import app.core.model.PhotoUploadTicket
import app.core.model.PlayPurchaseRequest
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.ProfilePatch
import app.core.model.PublicDeletionChallenge
import app.core.model.PublicUid
import app.core.model.PurchaseResult
import app.core.model.RealtimeToken
import app.core.model.ReceiptsRequest
import app.core.model.ReportRequest
import app.core.model.RequestBox
import app.core.model.RestorePurchase
import app.core.model.RestoreResult
import app.core.model.SendMessageRequest
import app.core.model.SentMessage
import app.core.model.SentRequest
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.StoreProducts
import app.core.model.SupportMessage
import app.core.model.SupportMessages
import app.core.model.SupportTicket
import app.core.model.SupportTickets
import app.core.model.Swipe
import app.core.model.SwipesResult
import app.core.model.VerificationSession
import app.core.model.VerificationState
import app.core.model.Gender
import kotlinx.coroutines.flow.Flow
import java.time.LocalDate

/**
 * An answer to a revalidated read. [changed] is false when the server said
 * 304 and [value] is the stored copy: nothing to redraw, nothing to merge.
 */
data class Fetched<T>(val value: T, val changed: Boolean)

/**
 * Everything the app asks the server, one method per `/v1` route.
 *
 * Screens and repositories depend on this, never on [HttpServerApi]
 * directly, which is what lets [Backend] hand debug builds the in-memory
 * sample backend for screenshots and UI tests, and release builds the real
 * server only.
 *
 * Every method throws [ApiError] on failure: [ApiError.Http] carries the
 * server's problem code (`ProblemCodes`), [ApiError.Unauthorized] means the
 * session is over. Methods that only make sense signed in throw
 * [ApiError.Unauthorized] without a request when there is no session.
 *
 * Not here: the webhooks (`/v1/webhooks/...`), which only the store, the
 * media server and the verification provider call, and the admin API.
 */
interface ServerApi {

    /** Session loss, a required update, maintenance: things no one request owns. */
    val events: Flow<ApiEvent>

    /** Whether this phone holds a session (it may still turn out to be revoked). */
    suspend fun hasSession(): Boolean

    /** The account the session is for, as last known, without a request. */
    suspend fun sessionUser(): AuthUser?

    /** Forgets the session and stored answers here, without telling the server. */
    suspend fun discardSession()

    // MARK: - Config

    /** `GET /v1/config?store=&locale=`, revalidated with its ETag. No session needed. */
    suspend fun config(locale: String): Fetched<Config>

    /** The last config this phone stored for [locale], without a request: what a cold start shows first. */
    suspend fun cachedConfig(locale: String): Config?

    // MARK: - Auth

    /** `POST /v1/auth/otp/start`: sends a code by SMS (or a call). Never retried: each try may send a text. */
    suspend fun startOtp(request: OtpStartRequest): OtpChallenge

    /** `POST /v1/auth/otp/verify`: signs in, and keeps the session. */
    suspend fun verifyOtp(challengeId: String, code: String, device: DeviceInfo): AuthResult

    /** `POST /v1/auth/google/nonce` (play build only; the bazaar build gets `store_not_supported`). */
    suspend fun googleNonce(): GoogleNonce

    /** `POST /v1/auth/google`: signs in with a Google ID token, and keeps the session. */
    suspend fun signInWithGoogle(idToken: String, nonceId: String, device: DeviceInfo): AuthResult

    /**
     * `POST /v1/auth/logout`, then forgets the session here. A network
     * failure is thrown and the session kept, so the caller can retry or
     * [discardSession] anyway.
     */
    suspend fun logout(allSessions: Boolean = false)

    /** `POST /v1/me/phone/start`: add or change the account's phone number. */
    suspend fun startPhoneChange(request: PhoneStartRequest): OtpChallenge

    /** `POST /v1/me/phone/verify`. */
    suspend fun verifyPhoneChange(challengeId: String, code: String)

    // MARK: - Me, profile, photos, location

    /** `GET /v1/me`, revalidated with its ETag. Also callable by restricted and deleting accounts. */
    suspend fun me(): Fetched<Me>

    /**
     * `PUT /v1/me/basics`: once, during onboarding, with the legal text
     * versions the person accepted. `under_age` closes the account.
     */
    suspend fun setBasics(birthDate: LocalDate, gender: Gender, consents: ConsentVersions): OwnProfile

    /** `GET /v1/me/consents`. */
    suspend fun consents(): List<ConsentRecord>

    /** `PUT /v1/me/consents/:kind`: accepts (or withdraws) [version] of a text or an explicit consent. */
    suspend fun setConsent(kind: ConsentKind, version: Int, accepted: Boolean)

    /** `PATCH /v1/me/profile`. */
    suspend fun updateProfile(patch: ProfilePatch): OwnProfile

    /** `PATCH /v1/me/preferences`: the deck is rebuilt for them. */
    suspend fun updatePreferences(patch: PreferencesPatch): DiscoveryPreferences

    /** `PATCH /v1/me/settings`. */
    suspend fun updateSettings(patch: SettingsPatch): Settings

    /** `PATCH /v1/me/notifications`. */
    suspend fun updateNotifications(patch: NotificationPrefsPatch): NotificationPrefs

    /** `PUT /v1/me/location`: the server keeps a coarse cell only. At most once a minute. */
    suspend fun updateLocation(update: LocationUpdate): LocationResult

    /** `GET /v1/cities?q=&country=`. */
    suspend fun cities(query: String, country: String? = null): List<City>

    /** `POST /v1/me/photos`: a presigned upload for a new photo at [position]. */
    suspend fun startPhotoUpload(position: Int, mime: PhotoMime, bytes: Long): PhotoUploadTicket

    /** `POST /v1/me/photos/:photoId/complete`, after the upload: processing starts. */
    suspend fun completePhotoUpload(photoId: Id): PhotoProcessing

    /** `PUT /v1/me/photos/order`. */
    suspend fun reorderPhotos(photoIds: List<Id>): OwnProfile

    /** `DELETE /v1/me/photos/:photoId`; one that would leave too few is refused (`photo_min`). */
    suspend fun deletePhoto(photoId: Id)

    /** `GET /v1/profiles/:publicUid`: a profile opened from chat, likes or requests. */
    suspend fun profile(id: PublicUid): ProfileCard

    /** `POST /v1/verification/sessions`: starts face verification with the server's provider. */
    suspend fun startVerification(): VerificationSession

    /** `POST /v1/verification/:id/submit`. */
    suspend fun submitVerification(sessionId: Id): VerificationState

    /** `GET /v1/verification/status`. */
    suspend fun verificationStatus(): VerificationState

    // MARK: - Devices

    /**
     * `PUT /v1/devices/current`. Callers send only when the registration's
     * fingerprint changed, or weekly.
     */
    suspend fun updateDevice(update: DeviceUpdate)

    // MARK: - Deck and swipes

    /** `GET /v1/deck?limit=`. */
    suspend fun deck(limit: Int = 10): DeckPage

    /** `POST /v1/swipes`: 1-20 at once; passes are batched, likes sent at once. Never retried. */
    suspend fun swipe(swipes: List<Swipe>): SwipesResult

    // MARK: - Likes

    /** `GET /v1/likes?cursor=&limit=`. */
    suspend fun likes(cursor: String? = null, limit: Int = 20): LikesPage

    // MARK: - Conversations and messages

    /** `GET /v1/conversations?cursor=&limit=`, revalidated with its ETag (the first page). */
    suspend fun conversations(cursor: String? = null, limit: Int = 50): Fetched<ConversationsPage>

    /** `GET /v1/conversations/:id/messages?before=`: an older page. */
    suspend fun messagesBefore(conversationId: Id, before: Id?, limit: Int = 50): MessagesPage

    /** `GET /v1/conversations/:id/messages?after=`: catch-up after a failed realtime recovery. */
    suspend fun messagesAfter(conversationId: Id, after: Id, limit: Int = 200): MessagesPage

    /**
     * `POST /v1/conversations/:id/messages`. Safe to resend with the same
     * `clientId`: the server answers with the message it already has.
     */
    suspend fun sendMessage(conversationId: Id, request: SendMessageRequest): SentMessage

    /** `POST /v1/conversations/:id/receipts`. Debounced by the caller; sent only when a pointer moves. */
    suspend fun sendReceipts(conversationId: Id, receipts: ReceiptsRequest)

    /** `POST /v1/conversations/:id/typing`. At most once every 3 s. */
    suspend fun sendTyping(conversationId: Id)

    /** `PATCH /v1/conversations/:id`: call consent, mute. */
    suspend fun updateConversation(conversationId: Id, patch: ConversationPatch): Conversation

    /** `DELETE /v1/conversations/:id`: unmatch. */
    suspend fun unmatch(conversationId: Id)

    // MARK: - Message requests

    /** `POST /v1/message-requests`. */
    suspend fun sendMessageRequest(to: PublicUid, body: String, clientId: String): SentRequest

    /** `GET /v1/message-requests?box=&cursor=`. */
    suspend fun messageRequests(box: RequestBox, cursor: String? = null): MessageRequestsPage

    /** `POST /v1/message-requests/:id/accept`: the request becomes a conversation. */
    suspend fun acceptMessageRequest(requestId: Id): Conversation

    /** `POST /v1/message-requests/:id/decline`; the sender is never told. */
    suspend fun declineMessageRequest(requestId: Id)

    /** `DELETE /v1/message-requests/:id`: the sender withdraws it. */
    suspend fun withdrawMessageRequest(requestId: Id)

    // MARK: - Calls

    /** `POST /v1/calls`: rings the other person. Never retried. */
    suspend fun placeCall(conversationId: Id, kind: CallKind): Call

    /** `GET /v1/calls/:id`: only while the realtime socket is down. */
    suspend fun call(callId: Id): Call

    /** `POST /v1/calls/:id/rang`: this device showed the ring. */
    suspend fun callRang(callId: Id)

    /** `POST /v1/calls/:id/accept`: the first answer wins. */
    suspend fun acceptCall(callId: Id): CallAcceptance

    /** `POST /v1/calls/:id/decline`. */
    suspend fun declineCall(callId: Id): Call

    /** `POST /v1/calls/:id/cancel`: the caller, before an answer. */
    suspend fun cancelCall(callId: Id): Call

    /** `POST /v1/calls/:id/end`. */
    suspend fun endCall(callId: Id): Call

    /** `POST /v1/calls/:id/token`: a fresh room token while the call is live. */
    suspend fun callToken(callId: Id): CallToken

    // MARK: - Safety

    /** `POST /v1/reports`; returns the report id. */
    suspend fun report(request: ReportRequest): Id

    /** `POST /v1/blocks`. */
    suspend fun block(target: PublicUid)

    /** `GET /v1/blocks`. */
    suspend fun blocks(): BlockList

    /** `DELETE /v1/blocks/:target`. */
    suspend fun unblock(target: PublicUid)

    /** The account's moderation actions, active and past, with their reasons and appeals. */
    suspend fun moderation(): ModerationHistory

    /** `POST /v1/appeals` against one moderation action. */
    suspend fun appeal(actionId: Id, body: String): Appeal

    // MARK: - Store

    /** `GET /v1/store/products`: the session's store's catalogue (no prices). */
    suspend fun products(): StoreProducts

    /** `POST /v1/store/play/purchases`: the server verifies with Google before granting anything. */
    suspend fun verifyPlayPurchase(request: PlayPurchaseRequest): PurchaseResult

    /** `POST /v1/store/bazaar/purchases`: the server checks the signature and asks Cafe Bazaar. */
    suspend fun verifyBazaarPurchase(request: BazaarPurchaseRequest): PurchaseResult

    /** `POST /v1/store/restore`. */
    suspend fun restorePurchases(purchases: List<RestorePurchase>): RestoreResult

    /** `GET /v1/me/entitlements`, revalidated with its ETag. */
    suspend fun entitlements(): Fetched<Entitlements>

    /** `POST /v1/boosts`. Never retried: it may spend from the wallet. */
    suspend fun boost(kind: BoostKind): BoostStarted

    // MARK: - Realtime

    /** `POST /v1/realtime/token`. */
    suspend fun realtimeToken(): RealtimeToken

    // MARK: - Account deletion

    /** `GET /v1/me/deletion/preflight`: a store subscription deleting does not cancel. */
    suspend fun deletionPreflight(): DeletionPreflight

    /** `POST /v1/me/deletion`: the account is deleted after a grace period. */
    suspend fun deleteAccount(reason: String? = null): DeletionScheduled

    /** `POST /v1/me/restore`: undoes a deletion within the grace period. */
    suspend fun restoreAccount(): AuthUser

    /** `POST /v1/public/account-deletion/start`: the no-sign-in deletion, by phone. */
    suspend fun publicDeletionStart(phone: String, locale: String): PublicDeletionChallenge

    /** `POST /v1/public/account-deletion/confirm`. */
    suspend fun publicDeletionConfirm(requestToken: String, code: String): DeletionScheduled

    /** `POST /v1/public/account-deletion/google`: for accounts that only ever signed in with Google. */
    suspend fun publicDeletionGoogle(idToken: String): DeletionScheduled

    // MARK: - Support, export, events

    /** `GET /v1/support/tickets`. */
    suspend fun supportTickets(cursor: String? = null): SupportTickets

    /** `POST /v1/support/tickets`. */
    suspend fun openSupportTicket(category: String, body: String, subject: String? = null): SupportTicket

    /** `GET /v1/support/tickets/:id/messages`. */
    suspend fun supportMessages(ticketId: Id, cursor: String? = null): SupportMessages

    /** `POST /v1/support/tickets/:id/messages`. */
    suspend fun sendSupportMessage(ticketId: Id, body: String): SupportMessage

    /**
     * `POST /v1/me/export`: a ZIP of the account's data, announced by
     * realtime (`account` with `export`) when ready. One a week: a repeat
     * within minutes answers the same export, a later one `429 rate_limited`.
     */
    suspend fun requestExport(): ExportStarted

    /**
     * `GET /v1/me/export`: where the export stands, from the server's own
     * record (no database). Read when an export screen opens and when the
     * realtime event arrives, so an offline phone does not lose the link.
     */
    suspend fun exportStatus(): ExportStatus

    /** `POST /v1/events`: at most 100 first-party analytics events. Never retried. */
    suspend fun sendEvents(events: List<AppEvent>)
}
