package app.core.model

import kotlinx.serialization.Serializable

// Calls between two people of an active conversation (/v1/calls/*).

@Serializable
data class PlaceCallRequest(
    val conversationId: Id,
    val kind: CallKind,
)

@Serializable
data class CallBody(val call: Call)

/** The answer to accepting a ring: the call, now connecting, and the token to join its room. */
@Serializable
data class CallAcceptance(
    val call: Call,
    val token: CallToken,
)
