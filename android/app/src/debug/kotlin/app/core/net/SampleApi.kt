package app.core.net

import app.core.common.Clock
import app.core.media.BlobTransport
import app.core.store.ExternalSignIn
import app.core.store.ExternalSignInResult
import app.core.store.SmsCodeReceiver
import app.core.model.ConsentKind
import app.core.model.ConsentRecord
import app.core.model.ConsentVersions
import app.core.model.Intention
import app.core.model.OnboardingCodes
import app.core.model.AccountLocation
import app.core.model.AccountStatus
import app.core.model.AppEvent
import app.core.model.Appeal
import app.core.model.AppealStatus
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.model.BazaarPurchaseRequest
import app.core.model.BlockList
import app.core.model.BlockedUser
import app.core.model.BoostKind
import app.core.model.BoostStarted
import app.core.model.Call
import app.core.model.CallAcceptance
import app.core.model.CallKind
import app.core.model.CallLine
import app.core.model.CallOutcome
import app.core.model.CallRole
import app.core.model.CallState
import app.core.model.CallToken
import app.core.model.CallsAllowed
import app.core.model.City
import app.core.model.Config
import app.core.model.Conversation
import app.core.model.ConversationPatch
import app.core.model.ConversationPeer
import app.core.model.ConversationSource
import app.core.model.ConversationState
import app.core.model.ConversationsPage
import app.core.model.DeckPage
import app.core.model.DeckSuggestion
import app.core.model.DeletionPreflight
import app.core.model.DeletionScheduled
import app.core.model.DeviceInfo
import app.core.model.DeviceUpdate
import app.core.model.DiscoveryPreferences
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.ExportStarted
import app.core.model.Features
import app.core.model.Gender
import app.core.model.GoogleNonce
import app.core.model.IcePolicy
import app.core.model.Id
import app.core.model.LikeItem
import app.core.model.LikeKind
import app.core.model.LikedItem
import app.core.model.LikesPage
import app.core.model.LocationResult
import app.core.model.LocationUpdate
import app.core.model.Me
import app.core.model.Message
import app.core.model.MessageKind
import app.core.model.MessageRequest
import app.core.model.MessageRequestsPage
import app.core.model.MessagesPage
import app.core.model.ModerationAction
import app.core.model.ModerationHistory
import app.core.model.ModerationKind
import app.core.model.NotificationPrefs
import app.core.model.NotificationPrefsPatch
import app.core.model.OtpChallenge
import app.core.model.OtpChannel
import app.core.model.OtpStartRequest
import app.core.model.OwnPhoto
import app.core.model.OwnPrompt
import app.core.model.OwnProfile
import app.core.model.PeerSummary
import app.core.model.PendingDeletion
import app.core.model.PhoneStartRequest
import app.core.model.PhotoMime
import app.core.model.PhotoProcessing
import app.core.model.PhotoStatus
import app.core.model.PhotoUploadTicket
import app.core.model.Plan
import app.core.model.PlayPurchaseRequest
import app.core.model.PreferencesPatch
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.model.ProfileCard
import app.core.model.ProfileFieldValue
import app.core.model.ProfilePatch
import app.core.model.PublicDeletionChallenge
import app.core.model.PublicUid
import app.core.model.PurchaseKind
import app.core.model.PurchaseRecord
import app.core.model.PurchaseResult
import app.core.model.Quota
import app.core.model.Quotas
import app.core.model.ReadCursors
import app.core.model.RealtimeToken
import app.core.model.ReceiptsRequest
import app.core.model.ReportRequest
import app.core.model.RequestBox
import app.core.model.RequestStatus
import app.core.model.RestorePurchase
import app.core.model.RestoreResult
import app.core.model.RestoredPurchase
import app.core.model.SendMessageRequest
import app.core.model.SentMessage
import app.core.model.SentRequest
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.StoreName
import app.core.model.StoreProducts
import app.core.model.StoreSubscriptionNotice
import app.core.model.SupportMessage
import app.core.model.SupportMessages
import app.core.model.SupportTicket
import app.core.model.SupportTickets
import app.core.model.Swipe
import app.core.model.SwipeAction
import app.core.model.SwipeOutcome
import app.core.model.SwipeResult
import app.core.model.SwipesResult
import app.core.model.TextState
import app.core.model.TicketAuthor
import app.core.model.TicketStatus
import app.core.model.UploadTarget
import app.core.model.VerificationSession
import app.core.model.VerificationState
import app.core.model.VerificationStatus
import app.core.model.Wallet
import app.core.model.ConversationChange
import app.core.model.ConversationEndEvent
import app.core.model.ConversationEvent
import app.core.model.RealtimeTypes
import app.core.model.ReceiptEvent
import app.core.model.TypingEvent
import app.core.realtime.RealtimeSocket
import app.core.realtime.RealtimeTransport
import app.core.realtime.SampleChannel
import app.core.realtime.SamplePeer
import app.core.realtime.SampleRealtime
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

/**
 * A backend that answers from memory, with the server's rules.
 *
 * It exists so every screen can be laid out, reviewed and screenshotted
 * without a server or an account, and so UI and repository tests run with no
 * network and no credentials. It follows the API's contract where a screen
 * can tell: the same error codes and extension members, quotas, the
 * free-plan blur of likes, idempotent sends by client id, ETag-like
 * "unchanged" answers, call states that move with [clock], photos that are
 * "processed" a few seconds after their upload (it also takes the upload's
 * bytes itself, as [BlobTransport], so a ticket that was never uploaded is
 * refused with `upload_missing`), sign-up that finishes only when what it
 * needs is there.
 *
 * Every call is recorded in [requestLog] by route label, so a test can count
 * what a flow asked for.
 *
 * It lives in `src/debug`: a release build cannot contain it (see [Backend]).
 */
