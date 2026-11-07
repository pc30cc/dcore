package app.core.feature.call

import app.core.model.Call
import app.core.model.CallAcceptance
import app.core.model.CallKind
import app.core.model.CallToken
import app.core.model.Id
import app.core.net.ServerApi

/**
 * The call routes a call session uses (`/v1/calls` and `/v1/calls/:id/...`), and nothing else of
 * the server: what a session's tests script.
 */
interface CallApi {
    /** `POST /v1/calls`: rings the other person. Never retried. */
    suspend fun place(conversationId: Id, kind: CallKind): Call

    /** `GET /v1/calls/:id`: only while the realtime socket is down. */
    suspend fun call(callId: Id): Call

    /** `POST /v1/calls/:id/accept`: the first answer wins; the answer carries the room's token. */
    suspend fun accept(callId: Id): CallAcceptance

    /** `POST /v1/calls/:id/decline`. */
    suspend fun decline(callId: Id): Call

    /** `POST /v1/calls/:id/end`: the caller's cancel before an answer, a hang-up after it. */
    suspend fun end(callId: Id): Call

    /** `POST /v1/calls/:id/token`: the room's token while the call is connecting or active. */
    suspend fun token(callId: Id): CallToken

    companion object {
        fun of(api: ServerApi): CallApi = object : CallApi {
            override suspend fun place(conversationId: Id, kind: CallKind) = api.placeCall(conversationId, kind)
            override suspend fun call(callId: Id) = api.call(callId)
            override suspend fun accept(callId: Id) = api.acceptCall(callId)
            override suspend fun decline(callId: Id) = api.declineCall(callId)
            override suspend fun end(callId: Id) = api.endCall(callId)
            override suspend fun token(callId: Id) = api.callToken(callId)
        }
    }
}
