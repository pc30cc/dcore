package app.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.roundToLong

/** A user's public id on the wire: 13 characters of base32 (`^[a-z2-7]{13}$`). Never a raw id. */
typealias PublicUid = String

/** Every other id on the wire (match, message, photo, call, report, purchase): a decimal string. */
typealias Id = String

/**
 * The JSON settings every request and response goes through.
 *
 * - Unknown keys are ignored: a newer server may add fields to any object.
 * - `null` for a non-null property that has a default, or a value it cannot
 *   take, falls back to that default instead of failing the whole response.
 * - Defaults are not written, so an optional field left `null` in a request
 *   body is left out, which is what a PATCH means by "unchanged".
 * - `null` IS written for a nullable property that has no default: that is
 *   how a request body says "clear this" (`pushToken: null`, a prompt's
 *   `answer: null`). Request models give such fields no default on purpose.
 */
object Wire {
    val json: Json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = false
        explicitNulls = true
    }
}

/** An enumeration as it travels: a lowercase string. */
interface WireEnum {
    val wire: String
}

/**
 * An enum that degrades instead of failing when the server adds a value.
 *
 * kotlinx.serialization throws on an unknown enum value by default, which
 * would drop a whole list the day the server adds a kind of message. Every
 * wire enum carries an `Unknown` member and decodes anything it does not know
 * to it; screens treat `Unknown` as "show nothing special".
 *
 * `Unknown` encodes as `"unknown"`, so a decoded model written back to the
 * local cache and read again keeps its `Unknown`. It is never meant to be sent
 * to the server, which would refuse it as invalid input.
 */
abstract class WireEnumSerializer<T>(
    name: String,
    private val values: Array<T>,
    private val unknown: T,
) : KSerializer<T> where T : Enum<T>, T : WireEnum {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("app.core.model.$name", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: T) =
        encoder.encodeString(if (value == unknown) UNKNOWN_WIRE else value.wire)

    override fun deserialize(decoder: Decoder): T {
        val raw = decoder.decodeString()
        return values.firstOrNull { it != unknown && it.wire == raw } ?: unknown
    }

    private companion object {
        const val UNKNOWN_WIRE = "unknown"
    }
}

/**
 * Times on the wire: RFC 3339 in UTC with milliseconds
 * (`2026-11-06T09:14:03.120Z`). Read leniently (any fraction, any offset),
 * written exactly in that form.
 */
object InstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("app.core.model.Instant", PrimitiveKind.STRING)

    private val writer: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun parse(raw: String): Instant? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        runCatching { return OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant() }
        runCatching { return Instant.parse(text) }
        return null
    }

    fun format(value: Instant): String = writer.format(value)

    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(format(value))

    override fun deserialize(decoder: Decoder): Instant {
        val raw = decoder.decodeString()
        return parse(raw) ?: throw SerializationException("not an RFC 3339 time: '${raw.take(40)}'")
    }
}

/** A calendar date (`1995-04-02`): the birth date, and nothing else on the wire. */
object LocalDateSerializer : KSerializer<LocalDate> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("app.core.model.LocalDate", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: LocalDate) = encoder.encodeString(value.toString())

    override fun deserialize(decoder: Decoder): LocalDate {
        val raw = decoder.decodeString()
        return runCatching { LocalDate.parse(raw.trim()) }.getOrNull()
            ?: throw SerializationException("not a calendar date: '${raw.take(20)}'")
    }
}

// MARK: - Reading free-form objects
//
// Problem documents carry extension members per error code, and `props` of an
// event is free-form. These read a value out of a JsonElement without
// modelling it.

/** The value as a string, or null if it is anything else. */
val JsonElement.stringOrNull: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A whole number, whether it came as a number or as a numeric string. */
val JsonElement.longOrNull: Long?
    get() {
        val primitive = this as? JsonPrimitive ?: return null
        if (primitive.isString) return primitive.content.toLongOrNull()
        primitive.content.toLongOrNull()?.let { return it }
        return primitive.doubleOrNull?.takeIf { it.isFinite() }?.roundToLong()
    }

val JsonElement.intOrNull: Int?
    get() = longOrNull?.takeIf { it in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() }?.toInt()

val JsonElement.boolOrNull: Boolean?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/** Key lookup that answers null for anything that is not an object. */
operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)
