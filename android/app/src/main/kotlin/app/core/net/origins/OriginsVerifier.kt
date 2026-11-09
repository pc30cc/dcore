package app.core.net.origins

import app.core.BuildConfig
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/**
 * A verified origins list: where the API, realtime, call signalling, the CDN
 * and the website are, each list in order of preference, and where copies of
 * the list itself are published.
 *
 * Every host is a bare `https` origin (`https://host`, `https://host:port`),
 * never with a path. Lists are deduplicated and hold at most eight entries.
 */
data class OriginsList(
    /** The key id it was signed with. */
    val kid: String,
    val brand: String,
    val version: Long,
    val issuedAt: Instant,
    val expiresAt: Instant,
    val api: List<String>,
    val realtime: List<String>,
    val rtc: List<String>,
    val cdn: List<String>,
    val web: List<String>,
    val bootstrap: List<String>,
) {
    /** Lists order by (`version`, `issuedAt`): positive when this one is newer than [other]. */
    fun compareOrder(other: OriginsList): Int =
        if (version != other.version) version.compareTo(other.version) else issuedAt.compareTo(other.issuedAt)
}

/** Why a candidate document was refused. */
enum class OriginsRefusal {
    /** Not an envelope, an unknown algorithm, a payload that does not decode or misses what it must hold. */
    MALFORMED,

    /** Signed with a key id this build does not carry. */
    UNKNOWN_KEY,

    /** The signature does not match the payload as received. */
    BAD_SIGNATURE,

    /** Another brand's list. */
    WRONG_BRAND,

    /** Issued more than a day ahead of this phone's clock. */
    NOT_YET_VALID,

    /** Past its `expiresAt` by this phone's clock. */
    EXPIRED,
}

sealed interface Verified {
    data class Valid(val list: OriginsList) : Verified

    data class Refused(val reason: OriginsRefusal, val detail: String) : Verified
}

/**
 * The keys and the brand a list must match, from the build
 * (`origins.publicKeys`, brand.json `id`).
 */
class OriginsTrust(val brand: String, keys: Map<String, ByteArray>) {
    /** Key id to raw 32-byte Ed25519 public key; two during a rotation. */
    val keys: Map<String, ByteArray> = keys.mapValues { it.value.copyOf() }

    /** A build without keys can verify nothing: it stays on its compiled hosts. */
    val enabled: Boolean get() = keys.isNotEmpty()

    companion object {
        /** `kid:key,kid:key` (what Gradle writes into BuildConfig); an entry that does not read is left out. */
        fun parse(brand: String, publicKeys: String): OriginsTrust {
            val keys = LinkedHashMap<String, ByteArray>()
            for (entry in publicKeys.split(',')) {
                val kid = entry.substringBefore(':', "").trim()
                val key = entry.substringAfter(':', "").trim()
                val raw = Base64Url.decode(key)
                if (KID.matches(kid) && raw != null && raw.size == Ed25519.PUBLIC_KEY_BYTES && kid !in keys) keys[kid] = raw
            }
            return OriginsTrust(brand, keys)
        }

        fun fromBuild(): OriginsTrust = parse(BuildConfig.BRAND_ID, BuildConfig.ORIGINS_PUBLIC_KEYS)

        /** The build's published copies (`origins.bootstrap`), in order. */
        fun buildBootstrap(): List<String> = bootstrapUrls(BuildConfig.ORIGINS_BOOTSTRAP.split(' '))

        internal val KID = Regex("[A-Za-z0-9._-]{1,32}")
    }
}

/**
 * Checks a candidate document, every step in order; any failure refuses it.
 *
 *  1. The envelope: JSON with `alg` `Ed25519`, a `kid` of 1-32 `[A-Za-z0-9._-]`,
 *     `payload` in base64url, `sig` of 86 base64url characters (64 bytes).
 *  2. `kid` is one of the build's keys.
 *  3. Ed25519 over the ASCII bytes of `"origins-v1." + payload`, the payload
 *     text exactly as received.
 *  4. The payload (base64url, UTF-8, JSON; unknown keys ignored): this brand,
 *     `issuedAt` before `expiresAt`, at least one usable API host. Hosts that
 *     are not a bare https origin are dropped; so are bootstrap entries that
 *     are not an https URL.
 *  5. With [now] (a fetched copy, not the cached one): refused once
 *     `expiresAt <= now`, or when `issuedAt` is more than 24 hours ahead.
 *
 * Ordering against the list in hand is the caller's (the repository's).
 */
class OriginsVerifier(private val trust: OriginsTrust) {