class SampleApi(
    private val store: String = "bazaar",
    private val clock: Clock = Clock.System,
    signedIn: Boolean = true,
    /** How long after placing a call the other side answers; null: they never do (the ring times out). */
    private val answerAfterMs: Long? = 4_000,
    /** New profiles wait for a review before they are shown (the panel's waitlist). */
    private val waitlist: Boolean = false,
) : ServerApi, BlobTransport, ExternalSignIn, SmsCodeReceiver, RealtimeTransport, SamplePeer {

    private val lock = Mutex()
    private val _events = MutableSharedFlow<ApiEvent>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    override val events: Flow<ApiEvent> = _events.asSharedFlow()

    private val _requestLog = mutableListOf<String>()

    /** Route labels of every call so far, oldest first (the same labels [HttpServerApi] uses). */
    val requestLog: List<String> get() = synchronized(_requestLog) { _requestLog.toList() }

    private var idCounter = 0L
    private fun nextId(): Id = (ID_BASE + ++idCounter).toString()

    // MARK: - State

    private var session: AuthUser? = if (signedIn) AuthUser(SampleData.ME, AccountStatus.Active, 0) else null
    private var tokenCounter = 0
    private var profile: OwnProfile = SampleData.ownProfile()
    private var preferences: DiscoveryPreferences = SampleData.preferences
    private var notifications = NotificationPrefs()
    private var location = AccountLocation(city = SampleData.city(112931), country = "IR")
    private var lastLocationAt: Long? = null
    private var deletion: PendingDeletion? = null
    private var meVersion = 1L
    private val served = mutableMapOf<String, Long>()

    private class Challenge(val phone: String, val expiresAt: Long, var attemptsLeft: Int)
    private val challenges = mutableMapOf<String, Challenge>()
    private val lastOtpAt = mutableMapOf<String, Long>()
    private val knownPhones = mutableSetOf(SampleData.KNOWN_PHONE)

    private val swiped = mutableSetOf<PublicUid>()
    private val blocked = mutableMapOf<PublicUid, Instant>()
    private val deckQueue = ArrayDeque<PublicUid>()

    private class Thread(var conversation: Conversation, val messages: MutableList<Message>)
    private val threads = linkedMapOf<Id, Thread>()
    private var conversationsVersion = 1L
    private val sentByClientId = mutableMapOf<String, Message>()

    private val requests = mutableListOf<Pair<RequestBox, MessageRequest>>()
    private val requestByClientId = mutableMapOf<String, SentRequest>()

    private val calls = mutableMapOf<Id, Call>()

    /** The account's realtime channel, and the in-memory Centrifugo a debug app on this backend connects to. */
    val channel = SampleChannel(clock)
    private val realtime by lazy { SampleRealtime(channel, this) { session?.let { "u:#${it.id}" } } }

    private var entitlements = freeEntitlements()
    private var entitlementsVersion = 1L
    private val purchases = mutableMapOf<String, PurchaseResult>()

    private val moderation = mutableListOf<ModerationAction>()
    private val appeals = mutableMapOf<Id, Appeal>()

    private class PendingUpload(val position: Int, val startedAt: Long, var uploaded: Boolean = false)
    private val uploads = mutableMapOf<Id, PendingUpload>()
    private val processingSince = mutableMapOf<Id, Long>()
    private var uploadCount = 0
    private val toReject = mutableSetOf<Id>()

    /** Accepted consents: kind to version. A new account starts with none. */
    private val consents = mutableMapOf(
        ConsentKind.Terms to 1, ConsentKind.Privacy to 1, ConsentKind.Guidelines to 1,
    )
    private var reviewSince: Long? = null

    private var verification = VerificationState(VerificationStatus.None)
    private var verificationSubmittedAt: Long? = null

    private class Ticket(var ticket: SupportTicket, val messages: MutableList<SupportMessage>)
    private val tickets = linkedMapOf<Id, Ticket>()
    private var lastExportAt: Long? = null
    private var eventsReceived = 0

    /** The device registration last sent, for tests. */
    var device: DeviceUpdate? = null
        private set

    init {
        seed()
    }

    // MARK: - Helpers

    private fun now(): Instant = clock.now()
    private fun nowMs(): Long = clock.nowMillis()

    private fun fail(status: Int, code: String, vararg members: Pair<String, Any?>): Nothing {
        val problem = Problem.of(status, code, *members)
        // As the funnel does: the account's state is news for the whole app.
        if (status == 403 && code in ProblemCodes.ACCOUNT_STATE) _events.tryEmit(ApiEvent.AccountState(problem))
        throw ApiError.Http(status, problem)
    }

    private suspend fun <T> route(name: String, block: suspend () -> T): T {
        synchronized(_requestLog) { _requestLog += name }
        return lock.withLock { block() }
    }

    private fun user(): AuthUser = session ?: throw ApiError.Unauthorized(null)

    /** The account may use full-scope routes: not banned, suspended or deleting. */
    private fun full(): AuthUser {
        val me = user()
        when (me.status) {
            AccountStatus.Suspended -> fail(403, ProblemCodes.ACCOUNT_SUSPENDED, "reasonText" to activeReason(), "appealable" to true)
            AccountStatus.Banned -> fail(403, ProblemCodes.ACCOUNT_BANNED, "reasonText" to activeReason(), "appealable" to true)
            AccountStatus.Deleted -> fail(403, ProblemCodes.ACCOUNT_DELETED, "restorableUntil" to deletion?.purgeAt)
            else -> Unit
        }
        return me
    }

    /** Deck and social routes: an active account (a snoozed one only where [snoozedOk]). */
    private fun active(snoozedOk: Boolean = false): AuthUser {
        val me = full()
        when (me.status) {
            AccountStatus.Onboarding, AccountStatus.PendingReview -> fail(403, ProblemCodes.ONBOARDING_INCOMPLETE)
            AccountStatus.Snoozed -> if (!snoozedOk) fail(403, ProblemCodes.SNOOZED)
            else -> Unit
        }
        return me
    }

    private fun activeReason(): String = moderation.lastOrNull { it.kind != ModerationKind.Warning }?.reasonText.orEmpty()

    private fun bumpMe() {
        meVersion++
    }

    private fun bumpConversations() {
        conversationsVersion++
    }

    private fun bumpEntitlements() {
        entitlementsVersion++
    }

    /** An "unchanged" answer when the caller already saw [version] for [key], like a 304. */
    private fun <T> fetched(key: String, version: Long, value: T): Fetched<T> {
        val changed = served[key] != version
        served[key] = version
        return Fetched(value, changed)
    }

    private fun summary(card: ProfileCard) = PeerSummary(card.id, card.name, card.photos.firstOrNull(), card.verified)

    private fun visible(id: PublicUid): ProfileCard? = if (id in blocked) null else SampleData.person(id)

    private fun nextMidnight(): Instant = now().atOffset(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)

    private fun freeEntitlements() = Entitlements(
        plan = Plan.Free,
        quotas = Quotas(
            likes = Quota(limit = 50, used = 3, resetsAt = null),
            superlikes = Quota(limit = 1, used = 0, resetsAt = null),
            dm = Quota(limit = 1, used = 0, resetsAt = null),
            boosts = Quota(limit = 0, used = 0, resetsAt = null),
        ),
        wallet = Wallet(superlike = 2),
    )

    private fun premiumFeatures() = Features(
        seeLikes = true, rewind = true, readReceipts = true, incognito = true, travelMode = true,
        advancedFilters = true, profileViews = true, secondLook = true, priorityLikes = true,
    )

    private fun plusFeatures() = Features(seeLikes = true, rewind = true, advancedFilters = true, travelMode = true)

    private fun quotaAt(q: Quota?): Quota? = q?.copy(resetsAt = q.resetsAt ?: nextMidnight())

    private fun currentEntitlements(): Entitlements = entitlements.copy(
        quotas = Quotas(
            likes = quotaAt(entitlements.quotas.likes),
            superlikes = quotaAt(entitlements.quotas.superlikes),
            dm = quotaAt(entitlements.quotas.dm),
            boosts = quotaAt(entitlements.quotas.boosts),
        ),
    )

    // MARK: - Seed

    private fun seed() {
        val t0 = now()
        fun at(minutesAgo: Long) = t0.minus(minutesAgo, ChronoUnit.MINUTES)

        val negar = SampleData.person("bnegar2kq7xm4")!!
        val elif = SampleData.person("celif5ztr3wa2")!!
        val olivia = SampleData.person("dolivia6nb4ks")!!
        val long = SampleData.person("emaximil7a2pq")!!

        fun open(card: ProfileCard, source: ConversationSource, createdMinutesAgo: Long, online: Boolean = false, muted: Boolean = false, calls: Boolean = false): Thread {
            val id = nextId()
            val conversation = Conversation(
                id = id,
                peer = ConversationPeer(card.id, card.name, card.photos.firstOrNull(), card.verified, online = online, activeRecently = card.activeRecently),
                state = ConversationState.Active,
                source = source,
                createdAt = at(createdMinutesAgo),
                callsAllowed = CallsAllowed(me = calls, peer = calls),
                muted = muted,
            )
            return Thread(conversation, mutableListOf()).also { threads[id] = it }
        }

        fun Thread.say(from: PublicUid, minutesAgo: Long, body: String, kind: MessageKind = MessageKind.Text, call: CallLine? = null) {
            messages += Message(nextId(), conversation.id, from, kind = kind, body = body.takeIf { kind != MessageKind.Call }, call = call, at = at(minutesAgo))
        }

        open(negar, ConversationSource.Like, 60 * 26, online = true, calls = true).apply {
            say(SampleData.ME, 60 * 25, "سلام! عکس دماوندت خیلی قشنگ بود 🏔️")
            say(negar.id, 60 * 25 - 4, "سلام، ممنون! پارسال تابستون رفتم")
            say(SampleData.ME, 60 * 24, "منم دلم می‌خواد امسال برم. تنها رفتی؟")
            say(negar.id, 60 * 2, "نه با یه گروه کوهنوردی. تو اهل کوهی؟")
            say(negar.id, 58, "راستی اون کافه‌ای که گفتی کجاست؟")
        }
        open(elif, ConversationSource.ItemLike, 60 * 50, calls = true).apply {
            say(elif.id, 60 * 49, "Moda sahilindeki fotoğraf çok güzel!", kind = MessageKind.LikeNote)
            say(SampleData.ME, 60 * 48, "Teşekkürler! Sen de İstanbul'da mısın?")
            say(
                elif.id, 60 * 30, "",
                kind = MessageKind.Call,
                call = CallLine(nextId(), CallKind.Audio, CallOutcome.Completed, at(60 * 30), durationSeconds = 754, caller = elif.id),
            )
            say(elif.id, 60 * 29, "Konuşmak güzeldi 😊")
        }
        open(olivia, ConversationSource.SuperLike, 35)
        open(long, ConversationSource.Like, 60 * 24 * 6, muted = true).apply {
            say(long.id, 60 * 24 * 6 - 10, "Hello! ".repeat(30).trim())
            say(SampleData.ME, 60 * 24 * 5, "That is a lot of hellos.")
        }
        threads.values.forEach { thread ->
            val last = thread.messages.lastOrNull()
            val unread = thread.messages.count { it.senderId != SampleData.ME && it.at > at(60 * 3) }
            thread.conversation = thread.conversation.copy(
                lastMessage = last,
                unread = unread,
                myReadId = thread.messages.lastOrNull { it.senderId == SampleData.ME }?.id,
                peerDeliveredId = thread.messages.lastOrNull { it.senderId == SampleData.ME }?.id,
            )
        }
        swiped += threads.values.map { it.conversation.peer.id }

        val zeynep = SampleData.person("gzeynep4hq2wv")!!
        requests += RequestBox.Inbox to MessageRequest(nextId(), summary(zeynep), "Merhaba! Profilindeki harita koleksiyonu çok ilginç.", RequestStatus.Pending, at(90))

        moderation += ModerationAction(
            nextId(), ModerationKind.Warning, "Please keep messages respectful.", startsAt = t0.minus(Duration.ofDays(40)),
        )

        val ticketId = nextId()
        tickets[ticketId] = Ticket(
            SupportTicket(ticketId, "billing", "Subscription not showing", TicketStatus.Answered, createdAt = at(60 * 72), updatedAt = at(60 * 70), unread = 1),
            mutableListOf(
                SupportMessage(nextId(), TicketAuthor.User, "I paid but the plan still shows free.", at(60 * 72)),
                SupportMessage(nextId(), TicketAuthor.Staff, "Thanks, it is fixed now. Please reopen the app.", at(60 * 70)),
            ),
        )
        refillDeck()
    }

    private fun refillDeck() {
        deckQueue.clear()
        SampleData.people
            .filter { it.id !in swiped && it.id !in blocked }
            .filter { preferences.interestedIn.isEmpty() || it.gender in preferences.interestedIn || it.gender == Gender.Unknown }
            .filter { (it.age ?: 0) in preferences.ageMin..preferences.ageMax }
            // Like the server: the distance limit (unless the whole country) and verified only.
            .filter { preferences.wholeCountry || (it.distance?.km ?: 0) <= preferences.maxDistanceKm }
            .filter { !preferences.verifiedOnly || it.verified }
            .sortedByDescending { it.likesYou }
            .forEach { deckQueue += it.id }
    }

    // MARK: - Session

    override suspend fun hasSession(): Boolean = lock.withLock { session != null }

    override suspend fun sessionUser(): AuthUser? = lock.withLock { session }

    override suspend fun discardSession() = lock.withLock { session = null }

    /**
     * Makes the other side ring this account: an incoming call, for laying
     * out the ring and the call screen. Returns the call, as a push would name it.
     */
    suspend fun ringFrom(conversationId: Id, kind: CallKind = CallKind.Video): Call = route("sample.ring") {
        val thread = threads[conversationId] ?: fail(404, ProblemCodes.NOT_FOUND)
        val call = Call(
            id = nextId(), conversationId = thread.conversation.id, kind = kind, role = CallRole.Callee,
            state = CallState.Ringing, placedAt = now(), ringExpiresAt = now().plusSeconds(RING_SECONDS),
        )
        calls[call.id] = call
        call
    }

    /** Puts the account into [status] (a suspension or ban comes with a reason), for the restricted screens. */
    suspend fun setAccountStatus(status: AccountStatus, reason: String = "Repeated reports of harassment.") = route("sample.status") {
        val me = user()
        session = me.copy(status = status)
        if (status == AccountStatus.Suspended || status == AccountStatus.Banned) {
            moderation += ModerationAction(
                nextId(),
                if (status == AccountStatus.Banned) ModerationKind.Ban else ModerationKind.Suspension,
                reason,
                startsAt = now(),
                endsAt = if (status == AccountStatus.Suspended) now().plus(Duration.ofDays(7)) else null,
            )
        }
        bumpMe()
    }

    // MARK: - Config

    private val configVersion = 1L

    override suspend fun config(locale: String): Fetched<Config> = route("config") {
        fetched("config:$locale", configVersion, SampleData.config(store, locale, configVersion))
    }

    override suspend fun cachedConfig(locale: String): Config? = lock.withLock {
        if (served.containsKey("config:$locale")) SampleData.config(store, locale, configVersion) else null
    }

    // MARK: - Auth

    private fun validPhone(phone: String) {
        if (!PHONE.matches(phone)) fail(400, ProblemCodes.PHONE_INVALID)
        if (!phone.startsWith("+98") && !phone.startsWith("+90") && !phone.startsWith("+44")) fail(403, ProblemCodes.PHONE_NOT_ALLOWED)
    }

    private fun challenge(phone: String, channel: OtpChannel?): OtpChallenge {
        validPhone(phone)
        val last = lastOtpAt[phone]
        if (last != null && nowMs() - last < RESEND_AFTER_MS) {
            fail(429, ProblemCodes.RATE_LIMITED, "retryAfterSeconds" to (RESEND_AFTER_MS - (nowMs() - last) + 999) / 1000)
        }
        lastOtpAt[phone] = nowMs()
        val id = "ch_" + nextId()
        challenges[id] = Challenge(phone, nowMs() + OTP_TTL_MS, OTP_ATTEMPTS)
        return OtpChallenge(id, SampleData.CODE.length, (OTP_TTL_MS / 1000).toInt(), (RESEND_AFTER_MS / 1000).toInt(), channel ?: OtpChannel.Sms)
    }

    /** Checks [code] against [challengeId]; returns the phone it was for. */
    private fun check(challengeId: String, code: String): String {
        val challenge = challenges[challengeId] ?: fail(410, ProblemCodes.OTP_EXPIRED)
        if (nowMs() > challenge.expiresAt) {
            challenges.remove(challengeId)
            fail(410, ProblemCodes.OTP_EXPIRED)
        }
        if (code != SampleData.CODE) {
            challenge.attemptsLeft--
            if (challenge.attemptsLeft <= 0) {
                challenges.remove(challengeId)
                fail(429, ProblemCodes.OTP_LOCKED)
            }
            fail(400, ProblemCodes.OTP_INVALID, "attemptsLeft" to challenge.attemptsLeft)
        }
        challenges.remove(challengeId)
        return challenge.phone
    }

    private fun issue(user: AuthUser, isNew: Boolean): AuthResult {
        tokenCounter++
        session = user
        return AuthResult(
            accessToken = "sample.access.$tokenCounter",
            accessExpiresAt = now().plusSeconds(15 * 60),
            refreshToken = "rt1.sample.$tokenCounter",
            refreshExpiresAt = now().plus(Duration.ofDays(90)),
            user = user,
            isNew = isNew,
        )
    }

    override suspend fun startOtp(request: OtpStartRequest): OtpChallenge = route("auth.otp.start") {
        challenge(request.phone, request.channel)
    }

    override suspend fun verifyOtp(challengeId: String, code: String, device: DeviceInfo): AuthResult = route("auth.otp.verify") {
        val phone = check(challengeId, code)
        val isNew = knownPhones.add(phone)
        if (isNew) {
            startNewAccount()
            issue(AuthUser(NEW_ACCOUNT, AccountStatus.Onboarding, 0), isNew = true)
        } else {
            issue(AuthUser(SampleData.ME, AccountStatus.Active, 0), isNew = false)
        }
    }

    /** A fresh account: nothing set, nothing accepted, nowhere yet. */
    private fun startNewAccount() {
        profile = OwnProfile(id = NEW_ACCOUNT)
        preferences = DiscoveryPreferences()
        notifications = NotificationPrefs()
        location = AccountLocation()
        lastLocationAt = null
        consents.clear()
        uploads.clear()
        processingSince.clear()
        toReject.clear()
        uploadCount = 0
        reviewSince = null
        bumpMe()
    }

    // MARK: - The phone's side of sign-in, for the sample

    private var googleSignUps = 0

    override val available: Boolean get() = store == "play"

    /** The sample's Google account picker: every pick signs up a new account. */
    override suspend fun signIn(activity: android.app.Activity, nonce: String, silentFirst: Boolean): ExternalSignInResult {
        kotlinx.coroutines.delay(SHEET_MS)
        return ExternalSignInResult.Token("$NEW_GOOGLE_TOKEN.${++googleSignUps}.$nonce")
    }

    override suspend fun signOut() = Unit

    override fun appHash(context: android.content.Context): String = "SampleHash1"

    /** The text message "arrives" a few seconds after a code was sent, as the retriever would read it. */
    override fun codes(context: android.content.Context, length: Int): Flow<String> = kotlinx.coroutines.flow.flow {
        kotlinx.coroutines.delay(SMS_ARRIVES_MS)
        val sent = lock.withLock { lastOtpAt.values.maxOrNull() }
        if (sent != null && nowMs() - sent < OTP_TTL_MS) emit(SampleData.CODE.take(length))
    }

    override suspend fun googleNonce(): GoogleNonce = route("auth.google.nonce") {
        if (store != "play") fail(403, ProblemCodes.STORE_NOT_SUPPORTED)
        GoogleNonce("gn_" + nextId(), "n" + nextId(), 300)
    }

    override suspend fun signInWithGoogle(idToken: String, nonceId: String, device: DeviceInfo): AuthResult = route("auth.google") {
        if (store != "play") fail(403, ProblemCodes.STORE_NOT_SUPPORTED)
        if (idToken.isBlank()) fail(400, ProblemCodes.GOOGLE_TOKEN_INVALID)
        if (idToken.startsWith(NEW_GOOGLE_TOKEN)) {
            startNewAccount()
            issue(AuthUser(NEW_ACCOUNT, AccountStatus.Onboarding, 0), isNew = true)
        } else {
            issue(AuthUser(SampleData.ME, AccountStatus.Active, 0), isNew = false)
        }
    }

    override suspend fun logout(allSessions: Boolean) = route("auth.logout") {
        user()
        session = null
    }

    override suspend fun startPhoneChange(request: PhoneStartRequest): OtpChallenge = route("me.phone.start") {
        user()
        challenge(request.phone, request.channel)
    }

    override suspend fun verifyPhoneChange(challengeId: String, code: String) = route("me.phone.verify") {
        user()
        knownPhones += check(challengeId, code)
        Unit
    }

    // MARK: - Me

    /** The worker's part: photos processed a few seconds after upload, verification decided later. */
    private fun advanceBackground() {
        val due = processingSince.filterValues { nowMs() - it >= PROCESSING_MS }.keys
        if (due.isNotEmpty()) {
            profile = profile.copy(
                photos = profile.photos.map {
                    when {
                        it.id !in due -> it
                        it.id in toReject -> it.copy(status = PhotoStatus.Rejected, rejectReason = REJECT_REASON)
                        else -> it.copy(status = PhotoStatus.Approved, url = "https://media.example.com/p/${it.id}/1/640.webp")
                    }
                },
            )
            due.forEach { processingSince.remove(it) }
            bumpMe()
        }
        val waiting = reviewSince
        val current = session
        if (waiting != null && current?.status == AccountStatus.PendingReview && nowMs() - waiting >= REVIEW_MS) {
            session = current.copy(status = AccountStatus.Active)
            reviewSince = null
            bumpMe()
        }
        val submitted = verificationSubmittedAt
        if (submitted != null && nowMs() - submitted >= VERIFICATION_MS) {
            verification = VerificationState(VerificationStatus.Approved)
            verificationSubmittedAt = null
            profile = profile.copy(verified = true)
            bumpMe()
        }
    }

    private fun meNow(): Me {
        val me = user()
        if (me.status == AccountStatus.Deleted) {
            return Me(id = me.id, status = me.status, store = StoreName.fromWire(store), deletion = deletion)
        }
        return Me(
            id = me.id,
            status = me.status,
            onboardingStep = me.onboardingStep,
            store = StoreName.fromWire(store),
            billingRef = "br" + me.id.take(11),
            profile = profile,
            preferences = preferences,
            location = location,
            notifications = notifications,
            flags = mapOf("voice_prompts" to true, "message_requests" to true),
            moderation = moderation.filter { it.kind != ModerationKind.Warning && (it.endsAt == null || it.endsAt > now()) },
            deletion = deletion,
            consentsDue = LEGAL.filter { (consents[it] ?: 0) < 1 },
        )
    }

    override suspend fun me(): Fetched<Me> = route("me") {
        advanceBackground()
        val me = meNow()
        fetched("me:${me.id}", meVersion, me)
    }

    override suspend fun setBasics(birthDate: LocalDate, gender: Gender, consents: ConsentVersions): OwnProfile = route("me.basics") {
        val me = full()
        if (profile.birthDate != null) fail(409, ProblemCodes.ALREADY_SET)
        if (consents.terms < 1 || consents.privacy < 1) fail(403, ProblemCodes.CONSENT_REQUIRED, "kinds" to "terms,privacy")
        if (gender == Gender.Unknown) fail(422, ProblemCodes.FIELD_INVALID)
        val age = Period.between(birthDate, now().atOffset(ZoneOffset.UTC).toLocalDate()).years
        if (age < 18) {
            session = null
            fail(422, ProblemCodes.UNDER_AGE)
        }
        profile = profile.copy(birthDate = birthDate, gender = gender, age = age)
        this.consents[ConsentKind.Terms] = consents.terms
        this.consents[ConsentKind.Privacy] = consents.privacy
        consents.guidelines?.let { this.consents[ConsentKind.Guidelines] = it }
        session = me.copy(onboardingStep = maxOf(me.onboardingStep, 1))
        bumpMe()
        profile
    }

    override suspend fun consents(): List<ConsentRecord> = route("me.consents") {
        user()
        consents.map { (kind, version) -> ConsentRecord(kind, version, acceptedAt = now()) }
    }

    override suspend fun setConsent(kind: ConsentKind, version: Int, accepted: Boolean) = route("me.consents.set") {
        user()
        if (kind == ConsentKind.Unknown || version < 1) fail(422, ProblemCodes.FIELD_INVALID)
        if (accepted) consents[kind] = version else consents.remove(kind)
        bumpMe()
    }

    /**
     * `onboardingStep = DONE`: like the server, sign-up finishes only when
     * everything required is there; then the account is shown (or waits for
     * a review).
     */
    private fun finishOnboarding(me: AuthUser): AuthUser {
        val missing = buildList {
            if (profile.name.isBlank()) add("displayName")
            if (profile.birthDate == null || profile.gender == Gender.Unknown) add("basics")
            if (preferences.interestedIn.isEmpty()) add("interestedIn")
            if (profile.intention == null || profile.intention == Intention.Unknown) add("intention")
            if (profile.photos.count { it.status != PhotoStatus.Rejected } < LIMITS_PHOTOS_MIN) add("photos")
            if (location.city == null) add("location")
            if ((consents[ConsentKind.Guidelines] ?: 0) < 1) add("guidelines")
        }
        if (missing.isNotEmpty()) fail(422, ProblemCodes.FIELD_INVALID, "missing" to missing.joinToString(","))
        val next = if (waitlist) AccountStatus.PendingReview else AccountStatus.Active
        if (waitlist) reviewSince = nowMs()
        return me.copy(status = next, onboardingStep = OnboardingCodes.DONE)
    }

    override suspend fun updateProfile(patch: ProfilePatch): OwnProfile = route("me.profile") {
        val me = full()
        val about = patch.about
        if (about != null && about.length > LIMITS_ABOUT) fail(422, ProblemCodes.FIELD_INVALID)
        listOfNotNull(patch.displayName, patch.about, patch.jobTitle).plus(patch.prompts.orEmpty().mapNotNull { it.answer })
            .firstOrNull { refused(it) }?.let { fail(422, ProblemCodes.TEXT_REFUSED) }
        var next = profile.copy(
            name = patch.displayName ?: profile.name,
            about = patch.about ?: profile.about,
            job = patch.jobTitle ?: profile.job,
            intention = patch.intention ?: profile.intention,
            settings = patch.modeRomance?.let { profile.settings.copy(modeRomance = it) } ?: profile.settings,
        )
        patch.fields?.forEach { edit ->
            val rest = next.fields.filterNot { it.fieldId == edit.fieldId }
            val cleared = edit.option == null && edit.options == null && edit.number == null && edit.text == null
            next = next.copy(fields = if (cleared) rest else rest + ProfileFieldValue(edit.fieldId, edit.option, edit.options, edit.number, edit.text))
        }
        patch.prompts?.forEach { edit ->
            val rest = next.prompts.filterNot { it.position == edit.position }
            next = next.copy(prompts = if (edit.answer == null) rest else rest + OwnPrompt(edit.promptId, edit.position, edit.answer, status = TextState.Checking))
        }
        val textChanged = patch.about != null || patch.jobTitle != null || patch.displayName != null || patch.prompts != null
        profile = if (textChanged) next.copy(textState = TextState.Checking, v = next.v + 1) else next.copy(v = next.v + 1)
        patch.onboardingStep?.let { step ->
            session = if (step >= OnboardingCodes.DONE && me.status == AccountStatus.Onboarding) finishOnboarding(me) else me.copy(onboardingStep = step)
        }
        bumpMe()
        profile
    }

    override suspend fun updatePreferences(patch: PreferencesPatch): DiscoveryPreferences = route("me.preferences") {
        full()
        if (!patch.filters.isNullOrEmpty() && !currentEntitlements().features.advancedFilters) {
            fail(403, ProblemCodes.ENTITLEMENT_REQUIRED, "feature" to "advanced_filters")
        }
        val ageMin = patch.ageMin ?: preferences.ageMin
        val ageMax = patch.ageMax ?: preferences.ageMax
        if (ageMin < 18 || ageMax < ageMin) fail(422, ProblemCodes.FIELD_INVALID)
        preferences = preferences.copy(
            interestedIn = patch.interestedIn ?: preferences.interestedIn,
            ageMin = ageMin,
            ageMax = ageMax,
            maxDistanceKm = patch.maxDistanceKm ?: preferences.maxDistanceKm,
            wholeCountry = patch.wholeCountry ?: preferences.wholeCountry,
            verifiedOnly = patch.verifiedOnly ?: preferences.verifiedOnly,
            intents = patch.intents ?: preferences.intents,
            filters = patch.filters ?: preferences.filters,
        )
        refillDeck()
        bumpMe()
        preferences
    }

    override suspend fun updateSettings(patch: SettingsPatch): Settings = route("me.settings") {
        val me = full()
        if (patch.incognito == true && !currentEntitlements().features.incognito) {
            fail(403, ProblemCodes.ENTITLEMENT_REQUIRED, "feature" to "incognito")
        }
        val s = profile.settings
        val next = Settings(
            incognito = patch.incognito ?: s.incognito,
            hideAge = patch.hideAge ?: s.hideAge,
            hideDistance = patch.hideDistance ?: s.hideDistance,
            showOnline = patch.showOnline ?: s.showOnline,
            acceptCalls = patch.acceptCalls ?: s.acceptCalls,
            modeRomance = patch.modeRomance ?: s.modeRomance,
            snoozed = patch.snoozed ?: s.snoozed,
        )
        profile = profile.copy(settings = next)
        if (patch.snoozed != null && me.status in setOf(AccountStatus.Active, AccountStatus.Snoozed)) {
            session = me.copy(status = if (next.snoozed) AccountStatus.Snoozed else AccountStatus.Active)
        }
        bumpMe()
        next
    }

    override suspend fun updateNotifications(patch: NotificationPrefsPatch): NotificationPrefs = route("me.notifications") {
        full()
        notifications = NotificationPrefs(
            messages = patch.messages ?: notifications.messages,
            matches = patch.matches ?: notifications.matches,
            likes = patch.likes ?: notifications.likes,
            calls = patch.calls ?: notifications.calls,
            offers = patch.offers ?: notifications.offers,
            previews = patch.previews ?: notifications.previews,
        )
        bumpMe()
        notifications
    }

    override suspend fun updateLocation(update: LocationUpdate): LocationResult = route("me.location") {
        full()
        val last = lastLocationAt
        if (last != null && nowMs() - last < LOCATION_EVERY_MS) {
            fail(429, ProblemCodes.RATE_LIMITED, "retryAfterSeconds" to (LOCATION_EVERY_MS - (nowMs() - last) + 999) / 1000)
        }
        val lat = update.lat
        val lng = update.lng
        if (update.cityId == null && (lat == null || lng == null)) fail(422, ProblemCodes.FIELD_INVALID)
        lastLocationAt = nowMs()
        // Like the server: the position picks a city and is forgotten.
        val city = update.cityId?.let { id -> SampleData.cities.firstOrNull { it.id == id } ?: fail(422, ProblemCodes.FIELD_INVALID) }
            ?: SampleData.cityCentres.minByOrNull { (_, c) -> sq(c.first - lat!!) + sq(c.second - lng!!) }?.key?.let(SampleData::city)
        location = location.copy(city = city, country = city?.country)
        bumpMe()
        LocationResult(city, city?.country)
    }

    private fun sq(x: Double) = x * x

    override suspend fun cities(query: String, country: String?): List<City> = route("cities") {
        user()
        val q = query.trim()
        SampleData.cities.filter { (country == null || it.country == country) && (q.isEmpty() || it.name.contains(q, ignoreCase = true)) }
    }

    override suspend fun startPhotoUpload(position: Int, mime: PhotoMime, bytes: Long): PhotoUploadTicket = route("me.photos.start") {
        full()
        // An upload nobody completed holds its position for an hour, like the server's up:<photoId>.
        uploads.entries.removeAll { nowMs() - it.value.startedAt >= UPLOAD_TTL_MS }
        if (position !in 0 until LIMITS_PHOTOS) fail(422, ProblemCodes.FIELD_INVALID)
        if (profile.photos.size + uploads.size >= LIMITS_PHOTOS) fail(422, ProblemCodes.PHOTO_LIMIT)
        if (profile.photos.any { it.position == position } || uploads.values.any { it.position == position }) fail(409, ProblemCodes.POSITION_TAKEN)
        if (mime == PhotoMime.Unknown) fail(415, ProblemCodes.UNSUPPORTED_MEDIA_TYPE)
        if (bytes > MAX_PHOTO_BYTES || bytes <= 0) fail(413, ProblemCodes.PAYLOAD_TOO_LARGE)
        val id = nextId()
        uploads[id] = PendingUpload(position, nowMs())
        PhotoUploadTicket(
            id,
            UploadTarget(
                url = "https://uploads.example.com/u/$id?X-Amz-Signature=sample",
                method = "PUT",
                headers = mapOf("Content-Type" to mime.wire),
                expiresAt = now().plusSeconds(3600),
            ),
        )
    }

    /**
     * The presigned PUT, answered here instead of by storage: the bytes must
     * be a picture the size the ticket was asked for, sent before the ticket
     * expires.
     */
    override suspend fun put(target: UploadTarget, body: ByteArray, contentType: String, onProgress: (Float) -> Unit) {
        synchronized(_requestLog) { _requestLog += "sample.upload" }
        val id = target.url.substringAfter("/u/", "").substringBefore('?')
        // A slow uplink, in a few steps, so the progress ring has something to show.
        for (step in 1..UPLOAD_STEPS) {
            kotlinx.coroutines.delay(UPLOAD_STEP_MS)
            onProgress(step.toFloat() / UPLOAD_STEPS)
        }
        lock.withLock {
            val upload = uploads[id] ?: throw ApiError.Http(403, Problem(status = 403, code = null))
            if (target.expiresAt != null && now() > target.expiresAt) throw ApiError.Http(403, Problem(status = 403, code = null))
            if (body.isEmpty() || !contentType.startsWith("image/")) throw ApiError.Http(400, Problem(status = 400, code = null))
            upload.uploaded = true
        }
    }

    override suspend fun completePhotoUpload(photoId: Id): PhotoProcessing = route("me.photos.complete") {
        full()
        profile.photos.firstOrNull { it.id == photoId }?.let { return@route PhotoProcessing(it.id, it.position, it.status) }
        val upload = uploads[photoId] ?: fail(404, ProblemCodes.NOT_FOUND)
        if (!upload.uploaded) fail(422, ProblemCodes.UPLOAD_MISSING)
        uploads.remove(photoId)
        profile = profile.copy(photos = profile.photos + OwnPhoto(photoId, upload.position, PhotoStatus.Processing))
        processingSince[photoId] = nowMs()
        // Every fourth photo is "refused by moderation", so the refused state can be seen.
        if (++uploadCount % REJECT_EVERY == 0) toReject += photoId
        bumpMe()
        PhotoProcessing(photoId, upload.position, PhotoStatus.Processing)
    }

    override suspend fun reorderPhotos(photoIds: List<Id>): OwnProfile = route("me.photos.order") {
        full()
        if (photoIds.toSet() != profile.photos.map { it.id }.toSet() || photoIds.size != profile.photos.size) {
            fail(422, ProblemCodes.FIELD_INVALID)
        }
        val byId = profile.photos.associateBy { it.id }
        profile = profile.copy(photos = photoIds.mapIndexed { index, id -> byId.getValue(id).copy(position = index) })
        bumpMe()
        profile
    }

    override suspend fun deletePhoto(photoId: Id) = route("me.photos.delete") {
        full()
        if (profile.photos.none { it.id == photoId }) fail(404, ProblemCodes.NOT_FOUND)
        // During sign-up photos come and go freely; a shown profile keeps the minimum.
        if (user().status != AccountStatus.Onboarding && profile.photos.size <= LIMITS_PHOTOS_MIN) fail(422, ProblemCodes.PHOTO_MIN)
        profile = profile.copy(photos = profile.photos.filterNot { it.id == photoId })
        processingSince.remove(photoId)
        toReject.remove(photoId)
        bumpMe()
    }

    override suspend fun profile(id: PublicUid): ProfileCard = route("profiles.get") {
        active(snoozedOk = true)
        visible(id) ?: fail(404, ProblemCodes.NOT_FOUND)
    }

    override suspend fun startVerification(): VerificationSession = route("verification.start") {
        full()
        VerificationSession(nextId(), provider = "sample", expiresAt = now().plusSeconds(600), params = mapOf("mode" to "selfie"))
    }

    override suspend fun submitVerification(sessionId: Id): VerificationState = route("verification.submit") {
        full()
        verification = VerificationState(VerificationStatus.Pending)
        verificationSubmittedAt = nowMs()
        verification
    }

    override suspend fun verificationStatus(): VerificationState = route("verification.status") {
        full()
        advanceBackground()
        verification
    }

    // MARK: - Devices

    override suspend fun updateDevice(update: DeviceUpdate) = route("devices.current") {
        user()
        device = update
    }

    // MARK: - Deck and swipes

    override suspend fun deck(limit: Int): DeckPage = route("deck") {
        active()
        val ids = deckQueue.filter { it !in blocked && it !in swiped }
        val cards = ids.take(limit.coerceIn(1, 50)).mapNotNull(SampleData::person)
        val remaining = (ids.size - cards.size).coerceAtLeast(0)
        val exhausted = ids.size <= cards.size
        DeckPage(
            cards = cards,
            remaining = remaining,
            exhausted = exhausted,
            suggestions = if (exhausted) listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge, DeckSuggestion.Boost) else emptyList(),
        )
    }

    override suspend fun swipe(swipes: List<Swipe>): SwipesResult = route("swipes") {
        active()
        if (swipes.size !in 1..HttpServerApi.MAX_SWIPES) fail(422, ProblemCodes.FIELD_INVALID)
        swipes.firstOrNull { (it.comment?.length ?: 0) > LIMITS_COMMENT }?.let { fail(422, ProblemCodes.FIELD_INVALID) }
        swipes.firstOrNull { it.comment != null && refused(it.comment) }?.let { fail(422, ProblemCodes.TEXT_REFUSED) }
        val results = swipes.map { swipe -> SwipeResult(swipe.target, outcome(swipe)).withConversation(swipe) }
        SwipesResult(results, currentEntitlements().quotas)
    }

    private fun outcome(swipe: Swipe): SwipeOutcome {
        val card = visible(swipe.target) ?: return SwipeOutcome.Skipped
        if (swipe.target in swiped) return SwipeOutcome.Duplicate
        val q = entitlements.quotas
        when (swipe.action) {
            SwipeAction.Pass -> {
                swiped += card.id
                deckQueue.remove(card.id)
                return SwipeOutcome.Passed
            }
            SwipeAction.Like -> {
                val likes = q.likes
                if (likes != null && !likes.unlimited && likes.left == 0) return SwipeOutcome.Quota
                entitlements = entitlements.copy(quotas = q.copy(likes = likes?.copy(used = likes.used + 1)))
            }
            SwipeAction.Superlike -> {
                val superlikes = q.superlikes
                when {
                    superlikes != null && (superlikes.unlimited || superlikes.left > 0) ->
                        entitlements = entitlements.copy(quotas = q.copy(superlikes = superlikes.copy(used = superlikes.used + 1)))
                    entitlements.wallet.superlike > 0 ->
                        entitlements = entitlements.copy(wallet = entitlements.wallet.copy(superlike = entitlements.wallet.superlike - 1))
                    else -> return SwipeOutcome.Quota
                }
            }
            SwipeAction.Unknown -> return SwipeOutcome.Skipped
        }
        bumpEntitlements()
        swiped += card.id
        deckQueue.remove(card.id)
        return if (card.likesYou) SwipeOutcome.Matched else SwipeOutcome.Liked
    }

    private fun SwipeResult.withConversation(swipe: Swipe): SwipeResult {
        if (result != SwipeOutcome.Matched) return this
        val card = SampleData.person(target) ?: return this
        val id = nextId()
        val source = when {
            swipe.action == SwipeAction.Superlike -> ConversationSource.SuperLike
            swipe.item != null -> ConversationSource.ItemLike
            else -> ConversationSource.Like
        }
        val thread = Thread(
            Conversation(
                id = id,
                peer = ConversationPeer(card.id, card.name, card.photos.firstOrNull(), card.verified, activeRecently = card.activeRecently),
                state = ConversationState.Active,
                source = source,
                createdAt = now(),
            ),
            mutableListOf(),
        )
        swipe.comment?.takeIf { it.isNotBlank() }?.let { comment ->
            thread.messages += Message(nextId(), id, user().id, kind = MessageKind.LikeNote, body = comment, at = now())
        }
        thread.conversation = thread.conversation.copy(lastMessage = thread.messages.lastOrNull())
        threads[id] = thread
        bumpConversations()
        channel.publish(RealtimeTypes.CONVERSATION, id, ConversationEvent.serializer(), ConversationEvent(thread.conversation, ConversationChange.Matched))
        return copy(conversation = thread.conversation)
    }

    // MARK: - Likes

    override suspend fun likes(cursor: String?, limit: Int): LikesPage = route("likes") {
        active()
        val seeLikes = currentEntitlements().features.seeLikes
        val likers = SampleData.people.filter { it.likesYou && it.id !in swiped && it.id !in blocked }
        val start = cursor?.removePrefix("c")?.toIntOrNull() ?: 0
        val page = likers.drop(start).take(limit.coerceIn(1, 50))
        val items = page.mapIndexed { index, card ->
            val superlike = (start + index) == 0
            val shown = seeLikes || superlike
            LikeItem(
                liker = if (shown) card else null,
                blurhash = card.photos.firstOrNull()?.blurhash,
                kind = if (superlike) LikeKind.Superlike else LikeKind.Like,
                item = if (superlike) card.photos.firstOrNull()?.let { LikedItem(app.core.model.ItemKind.Photo, it.id) } else null,
                comment = if (shown && superlike) "Your map collection is great!" else null,
            )
        }
        val next = (start + page.size).takeIf { it < likers.size }?.let { "c$it" }
        LikesPage(total = likers.size, items = items, nextCursor = next)
    }

    // MARK: - Conversations and messages

    private fun liveThread(conversationId: Id): Thread {
        val thread = threads[conversationId] ?: fail(404, ProblemCodes.NOT_FOUND)
        if (thread.conversation.peer.id in blocked) fail(404, ProblemCodes.NOT_FOUND)
        return thread
    }

    override suspend fun conversations(cursor: String?, limit: Int): Fetched<ConversationsPage> = route("conversations") {
        active(snoozedOk = true)
        val sorted = threads.values
            .filter { it.conversation.peer.id !in blocked }
            .map { it.conversation }
            .sortedByDescending { it.lastMessage?.at ?: it.createdAt }
        val start = cursor?.removePrefix("c")?.toIntOrNull() ?: 0
        val page = sorted.drop(start).take(limit.coerceIn(1, 100))
        val next = (start + page.size).takeIf { it < sorted.size }?.let { "c$it" }
        val value = ConversationsPage(page, next)
        if (cursor == null) fetched("conversations:$limit", conversationsVersion, value) else Fetched(value, changed = true)
    }

    private fun page(thread: Thread, items: List<Message>, hasMore: Boolean) = MessagesPage(
        items = items,
        hasMore = hasMore,
        // Everything here is durable at once: the cursor is the newest id returned.
        syncCursor = items.lastOrNull()?.id ?: thread.messages.lastOrNull()?.id,
        readCursors = ReadCursors(me = thread.conversation.myReadId, peer = thread.conversation.peerReadId),
        peerDeliveredId = thread.conversation.peerDeliveredId,
        writeLagMs = 0,
    )

    override suspend fun messagesBefore(conversationId: Id, before: Id?, limit: Int): MessagesPage = route("conversations.messages") {
        active(snoozedOk = true)
        val thread = liveThread(conversationId)
        val older = thread.messages.filter { before == null || it.id.toLong() < before.toLong() }
        val items = older.takeLast(limit.coerceIn(1, 100))
        page(thread, items, hasMore = older.size > items.size)
    }

    override suspend fun messagesAfter(conversationId: Id, after: Id, limit: Int): MessagesPage = route("conversations.messages") {
        active(snoozedOk = true)
        val thread = liveThread(conversationId)
        val newer = thread.messages.filter { it.id.toLong() > after.toLong() }
        val items = newer.take(limit.coerceIn(1, 200))
        page(thread, items, hasMore = newer.size > items.size)
    }

    override suspend fun sendMessage(conversationId: Id, request: SendMessageRequest): SentMessage = route("conversations.send") {
        val me = active(snoozedOk = true)
        sentByClientId[request.clientId]?.let { return@route SentMessage(it, replayed = true) }
        val thread = liveThread(conversationId)
        if (thread.conversation.state == ConversationState.Ended) fail(410, ProblemCodes.CONVERSATION_ENDED)
        val body = request.body
        when (request.kind) {
            MessageKind.Text, MessageKind.Gif -> if (body.isNullOrBlank()) fail(422, ProblemCodes.FIELD_INVALID)
            MessageKind.Reaction, MessageKind.Unsend -> {
                val target = thread.messages.firstOrNull { it.id == request.refId } ?: fail(404, ProblemCodes.NOT_FOUND)
                if (request.kind == MessageKind.Unsend && target.senderId != me.id) fail(404, ProblemCodes.NOT_FOUND)
            }
            else -> fail(422, ProblemCodes.FIELD_INVALID)
        }
        if ((body?.length ?: 0) > LIMITS_MESSAGE) fail(422, ProblemCodes.FIELD_INVALID)
        if (body != null && refused(body)) fail(422, ProblemCodes.MESSAGE_REFUSED)
        if (body != null && CAUTION.any { body.contains(it, ignoreCase = true) } && request.confirm != CONFIRM_TOKEN) {
            fail(409, ProblemCodes.CONFIRM_REQUIRED, "confirmToken" to CONFIRM_TOKEN, "category" to "money")
        }
        val message = Message(
            id = nextId(), conversationId = conversationId, senderId = me.id, clientId = request.clientId,
            kind = request.kind, body = body, refId = request.refId, at = now(),
        )
        thread.messages += message
        sentByClientId[request.clientId] = message
        thread.conversation = thread.conversation.copy(lastMessage = message, myReadId = message.id)
        bumpConversations()
        channel.publish(RealtimeTypes.MESSAGE, message.id, Message.serializer(), message)
        if (message.kind == MessageKind.Text || message.kind == MessageKind.Gif) channel.mine(message)
        SentMessage(message, replayed = false)
    }

    override suspend fun sendReceipts(conversationId: Id, receipts: ReceiptsRequest) = route("conversations.receipts") {
        active(snoozedOk = true)
        val thread = liveThread(conversationId)
        val readUpTo = receipts.readUpTo
        if (readUpTo != null) {
            val current = thread.conversation.myReadId?.toLong() ?: 0
            if (readUpTo.toLong() > current) {
                val unread = thread.messages.count { it.senderId != SampleData.ME && it.id.toLong() > readUpTo.toLong() }
                thread.conversation = thread.conversation.copy(myReadId = readUpTo, unread = unread)
                bumpConversations()
                channel.publish(RealtimeTypes.RECEIPT, nextId(), ReceiptEvent.serializer(), ReceiptEvent(conversationId, SampleData.ME, readUpTo = readUpTo))
            }
        }
    }

    override suspend fun sendTyping(conversationId: Id) = route("conversations.typing") {
        active(snoozedOk = true)
        liveThread(conversationId)
        Unit
    }

    override suspend fun updateConversation(conversationId: Id, patch: ConversationPatch): Conversation = route("conversations.update") {
        active(snoozedOk = true)
        val thread = liveThread(conversationId)
        val c = thread.conversation
        thread.conversation = c.copy(
            callsAllowed = patch.allowCalls?.let { c.callsAllowed.copy(me = it) } ?: c.callsAllowed,
            muted = patch.muted ?: c.muted,
        )
        bumpConversations()
        channel.publish(RealtimeTypes.CONVERSATION, nextId(), ConversationEvent.serializer(), ConversationEvent(thread.conversation, ConversationChange.Updated))
        thread.conversation
    }

    override suspend fun unmatch(conversationId: Id) = route("conversations.unmatch") {
        active(snoozedOk = true)
        liveThread(conversationId)
        threads.remove(conversationId)
        bumpConversations()
        channel.publish(RealtimeTypes.CONVERSATION_END, nextId(), ConversationEndEvent.serializer(), ConversationEndEvent(conversationId))
    }

    // MARK: - Message requests

    override suspend fun sendMessageRequest(to: PublicUid, body: String, clientId: String): SentRequest = route("requests.send") {
        active(snoozedOk = true)
        requestByClientId[clientId]?.let { return@route it }
        val card = visible(to) ?: fail(404, ProblemCodes.NOT_FOUND)
        if (threads.values.any { it.conversation.peer.id == to }) fail(409, ProblemCodes.ALREADY_MATCHED)
        if (requests.any { (box, r) -> box == RequestBox.Sent && r.peer.id == to && r.status == RequestStatus.Pending }) {
            fail(409, ProblemCodes.ALREADY_REQUESTED)
        }
        if (refused(body)) fail(422, ProblemCodes.TEXT_REFUSED)
        val dm = entitlements.quotas.dm
        when {
            dm != null && (dm.unlimited || dm.left > 0) -> entitlements = entitlements.copy(quotas = entitlements.quotas.copy(dm = dm.copy(used = dm.used + 1)))
            entitlements.wallet.dm > 0 -> entitlements = entitlements.copy(wallet = entitlements.wallet.copy(dm = entitlements.wallet.dm - 1))
            else -> fail(429, ProblemCodes.QUOTA_EXCEEDED, "feature" to "dm", "resetsAt" to nextMidnight(), "canBuy" to true)
        }
        bumpEntitlements()
        val sent = SentRequest(nextId(), summary(card), body, RequestStatus.Pending, now())
        requests += RequestBox.Sent to MessageRequest(sent.id, sent.to, body, RequestStatus.Pending, sent.at)
        requestByClientId[clientId] = sent
        sent
    }

    override suspend fun messageRequests(box: RequestBox, cursor: String?): MessageRequestsPage = route("requests") {
        active(snoozedOk = true)
        MessageRequestsPage(
            items = requests.filter { (b, r) -> b == box && r.peer.id !in blocked && r.status == RequestStatus.Pending }.map { it.second },
            nextCursor = null,
        )
    }

    override suspend fun acceptMessageRequest(requestId: Id): Conversation = route("requests.accept") {
        active(snoozedOk = true)
        val index = requests.indexOfFirst { (b, r) -> b == RequestBox.Inbox && r.id == requestId && r.status == RequestStatus.Pending }
        if (index < 0) fail(404, ProblemCodes.NOT_FOUND)
        val request = requests[index].second
        requests[index] = RequestBox.Inbox to request.copy(status = RequestStatus.Accepted)
        val id = nextId()
        val first = Message(nextId(), id, request.peer.id, kind = MessageKind.Text, body = request.body, at = request.at)
        val conversation = Conversation(
            id = id,
            peer = ConversationPeer(request.peer.id, request.peer.name, request.peer.photo, request.peer.verified),
            state = ConversationState.Active,
            source = ConversationSource.Request,
            createdAt = now(),
            lastMessage = first,
            unread = 1,
        )
        threads[id] = Thread(conversation, mutableListOf(first))
        swiped += request.peer.id
        bumpConversations()
        channel.publish(RealtimeTypes.CONVERSATION, nextId(), ConversationEvent.serializer(), ConversationEvent(conversation, ConversationChange.Accepted))
        conversation
    }

    override suspend fun declineMessageRequest(requestId: Id) = route("requests.decline") {
        active(snoozedOk = true)
        val index = requests.indexOfFirst { (b, r) -> b == RequestBox.Inbox && r.id == requestId }
        if (index < 0) fail(404, ProblemCodes.NOT_FOUND)
        requests[index] = RequestBox.Inbox to requests[index].second.copy(status = RequestStatus.Declined)
    }

    override suspend fun withdrawMessageRequest(requestId: Id) = route("requests.withdraw") {
        active(snoozedOk = true)
        val index = requests.indexOfFirst { (b, r) -> b == RequestBox.Sent && r.id == requestId }
        if (index < 0) fail(404, ProblemCodes.NOT_FOUND)
        requests[index] = RequestBox.Sent to requests[index].second.copy(status = RequestStatus.Withdrawn)
    }

    // MARK: - Calls

    /** Moves a call along the clock: the other side answers after [answerAfterMs], a ring lapses after 45 s. */
    private fun advance(call: Call): Call {
        if (call.state != CallState.Ringing) return call
        val elapsed = nowMs() - call.placedAt.toEpochMilli()
        val answerAfter = answerAfterMs
        val next = when {
            call.role == CallRole.Caller && answerAfter != null && elapsed >= answerAfter && elapsed < RING_SECONDS * 1000 ->
                call.copy(state = CallState.Active, rangAt = call.placedAt.plusMillis(500), answeredAt = call.placedAt.plusMillis(answerAfter))
            elapsed >= RING_SECONDS * 1000 ->
                finish(call.copy(state = CallState.Missed, outcome = CallOutcome.Missed, endedAt = call.ringExpiresAt, durationSeconds = 0, endReason = "ring_timeout"))
            else -> call
        }
        calls[call.id] = next
        return next
    }

    /** The call line in the chat, written once when a call ends. */
    private fun finish(call: Call): Call {
        val thread = threads[call.conversationId] ?: return call
        if (thread.messages.any { it.call?.callId == call.id }) return call
        val caller = if (call.role == CallRole.Caller) SampleData.ME else thread.conversation.peer.id
        val line = CallLine(call.id, call.kind, call.outcome ?: CallOutcome.Unknown, call.placedAt, call.durationSeconds ?: 0, caller)
        val message = Message(nextId(), call.conversationId, caller, kind = MessageKind.Call, call = line, at = call.endedAt ?: now())
        thread.messages += message
        thread.conversation = thread.conversation.copy(lastMessage = message)
        bumpConversations()
        channel.publish(RealtimeTypes.MESSAGE, message.id, Message.serializer(), message)
        return call
    }

    private fun liveCall(callId: Id): Call {
        val call = calls[callId]?.let(::advance) ?: fail(404, ProblemCodes.NOT_FOUND)
        return call
    }

    override suspend fun placeCall(conversationId: Id, kind: CallKind): Call = route("calls.place") {
        active(snoozedOk = true)
        val thread = liveThread(conversationId)
        if (thread.conversation.state != ConversationState.Active) fail(404, ProblemCodes.NOT_FOUND)
        if (kind == CallKind.Unknown) fail(422, ProblemCodes.FIELD_INVALID)
        if (!thread.conversation.callsAllowed.both || !profile.settings.acceptCalls) fail(403, ProblemCodes.CALLS_NOT_ALLOWED, "reason" to "consent")
        calls.values.map(::advance)
        if (calls.values.any { it.state.isLive }) fail(409, ProblemCodes.CALLER_BUSY)
        val call = Call(
            id = nextId(), conversationId = conversationId, kind = kind, role = CallRole.Caller, state = CallState.Ringing,
            placedAt = now(), ringExpiresAt = now().plusSeconds(RING_SECONDS),
        )
        calls[call.id] = call
        call
    }

    override suspend fun call(callId: Id): Call = route("calls.get") {
        user()
        liveCall(callId)
    }

    override suspend fun callRang(callId: Id) = route("calls.rang") {
        user()
        val call = liveCall(callId)
        if (call.role != CallRole.Callee || call.state != CallState.Ringing) fail(409, ProblemCodes.NOT_RINGING)
        calls[callId] = call.copy(rangAt = call.rangAt ?: now())
    }

    private fun token(call: Call) = CallToken(
        token = "sample.room.${call.id}",
        expiresAt = now().plusSeconds(600),
        wsUrl = "wss://rtc.example.com",
        turn = null,
        icePolicy = IcePolicy.All,
    )

    override suspend fun acceptCall(callId: Id): CallAcceptance = route("calls.accept") {
        user()
        val call = liveCall(callId)
        if (call.role != CallRole.Callee) fail(409, ProblemCodes.NOT_RINGING)
        if (call.state != CallState.Ringing) fail(409, if (call.answeredAt != null) ProblemCodes.ANSWERED_ELSEWHERE else ProblemCodes.NOT_RINGING)
        val next = call.copy(state = CallState.Connecting, answeredAt = now())
        calls[callId] = next
        CallAcceptance(next, token(next))
    }

    private fun end(call: Call, outcome: CallOutcome, state: CallState, reason: String): Call {
        val answered = call.answeredAt
        val duration = if (answered != null) Duration.between(answered, now()).seconds.coerceAtLeast(0) else 0
        val next = call.copy(state = state, outcome = outcome, endedAt = now(), durationSeconds = duration, endReason = reason)
        calls[call.id] = next
        return finish(next)
    }

    override suspend fun declineCall(callId: Id): Call = route("calls.decline") {
        user()
        val call = liveCall(callId)
        if (call.role != CallRole.Callee || call.state != CallState.Ringing) fail(409, ProblemCodes.NOT_RINGING)
        end(call, CallOutcome.Declined, CallState.Ended, "declined")
    }

    override suspend fun cancelCall(callId: Id): Call = route("calls.cancel") {
        user()
        val call = liveCall(callId)
        if (call.role != CallRole.Caller || call.state != CallState.Ringing) fail(409, ProblemCodes.NOT_RINGING)
        end(call, CallOutcome.Cancelled, CallState.Cancelled, "cancelled")
    }

    override suspend fun endCall(callId: Id): Call = route("calls.end") {
        user()
        val call = liveCall(callId)
        when {
            !call.state.isLive -> call
            call.state == CallState.Ringing && call.role == CallRole.Caller -> end(call, CallOutcome.Cancelled, CallState.Cancelled, "cancelled")
            call.state == CallState.Ringing -> end(call, CallOutcome.Declined, CallState.Ended, "declined")
            else -> end(call, CallOutcome.Completed, CallState.Ended, "hangup")
        }
    }

    override suspend fun callToken(callId: Id): CallToken = route("calls.token") {
        user()
        val call = liveCall(callId)
        if (call.state != CallState.Connecting && call.state != CallState.Active) fail(409, ProblemCodes.CALL_NOT_LIVE)
        token(call)
    }

    // MARK: - Safety

    override suspend fun report(request: ReportRequest): Id = route("reports") {
        user()
        if (SampleData.person(request.target) == null) fail(404, ProblemCodes.NOT_FOUND)
        if ((request.messageIds?.size ?: 0) > 20) fail(422, ProblemCodes.FIELD_INVALID)
        if (request.block) blockNow(request.target)
        nextId()
    }

    private fun blockNow(target: PublicUid) {
        if (target in blocked) return
        blocked[target] = now()
        threads.values.filter { it.conversation.peer.id == target }.forEach {
            channel.publish(RealtimeTypes.CONVERSATION_END, nextId(), ConversationEndEvent.serializer(), ConversationEndEvent(it.conversation.id))
        }
        threads.entries.removeAll { it.value.conversation.peer.id == target }
        deckQueue.remove(target)
        bumpConversations()
    }

    override suspend fun block(target: PublicUid) = route("blocks.add") {
        user()
        if (SampleData.person(target) == null) fail(404, ProblemCodes.NOT_FOUND)
        blockNow(target)
    }

    override suspend fun blocks(): BlockList = route("blocks") {
        user()
        BlockList(blocked.mapNotNull { (id, at) -> SampleData.person(id)?.let { BlockedUser(summary(it), at) } })
    }

    override suspend fun unblock(target: PublicUid) = route("blocks.remove") {
        user()
        // The pair stays out of each other's deck: one match row per pair, for ever.
        blocked.remove(target)
        swiped += target
        Unit
    }

    override suspend fun moderation(): ModerationHistory = route("me.moderation") {
        user()
        val withAppeals = moderation.map { action -> appeals[action.id]?.let { action.copy(appeal = it) } ?: action }
        val live = withAppeals.filter { it.kind != ModerationKind.Warning && (it.endsAt == null || it.endsAt > now()) }
        ModerationHistory(active = live, history = withAppeals - live.toSet())
    }

    override suspend fun appeal(actionId: Id, body: String): Appeal = route("appeals") {
        user()
        val action = moderation.firstOrNull { it.id == actionId } ?: fail(404, ProblemCodes.NOT_FOUND)
        if (action.kind == ModerationKind.Warning) fail(422, ProblemCodes.NOT_APPEALABLE)
        if (appeals[actionId]?.status == AppealStatus.Open) fail(409, ProblemCodes.APPEAL_OPEN)
        if (body.isBlank()) fail(422, ProblemCodes.FIELD_INVALID)
        Appeal(nextId(), AppealStatus.Open).also { appeals[actionId] = it }
    }

    // MARK: - Store

    override suspend fun products(): StoreProducts = route("store.products") {
        val me = user()
        StoreProducts(StoreName.fromWire(store), "br" + me.id.take(11), SampleData.subscriptions(store), SampleData.consumables)
    }

    private fun grant(productId: String, purchaseToken: String, kind: PurchaseKind): PurchaseResult {
        purchases[purchaseToken]?.let { return it }
        if (purchaseToken.startsWith("pending")) return PurchaseResult(PurchaseRecord(state = PurchaseRecord.PENDING, productId = productId))
        val subscription = SampleData.subscriptions(store).firstOrNull { it.productId == productId || "${it.productId}:${it.basePlanId}" == productId }
        val consumable = SampleData.consumables.firstOrNull { it.productId == productId }
        val expires: Instant?
        when {
            kind == PurchaseKind.Subscription && subscription != null -> {
                expires = now().plus(
                    when (subscription.period) {
                        app.core.model.BillingPeriod.Week -> Duration.ofDays(7)
                        app.core.model.BillingPeriod.Month -> Duration.ofDays(30)
                        app.core.model.BillingPeriod.ThreeMonths -> Duration.ofDays(90)
                        app.core.model.BillingPeriod.SixMonths -> Duration.ofDays(180)
                        else -> Duration.ofDays(365)
                    },
                )
                val premium = subscription.plan == Plan.Premium
                val unlimited = Quota(limit = -1)
                entitlements = entitlements.copy(
                    plan = subscription.plan,
                    planExpiresAt = expires,
                    autoRenew = true,
                    source = if (store == "play") EntitlementSource.Play else EntitlementSource.Bazaar,
                    // The server names the store's own page; the sample stays neutral.
                    manageUrl = "https://example.com/account/subscriptions",
                    features = if (premium) premiumFeatures() else plusFeatures(),
                    quotas = entitlements.quotas.copy(likes = unlimited, superlikes = Quota(limit = if (premium) 5 else 3), boosts = Quota(limit = if (premium) 2 else 1)),
                )
            }
            kind == PurchaseKind.Consumable && consumable != null -> {
                expires = null
                val w = entitlements.wallet
                entitlements = entitlements.copy(
                    wallet = when (consumable.item) {
                        app.core.model.WalletItem.Superlike -> w.copy(superlike = w.superlike + consumable.quantity)
                        app.core.model.WalletItem.Boost -> w.copy(boost = w.boost + consumable.quantity)
                        app.core.model.WalletItem.Spotlight -> w.copy(spotlight = w.spotlight + consumable.quantity)
                        app.core.model.WalletItem.Dm -> w.copy(dm = w.dm + consumable.quantity)
                        app.core.model.WalletItem.Unknown -> w
                    },
                )
            }
            else -> fail(422, ProblemCodes.PURCHASE_INVALID)
        }
        bumpEntitlements()
        return PurchaseResult(PurchaseRecord(nextId(), "granted", productId, expires), currentEntitlements()).also { purchases[purchaseToken] = it }
    }

    override suspend fun verifyPlayPurchase(request: PlayPurchaseRequest): PurchaseResult = route("store.play.purchase") {
        user()
        if (store != "play") fail(403, ProblemCodes.STORE_NOT_SUPPORTED)
        grant(request.productId, request.purchaseToken, request.kind)
    }

    override suspend fun verifyBazaarPurchase(request: BazaarPurchaseRequest): PurchaseResult = route("store.bazaar.purchase") {
        user()
        if (store != "bazaar") fail(403, ProblemCodes.STORE_NOT_SUPPORTED)
        if (request.signature.isBlank() || request.originalJson.isBlank()) fail(422, ProblemCodes.PURCHASE_INVALID)
        grant(request.productId, request.purchaseToken, request.kind)
    }

    override suspend fun restorePurchases(purchases: List<RestorePurchase>): RestoreResult = route("store.restore") {
        user()
        if (purchases.size > HttpServerApi.MAX_RESTORE) fail(422, ProblemCodes.FIELD_INVALID)
        val results = purchases.map { p ->
            val state = runCatching { grant(p.productId, p.purchaseToken, p.kind).purchase.state }.getOrElse { "invalid" }
            RestoredPurchase(p.purchaseToken, state)
        }
        RestoreResult(results, currentEntitlements())
    }

    override suspend fun entitlements(): Fetched<Entitlements> = route("me.entitlements") {
        val me = user()
        fetched("entitlements:${me.id}", entitlementsVersion, currentEntitlements())
    }

    override suspend fun boost(kind: BoostKind): BoostStarted = route("boosts") {
        active()
        val boosts = entitlements.quotas.boosts
        when {
            kind == BoostKind.Unknown -> fail(422, ProblemCodes.FIELD_INVALID)
            kind == BoostKind.Boost && boosts != null && (boosts.unlimited || boosts.left > 0) ->
                entitlements = entitlements.copy(quotas = entitlements.quotas.copy(boosts = boosts.copy(used = boosts.used + 1)))
            kind == BoostKind.Boost && entitlements.wallet.boost > 0 ->
                entitlements = entitlements.copy(wallet = entitlements.wallet.copy(boost = entitlements.wallet.boost - 1))
            kind == BoostKind.Spotlight && entitlements.wallet.spotlight > 0 ->
                entitlements = entitlements.copy(wallet = entitlements.wallet.copy(spotlight = entitlements.wallet.spotlight - 1))
            else -> fail(429, ProblemCodes.QUOTA_EXCEEDED, "feature" to "boosts", "canBuy" to true)
        }
        val ends = now().plus(Duration.ofMinutes(30))
        entitlements = entitlements.copy(boostEndsAt = ends)
        bumpEntitlements()
        BoostStarted(ends)
    }

    // MARK: - Realtime

    override suspend fun realtimeToken(): RealtimeToken = route("realtime.token") {
        val me = full()
        RealtimeToken("wss://rt.example.com/connection/websocket", "sample.rt.${nextId()}", now().plusSeconds(3600), "u:#${me.id}")
    }

    /** The in-memory Centrifugo (see [SampleRealtime]); the address is not dialled. */
    override suspend fun open(url: String): RealtimeSocket = realtime.open(url)

    // The other person in a sample conversation, for a chat that answers.

    override suspend fun peerDelivered(conversationId: Id, upTo: Id) = lock.withLock {
        val thread = threads[conversationId] ?: return@withLock
        val peer = thread.conversation.peer.id
        thread.conversation = thread.conversation.copy(peerDeliveredId = upTo)
        channel.publish(RealtimeTypes.RECEIPT, nextId(), ReceiptEvent.serializer(), ReceiptEvent(conversationId, peer, deliveredUpTo = upTo))
    }

    override suspend fun peerRead(conversationId: Id, upTo: Id) = lock.withLock {
        val thread = threads[conversationId] ?: return@withLock
        val peer = thread.conversation.peer.id
        // Read receipts reach this account only with the feature (as the server rules it).
        if (!currentEntitlements().features.readReceipts) return@withLock
        thread.conversation = thread.conversation.copy(peerReadId = upTo)
        channel.publish(RealtimeTypes.RECEIPT, nextId(), ReceiptEvent.serializer(), ReceiptEvent(conversationId, peer, readUpTo = upTo))
    }

    override suspend fun peerTyping(conversationId: Id) = lock.withLock {
        val thread = threads[conversationId] ?: return@withLock
        channel.publish(RealtimeTypes.TYPING, nextId(), TypingEvent.serializer(), TypingEvent(conversationId, thread.conversation.peer.id), ephemeral = true)
    }

    override suspend fun peerSays(conversationId: Id): Boolean = lock.withLock {
        val thread = threads[conversationId] ?: return@withLock false
        if (thread.conversation.state != ConversationState.Active) return@withLock false
        val peer = thread.conversation.peer.id
        val theirs = thread.messages.lastOrNull { it.senderId == peer }?.body.orEmpty()
        val replies = when {
            theirs.any { it in '\u0600'..'\u06FF' } -> listOf("چه جالب! 😊", "منم همین‌طور فکر می‌کنم", "آره، حتماً!")
            theirs.any { it in "ğüşıöçĞÜŞİÖÇ" } -> listOf("Harika! 😊", "Bence de", "Olur, neden olmasın!")
            else -> listOf("Ha, love that 😊", "Same here!", "Sounds good to me")
        }
        val message = Message(nextId(), conversationId, peer, kind = MessageKind.Text, body = replies[thread.messages.size % replies.size], at = now())
        thread.messages += message
        thread.conversation = thread.conversation.copy(lastMessage = message, unread = thread.conversation.unread + 1)
        bumpConversations()
        channel.publish(RealtimeTypes.MESSAGE, message.id, Message.serializer(), message)
        true
    }

    // MARK: - Deletion

    override suspend fun deletionPreflight(): DeletionPreflight = route("me.deletion.preflight") {
        user()
        val e = entitlements
        DeletionPreflight(
            subscription = if (e.plan != Plan.Free && e.autoRenew == true && e.source != EntitlementSource.Grant) {
                StoreSubscriptionNotice(StoreName.fromWire(store), active = true, manageUrl = e.manageUrl)
            } else {
                null
            },
        )
    }

    override suspend fun deleteAccount(reason: String?): DeletionScheduled = route("me.deletion") {
        val me = user()
        val purgeAt = deletion?.purgeAt ?: now().plus(Duration.ofDays(30))
        deletion = PendingDeletion(purgeAt)
        session = me.copy(status = AccountStatus.Deleted)
        bumpMe()
        DeletionScheduled(purgeAt)
    }

    override suspend fun restoreAccount(): AuthUser = route("me.restore") {
        val me = user()
        if (me.status != AccountStatus.Deleted) fail(409, ProblemCodes.CONFLICT)
        deletion = null
        val restored = me.copy(status = AccountStatus.Active)
        session = restored
        bumpMe()
        restored
    }

    private val publicRequests = mutableMapOf<String, String>()

    override suspend fun publicDeletionStart(phone: String, locale: String): PublicDeletionChallenge = route("public.deletion.start") {
        if (!PHONE.matches(phone)) fail(400, ProblemCodes.PHONE_INVALID)
        // The same answer whether or not an account exists.
        val token = "dr_" + nextId()
        publicRequests[token] = phone
        PublicDeletionChallenge(token, SampleData.CODE.length)
    }

    override suspend fun publicDeletionConfirm(requestToken: String, code: String): DeletionScheduled = route("public.deletion.confirm") {
        publicRequests[requestToken] ?: fail(410, ProblemCodes.OTP_EXPIRED)
        if (code != SampleData.CODE) fail(400, ProblemCodes.OTP_INVALID, "attemptsLeft" to 4)
        publicRequests.remove(requestToken)
        DeletionScheduled(now().plus(Duration.ofDays(30)))
    }

    override suspend fun publicDeletionGoogle(idToken: String): DeletionScheduled = route("public.deletion.google") {
        if (idToken.isBlank()) fail(400, ProblemCodes.GOOGLE_TOKEN_INVALID)
        DeletionScheduled(now().plus(Duration.ofDays(30)))
    }

    // MARK: - Support, export, events

    override suspend fun supportTickets(cursor: String?): SupportTickets = route("support.tickets") {
        user()
        SupportTickets(tickets.values.map { it.ticket }.sortedByDescending { it.updatedAt ?: it.createdAt })
    }

    override suspend fun openSupportTicket(category: String, body: String, subject: String?): SupportTicket = route("support.open") {
        user()
        if (body.isBlank() || category.isBlank()) fail(422, ProblemCodes.FIELD_INVALID)
        val id = nextId()
        val ticket = SupportTicket(id, category, subject, TicketStatus.Open, createdAt = now(), updatedAt = now())
        tickets[id] = Ticket(ticket, mutableListOf(SupportMessage(nextId(), TicketAuthor.User, body, now())))
        ticket
    }

    override suspend fun supportMessages(ticketId: Id, cursor: String?): SupportMessages = route("support.messages") {
        user()
        val ticket = tickets[ticketId] ?: fail(404, ProblemCodes.NOT_FOUND)
        ticket.ticket = ticket.ticket.copy(unread = 0)
        SupportMessages(ticket.messages.toList())
    }

    override suspend fun sendSupportMessage(ticketId: Id, body: String): SupportMessage = route("support.send") {
        user()
        val ticket = tickets[ticketId] ?: fail(404, ProblemCodes.NOT_FOUND)
        if (body.isBlank()) fail(422, ProblemCodes.FIELD_INVALID)
        val message = SupportMessage(nextId(), TicketAuthor.User, body, now())
        ticket.messages += message
        ticket.ticket = ticket.ticket.copy(status = TicketStatus.Open, updatedAt = now())
        message
    }

    override suspend fun requestExport(): ExportStarted = route("me.export") {
        user()
        val last = lastExportAt
        if (last != null && nowMs() - last < EXPORT_EVERY_MS) {
            fail(429, ProblemCodes.RATE_LIMITED, "retryAfterSeconds" to (EXPORT_EVERY_MS - (nowMs() - last)) / 1000)
        }
        lastExportAt = nowMs()
        ExportStarted(nextId())
    }

    override suspend fun sendEvents(events: List<AppEvent>) = route("events") {
        user()
        if (events.size > HttpServerApi.MAX_EVENTS) fail(422, ProblemCodes.FIELD_INVALID)
        eventsReceived += events.size
    }

    /** How many analytics events arrived, for tests. */
    val eventsCount: Int get() = eventsReceived

    private fun refused(text: String): Boolean = REFUSED.any { text.contains(it, ignoreCase = true) }

    companion object {
        /** Message and other ids count up from here, like the server's time-based ids. */
        private const val ID_BASE = 1_287_390_234_923_417_600L

        /** The public id a new sample account gets. */
        const val NEW_ACCOUNT = "nnewacct2zzzz"

        const val RING_SECONDS = 45L
        const val CONFIRM_TOKEN = "cf_sample"

        private const val OTP_TTL_MS = 300_000L
        private const val RESEND_AFTER_MS = 60_000L
        private const val OTP_ATTEMPTS = 5
        private const val LOCATION_EVERY_MS = 60_000L
        private const val EXPORT_EVERY_MS = 7L * 24 * 3600 * 1000
        private const val PROCESSING_MS = 5_000L
        private const val VERIFICATION_MS = 10_000L
        private const val MAX_PHOTO_BYTES = 15L * 1024 * 1024
        private const val LIMITS_PHOTOS = 9
        private const val LIMITS_PHOTOS_MIN = 2
        private const val REJECT_EVERY = 4
        private const val SHEET_MS = 600L
        private const val SMS_ARRIVES_MS = 2_500L
        private const val UPLOAD_TTL_MS = 3_600_000L
        private const val UPLOAD_STEPS = 5
        private const val UPLOAD_STEP_MS = 120L
        private const val REVIEW_MS = 15_000L
        private const val REJECT_REASON = "The face isn't clearly visible in this photo."

        /** A Google ID token starting with this signs up a new account (any other signs in the sample one). */
        const val NEW_GOOGLE_TOKEN = "sample-new"

        private val LEGAL = listOf(ConsentKind.Terms, ConsentKind.Privacy, ConsentKind.Guidelines)
        private const val LIMITS_ABOUT = 500
        private const val LIMITS_COMMENT = 300
        private const val LIMITS_MESSAGE = 2000

        private val PHONE = Regex("^\\+[1-9][0-9]{7,14}$")

        /** Words the sample refuses outright, standing in for the panel's banned terms. */
        private val REFUSED = listOf("refusedword")

        /** Words that ask "are you sure?" first (the server's severity-1 terms). */
        private val CAUTION = listOf("money transfer", "send money")
    }
}
