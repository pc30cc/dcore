package app.core.feature.chat

import app.core.cache.SendState
import app.core.model.CallKind
import app.core.model.CallLine
import app.core.model.CallOutcome
import app.core.model.CallsAllowed
import app.core.model.Conversation
import app.core.model.ConversationPeer
import app.core.model.ConversationSource
import app.core.model.ConversationState
import app.core.model.Message
import app.core.model.MessageKind
import app.core.model.Photo
import app.core.sync.ChatMessage
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Conversations and messages for the chat's screen and rule tests: no server, no cache. */
object ChatTestData {
    const val ME = "abcdefghijklm"
    const val NEGAR = "bnegar2kq7xm4"
    const val ELIF = "celif5ztr3wa2"
    const val CONVERSATION = "1287390234923400001"

    val zone: ZoneId = ZoneId.systemDefault()

    /** Noon today on the test's clock, so "today" and "yesterday" hold in any zone. */
    val noonToday: Instant = LocalDate.now(zone).atTime(12, 0).atZone(zone).toInstant()

    fun minutesAgo(minutes: Long): Instant = noonToday.minusSeconds(minutes * 60)

    fun photo(id: Long) = Photo(id = id.toString(), w = 1080, h = 1350, blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url = "https://media.test/p/$id/1/320.webp")

    fun peer(id: String = NEGAR, name: String = "Negar", online: Boolean = false, activeRecently: Boolean = false, verified: Boolean = true) =
        ConversationPeer(id = id, name = name, photo = photo(9001), verified = verified, online = online, activeRecently = activeRecently)

    fun conversation(
        id: String = CONVERSATION,
        peer: ConversationPeer = peer(),
        lastMessage: Message? = null,
        unread: Int = 0,
        state: ConversationState = ConversationState.Active,
        source: ConversationSource = ConversationSource.Like,
        peerReadId: String? = null,
        peerDeliveredId: String? = null,
        muted: Boolean = false,
        callsAllowed: CallsAllowed = CallsAllowed(),
    ) = Conversation(
        id = id,
        peer = peer,
        state = state,
        source = source,
        createdAt = noonToday.minusSeconds(3 * 86_400),
        lastMessage = lastMessage,
        unread = unread,
        peerReadId = peerReadId,
        peerDeliveredId = peerDeliveredId,
        callsAllowed = callsAllowed,
        muted = muted,
    )

    fun wire(id: Long, from: String, body: String, at: Instant = noonToday, kind: MessageKind = MessageKind.Text, conversation: String = CONVERSATION) =
        Message(id = id.toString(), conversationId = conversation, senderId = from, kind = kind, body = body, at = at)

    /** A thread row as the view model gets it from the cache. */
    fun row(
        id: Long,
        mine: Boolean,
        body: String? = "Message $id",
        at: Instant = noonToday,
        state: SendState = SendState.SENT,
        kind: MessageKind = MessageKind.Text,
        refId: Long? = null,
        errorCode: String? = null,
        sender: String = if (mine) ME else NEGAR,
        call: CallLine? = null,
    ) = ChatMessage(
        localId = "local-$id",
        serverId = if (state == SendState.SENT) id else null,
        clientId = "client-$id",
        conversationId = CONVERSATION,
        senderId = sender,
        mine = sender == ME,
        kind = kind,
        body = body,
        refId = refId,
        media = null,
        call = call,
        at = at,
        state = state,
        errorCode = errorCode,
    )

    fun callLine(id: Long, caller: String, outcome: CallOutcome, seconds: Long = 0, kind: CallKind = CallKind.Audio) =
        CallLine(callId = id.toString(), kind = kind, outcome = outcome, placedAt = noonToday, durationSeconds = seconds, caller = caller)
}