    fun verify(text: String, now: Instant?): Verified {
        if (text.length > MAX_DOCUMENT_CHARS) return refuse(OriginsRefusal.MALFORMED, "too large")
        val envelope = try {
            json.decodeFromString(Envelope.serializer(), text)
        } catch (e: SerializationException) {
            return refuse(OriginsRefusal.MALFORMED, "not an envelope")
        } catch (e: IllegalArgumentException) {
            return refuse(OriginsRefusal.MALFORMED, "not an envelope")
        }
        if (envelope.alg != ALGORITHM) return refuse(OriginsRefusal.MALFORMED, "algorithm")
        if (!OriginsTrust.KID.matches(envelope.kid)) return refuse(OriginsRefusal.MALFORMED, "key id")
        if (envelope.payload.isEmpty() || envelope.payload.length > MAX_PAYLOAD_CHARS || !PAYLOAD.matches(envelope.payload)) {
            return refuse(OriginsRefusal.MALFORMED, "payload text")
        }
        val payloadBytes = Base64Url.decode(envelope.payload) ?: return refuse(OriginsRefusal.MALFORMED, "payload encoding")
        val signature = (if (SIGNATURE.matches(envelope.sig)) Base64Url.decode(envelope.sig) else null)
            ?.takeIf { it.size == Ed25519.SIGNATURE_BYTES }
            ?: return refuse(OriginsRefusal.MALFORMED, "signature text")

        val key = trust.keys[envelope.kid] ?: return refuse(OriginsRefusal.UNKNOWN_KEY, "key ${envelope.kid}")

        val signed = (SIGNING_CONTEXT + envelope.payload).toByteArray(Charsets.US_ASCII)
        if (!Ed25519.verify(key, signature, signed)) return refuse(OriginsRefusal.BAD_SIGNATURE, "key ${envelope.kid}")

        val payloadText = strictUtf8(payloadBytes) ?: return refuse(OriginsRefusal.MALFORMED, "payload is not UTF-8")
        val payload = try {
            json.decodeFromString(Payload.serializer(), payloadText)
        } catch (e: SerializationException) {
            return refuse(OriginsRefusal.MALFORMED, "payload is not the expected JSON")
        } catch (e: IllegalArgumentException) {
            return refuse(OriginsRefusal.MALFORMED, "payload is not the expected JSON")
        }
        if (payload.brand != trust.brand) return refuse(OriginsRefusal.WRONG_BRAND, "brand")
        if (payload.version < 1) return refuse(OriginsRefusal.MALFORMED, "version")
        val issuedAt = instant(payload.issuedAt) ?: return refuse(OriginsRefusal.MALFORMED, "issuedAt")
        val expiresAt = instant(payload.expiresAt) ?: return refuse(OriginsRefusal.MALFORMED, "expiresAt")
        if (!issuedAt.isBefore(expiresAt)) return refuse(OriginsRefusal.MALFORMED, "expires before it was issued")
        val api = hostList(payload.hosts.api)
        if (api.isEmpty()) return refuse(OriginsRefusal.MALFORMED, "no usable API host")

        if (now != null) {
            if (!expiresAt.isAfter(now)) return refuse(OriginsRefusal.EXPIRED, "expired")
            if (issuedAt.isAfter(now.plusMillis(MAX_AHEAD_MS))) return refuse(OriginsRefusal.NOT_YET_VALID, "issued in the future")
        }

        return Verified.Valid(
            OriginsList(
                kid = envelope.kid,
                brand = payload.brand,
                version = payload.version,
                issuedAt = issuedAt,
                expiresAt = expiresAt,
                api = api,
                realtime = hostList(payload.hosts.realtime),
                rtc = hostList(payload.hosts.rtc),
                cdn = hostList(payload.hosts.cdn),
                web = hostList(payload.hosts.web),
                bootstrap = bootstrapUrls(payload.bootstrap),
            ),
        )
    }

    private fun refuse(reason: OriginsRefusal, detail: String) = Verified.Refused(reason, detail)

    @Serializable
    private class Envelope(val alg: String, val kid: String, val payload: String, val sig: String)

    @Serializable
    private class Payload(
        val brand: String,
        val version: Long,
        val issuedAt: String,
        val expiresAt: String,
        val hosts: Hosts,
        val bootstrap: List<String> = emptyList(),
    )

    @Serializable
    private class Hosts(
        val api: List<String> = emptyList(),
        val realtime: List<String> = emptyList(),
        val rtc: List<String> = emptyList(),
        val cdn: List<String> = emptyList(),
        val web: List<String> = emptyList(),
    )

    companion object {
        const val ALGORITHM = "Ed25519"

        /** What the signature covers: this text, then the payload exactly as sent. */
        const val SIGNING_CONTEXT = "origins-v1."

        /** How far ahead of this phone's clock a list may say it was issued. */
        const val MAX_AHEAD_MS = 24 * 3_600_000L

        const val MAX_PAYLOAD_CHARS = 16_384
        const val MAX_DOCUMENT_CHARS = 20_000

        private val PAYLOAD = Regex("[A-Za-z0-9_-]+")
        private val SIGNATURE = Regex("[A-Za-z0-9_-]{85}[AQgw]")

        private val json = Json {
            ignoreUnknownKeys = true
            isLenient = false
        }

        private fun instant(text: String): Instant? =
            try {
                OffsetDateTime.parse(text).toInstant()
            } catch (e: DateTimeParseException) {
                null
            }
    }
}

/** At most this many entries per role and bootstrap URLs, as the server allows. */
internal const val MAX_PER_LIST = 8

private val HOST = Regex("https://([a-z0-9.-]+)(:([0-9]{1,5}))?")
private val IPV6_HOST = Regex("https://\\[([0-9a-f:.]+)](:([0-9]{1,5}))?")

/** A bare https origin as the document carries it (`https://host[:port]`), or null. */
internal fun originOrNull(value: String): String? {
    val match = HOST.matchEntire(value) ?: IPV6_HOST.matchEntire(value) ?: return null
    val host = match.groupValues[1]
    if (host.isEmpty() || host.startsWith('.') || host.endsWith('.') || host.contains("..")) return null
    val port = match.groupValues[3]
    if (port.isNotEmpty() && port.toInt() !in 1..65535) return null
    return value
}

internal fun hostList(values: List<String>): List<String> =
    values.mapNotNull(::originOrNull).distinct().take(MAX_PER_LIST)

/** https URLs of published copies, in order; anything else is dropped. */
internal fun bootstrapUrls(values: List<String>): List<String> =
    values.map { it.trim() }.filter(::isBootstrapUrl).distinct().take(MAX_PER_LIST)

private fun isBootstrapUrl(value: String): Boolean {
    if (!value.startsWith("https://") || value.length > 300) return false
    if (value.any { it.isWhitespace() || it.isISOControl() || it == '#' || it == '?' }) return false
    val uri = try {
        URI(value)
    } catch (e: java.net.URISyntaxException) {
        return false
    }
    return uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null
}
