package app.core.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

/**
 * An error answer: RFC 9457 `application/problem+json`. Clients branch on
 * [code], never on `title` or `detail`.
 *
 * Extension members differ per code (`attemptsLeft` on `otp_invalid`,
 * `reasonText` on `account_suspended`, ...), so the whole object is kept in
 * [members] and read through the accessors below. An unknown code is handled
 * like its HTTP status.
 */
class Problem(
    val status: Int,
    val code: String?,
    val title: String? = null,
    val detail: String? = null,
    val requestId: String? = null,
    /** From the body, else from a `Retry-After` header in seconds. */
    val retryAfterSeconds: Long? = null,
    val members: JsonObject = JsonObject(emptyMap()),
) {
    fun string(name: String): String? = members[name]?.stringOrNull
    fun int(name: String): Int? = members[name]?.intOrNull
    fun long(name: String): Long? = members[name]?.longOrNull
    fun bool(name: String): Boolean? = members[name]?.boolOrNull
    fun time(name: String): Instant? = string(name)?.let(InstantSerializer::parse)

    /** `otp_invalid`. */
    val attemptsLeft: Int? get() = int("attemptsLeft")

    /** `account_suspended`, `account_banned`: the text the person reads. */
    val reasonText: String? get() = string("reasonText")
    val actionId: String? get() = string("actionId")
    val until: Instant? get() = time("until")
    val appealable: Boolean? get() = bool("appealable")

    /** `account_deleted`. */
    val restorableUntil: Instant? get() = time("restorableUntil")

    /** `entitlement_required`, `quota_exceeded`: the feature key. */
    val feature: String? get() = string("feature")
    val resetsAt: Instant? get() = time("resetsAt")
    val canBuy: Boolean? get() = bool("canBuy")

    /** `calls_not_allowed`: `consent`, `disabled` or `plan`. */
    val reason: String? get() = string("reason")

    /** `confirm_required`: send again with this to go ahead. */
    val confirmToken: String? get() = string("confirmToken")
    val category: String? get() = string("category")

    /** `upgrade_required`. */
    val minVersionCode: Int? get() = int("minVersionCode")

    /** `maintenance`. */
    val message: String? get() = string("message")

    /** `validation_failed`: JSON pointers of the fields that were refused. */
    val invalidPointers: List<String>
        get() = (members["errors"] as? JsonArray).orEmpty().mapNotNull { it["pointer"]?.stringOrNull }

    override fun toString(): String = "Problem($status${code?.let { ", $it" } ?: ""})"

    companion object {
        private const val MAX_CODE = 64

        /**
         * Reads a failure body, whatever it is: a problem document, the older
         * `{"error": {"code": ...}}` or `{"error": "..."}` shapes, or not JSON
         * at all (an edge proxy's HTML page), which gives a problem with no code.
         */
        fun parse(status: Int, body: String, retryAfterHeader: String? = null): Problem {
            val root = runCatching { Wire.json.parseToJsonElement(body) as? JsonObject }.getOrNull()
            val error = root?.get("error")
            val code = (root?.get("code")?.stringOrNull ?: error["code"]?.stringOrNull ?: error?.stringOrNull)
                ?.take(MAX_CODE)
                ?.takeIf { it.isNotBlank() }
            val retryAfter = root?.get("retryAfterSeconds")?.longOrNull
                ?: retryAfterHeader?.trim()?.toLongOrNull()
            return Problem(
                status = status,
                code = code,
                title = root?.get("title")?.stringOrNull,
                detail = root?.get("detail")?.stringOrNull,
                requestId = root?.get("requestId")?.stringOrNull,
                retryAfterSeconds = retryAfter,
                members = root ?: JsonObject(emptyMap()),
            )
        }

        /** A problem made on the device (the sample backend, tests). */
        fun of(status: Int, code: String, vararg members: Pair<String, Any?>): Problem {
            val all = buildMap {
                put("status", JsonPrimitive(status))
                put("code", JsonPrimitive(code))
                for ((name, value) in members) {
                    when (value) {
                        null -> Unit
                        is Number -> put(name, JsonPrimitive(value))
                        is Boolean -> put(name, JsonPrimitive(value))
                        is Instant -> put(name, JsonPrimitive(InstantSerializer.format(value)))
                        else -> put(name, JsonPrimitive(value.toString()))
                    }
                }
            }
            val retry = (members.firstOrNull { it.first == "retryAfterSeconds" }?.second as? Number)?.toLong()
            return Problem(status = status, code = code, retryAfterSeconds = retry, members = JsonObject(all))
        }
    }
}

/**
 * The error codes the API sends (`code` of a problem). Constants, not an
 * enum: a newer server may send one this build does not know, which callers
 * treat like its HTTP status.
 */
object ProblemCodes {
    // Generic
    const val BAD_REQUEST = "bad_request"
    const val VALIDATION_FAILED = "validation_failed"
    const val UNAUTHORIZED = "unauthorized"
    const val TOKEN_EXPIRED = "token_expired"
    const val FORBIDDEN = "forbidden"
    const val NOT_FOUND = "not_found"
    const val CONFLICT = "conflict"
    const val PAYLOAD_TOO_LARGE = "payload_too_large"
    const val UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"
    const val RATE_LIMITED = "rate_limited"
    const val INTERNAL = "internal"
    const val SERVICE_UNAVAILABLE = "service_unavailable"

    // 400
    const val PHONE_INVALID = "phone_invalid"
    const val OTP_INVALID = "otp_invalid"
    const val GOOGLE_TOKEN_INVALID = "google_token_invalid"

    // 401
    const val REFRESH_INVALID = "refresh_invalid"
    const val REFRESH_REUSED = "refresh_reused"

    // 403
    const val ACCOUNT_BANNED = "account_banned"
    const val ACCOUNT_SUSPENDED = "account_suspended"
    const val ACCOUNT_DELETED = "account_deleted"
    const val PHONE_BANNED = "phone_banned"
    const val PHONE_NOT_ALLOWED = "phone_not_allowed"
    const val DEVICE_BANNED = "device_banned"
    const val ONBOARDING_INCOMPLETE = "onboarding_incomplete"
    const val SNOOZED = "snoozed"
    const val LOCATION_REQUIRED = "location_required"
    const val ENTITLEMENT_REQUIRED = "entitlement_required"
    const val CALLS_NOT_ALLOWED = "calls_not_allowed"
    const val STORE_NOT_SUPPORTED = "store_not_supported"

    // 409
    const val ALREADY_SET = "already_set"
    const val POSITION_TAKEN = "position_taken"
    const val ALREADY_REQUESTED = "already_requested"
    const val ALREADY_MATCHED = "already_matched"
    const val CONFIRM_REQUIRED = "confirm_required"
    const val CALLEE_BUSY = "callee_busy"
    const val CALLER_BUSY = "caller_busy"
    const val NOT_RINGING = "not_ringing"
    const val ANSWERED_ELSEWHERE = "answered_elsewhere"
    const val CALL_NOT_LIVE = "call_not_live"
    const val APPEAL_OPEN = "appeal_open"
    const val PURCHASE_OTHER_ACCOUNT = "purchase_other_account"

    // 410
    const val OTP_EXPIRED = "otp_expired"
    const val CONVERSATION_ENDED = "conversation_ended"

    // 422
    const val UNDER_AGE = "under_age"
    const val FIELD_INVALID = "field_invalid"
    const val TEXT_REFUSED = "text_refused"
    const val MESSAGE_REFUSED = "message_refused"
    const val PHOTO_LIMIT = "photo_limit"
    const val LAST_PHOTO = "last_photo"
    const val UPLOAD_MISSING = "upload_missing"
    const val PURCHASE_INVALID = "purchase_invalid"
    const val LIMIT_REACHED = "limit_reached"
    const val NOT_APPEALABLE = "not_appealable"

    // 426, 429, 503
    const val UPGRADE_REQUIRED = "upgrade_required"
    const val QUOTA_EXCEEDED = "quota_exceeded"
    const val OTP_LOCKED = "otp_locked"
    const val MAINTENANCE = "maintenance"
    const val SMS_UNAVAILABLE = "sms_unavailable"
    const val STORE_UNAVAILABLE = "store_unavailable"

    /** The account's state, not this request, is the reason: the session itself is fine. */
    val ACCOUNT_STATE: Set<String> = setOf(ACCOUNT_BANNED, ACCOUNT_SUSPENDED, ACCOUNT_DELETED)
}
