package app.core.net.origins

import app.core.BuildConfig
import app.core.net.origins.OriginsKit.KID
import app.core.net.origins.OriginsKit.NEXT_KID
import app.core.net.origins.OriginsKit.NEXT_PUBLIC
import app.core.net.origins.OriginsKit.NEXT_SEED
import app.core.net.origins.OriginsKit.RFC_PUBLIC
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.Instant

/**
 * The origins document's checks, each step and each refusal: RFC 8032's own
 * vector, the server's fixtures, tampering, keys, brand, time, rotation and
 * the host rules.
 */
class OriginsVerifierTest {

    private val now: Instant = Instant.parse("2026-11-20T00:00:00Z")

    private fun valid(result: Verified): OriginsList = (result as? Verified.Valid)?.list ?: run {
        fail("expected a valid document, got $result")
        error("unreachable")
    }

    private fun refusal(result: Verified): OriginsRefusal = (result as? Verified.Refused)?.reason ?: run {
        fail("expected a refusal, got $result")
        error("unreachable")
    }

    // MARK: - Ed25519

    @Test
    fun rfc8032Test1Verifies() {
        assertTrue(Ed25519.verify(RFC_PUBLIC, OriginsKit.RFC_EMPTY_SIGNATURE, ByteArray(0)))
    }

    @Test
    fun rfc8032Test1RefusesAnyChange() {
        val signature = OriginsKit.RFC_EMPTY_SIGNATURE
        for (index in listOf(0, 31, 32, 63)) {
            val bent = signature.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
            assertFalse("bit flipped in byte $index", Ed25519.verify(RFC_PUBLIC, bent, ByteArray(0)))
        }
        assertFalse("another message", Ed25519.verify(RFC_PUBLIC, signature, byteArrayOf(0)))
        assertFalse("a short signature", Ed25519.verify(RFC_PUBLIC, signature.copyOf(63), ByteArray(0)))
        assertFalse("a short key", Ed25519.verify(RFC_PUBLIC.copyOf(31), signature, ByteArray(0)))
    }

    @Test
    fun theTestSignerIsRfc8032Test1() {
        // The helper that signs the other tests' documents gives RFC 8032's own signature.
        val signature = com.google.crypto.tink.subtle.Ed25519Sign(OriginsKit.RFC_SEED).sign(ByteArray(0))
        assertArrayEquals(OriginsKit.RFC_EMPTY_SIGNATURE, signature)
    }

    // MARK: - The server's fixtures

    @Test
    fun theSharedFixtureVerifiesToItsPayload() {
        val trust = Json.parseToJsonElement(OriginsKit.fixture("trust.json")).jsonObject
        val key = trust["publicKeys"]!!.jsonArray.single().jsonObject
        val kid = key["kid"]!!.jsonPrimitive.content
        val raw = Base64Url.decode(key["key"]!!.jsonPrimitive.content)!!
        assertArrayEquals("the fixture key is RFC 8032 test 1's", RFC_PUBLIC, raw)
        val verifyAt = Instant.parse(trust["verifyAt"]!!.jsonPrimitive.content)

        val verifier = OriginsVerifier(OriginsTrust(trust["brand"]!!.jsonPrimitive.content, mapOf(kid to raw)))
        val list = valid(verifier.verify(OriginsKit.fixture("document.json"), verifyAt))

        val payload = Json.parseToJsonElement(OriginsKit.fixture("payload.json")).jsonObject
        val hosts = payload["hosts"]!!.jsonObject
        fun strings(name: String) = hosts[name]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(kid, list.kid)
        assertEquals(payload["brand"]!!.jsonPrimitive.content, list.brand)
        assertEquals(payload["version"]!!.jsonPrimitive.long, list.version)
        assertEquals(Instant.parse(payload["issuedAt"]!!.jsonPrimitive.content), list.issuedAt)
        assertEquals(Instant.parse(payload["expiresAt"]!!.jsonPrimitive.content), list.expiresAt)
        assertEquals(strings("api"), list.api)
        assertEquals(strings("realtime"), list.realtime)
        assertEquals(strings("rtc"), list.rtc)
        assertEquals(strings("cdn"), list.cdn)
        assertEquals(strings("web"), list.web)
        assertEquals(payload["bootstrap"]!!.jsonArray.map { it.jsonPrimitive.content }, list.bootstrap)

        // The same key as Gradle compiles it (BuildConfig.ORIGINS_PUBLIC_KEYS, `kid:key`)
        // and the build's brand id, read the way the app reads its own. The fixture is the
        // template's: a build of another brand must refuse it as another brand's list.
        val compiled = OriginsTrust.parse(BuildConfig.BRAND_ID, "$kid:${key["key"]!!.jsonPrimitive.content}")
        val own = OriginsVerifier(compiled).verify(OriginsKit.fixture("document.json"), verifyAt)
        if (BuildConfig.BRAND_ID == trust["brand"]!!.jsonPrimitive.content) {
            assertEquals(list, valid(own))
        } else {
            assertEquals(OriginsRefusal.WRONG_BRAND, refusal(own))
        }
    }

    @Test
    fun theFixtureSignatureIsReproducedHere() {
        // Ed25519 is deterministic: signing the fixture's payload text with the
        // same key here gives the server's bytes exactly.
        val document = Json.parseToJsonElement(OriginsKit.fixture("document.json")).jsonObject
        val payload = document["payload"]!!.jsonPrimitive.content
        val sig = com.google.crypto.tink.subtle.Ed25519Sign(OriginsKit.RFC_SEED)
            .sign((OriginsVerifier.SIGNING_CONTEXT + payload).toByteArray(Charsets.US_ASCII))
        assertEquals(document["sig"]!!.jsonPrimitive.content, Base64Url.encode(sig))
    }

    // MARK: - Tampering, keys, brand

    @Test
    fun aTamperedPayloadIsRefused() {
        val fixture = Json.parseToJsonElement(OriginsKit.fixture("document.json")).jsonObject
        val payload = fixture["payload"]!!.jsonPrimitive.content
        val sig = fixture["sig"]!!.jsonPrimitive.content
        // Another payload with the original signature: a host swapped in.
        val forged = Base64Url.encode(OriginsKit.payload(api = listOf("https://evil.example.org")).toByteArray())
        val verifier = OriginsVerifier(OriginsKit.trust())
        assertEquals(OriginsRefusal.BAD_SIGNATURE, refusal(verifier.verify(OriginsKit.envelope(KID, forged, sig), now)))
        // One character of the original payload changed.
        val bent = payload.substring(0, 20) + (if (payload[20] == 'A') 'B' else 'A') + payload.substring(21)
        assertEquals(OriginsRefusal.BAD_SIGNATURE, refusal(verifier.verify(OriginsKit.envelope(KID, bent, sig), now)))
    }

    @Test
    fun aTamperedSignatureIsRefused() {
        val fixture = Json.parseToJsonElement(OriginsKit.fixture("document.json")).jsonObject
        val payload = fixture["payload"]!!.jsonPrimitive.content
        val sig = fixture["sig"]!!.jsonPrimitive.content
        val bent = (if (sig[10] == 'A') "B" else "A").let { sig.substring(0, 10) + it + sig.substring(11) }
        val verifier = OriginsVerifier(OriginsKit.trust())
        assertEquals(OriginsRefusal.BAD_SIGNATURE, refusal(verifier.verify(OriginsKit.envelope(KID, payload, bent), now)))
        // 86 characters whose last one leaves stray bits: not a 64-byte value.
        val stray = sig.dropLast(1) + "B"
        assertEquals(OriginsRefusal.MALFORMED, refusal(verifier.verify(OriginsKit.envelope(KID, payload, stray), now)))
        assertEquals(OriginsRefusal.MALFORMED, refusal(verifier.verify(OriginsKit.envelope(KID, payload, sig.dropLast(2)), now)))
    }

    @Test
    fun aTamperedKidIsRefused() {
        val text = OriginsKit.sign(OriginsKit.payload())
        val renamed = text.replace("\"kid\":\"$KID\"", "\"kid\":\"$NEXT_KID\"")
        // Another key the build carries: the signature is not that key's.
        val both = OriginsVerifier(OriginsKit.trust(KID to RFC_PUBLIC, NEXT_KID to NEXT_PUBLIC))
        assertEquals(OriginsRefusal.BAD_SIGNATURE, refusal(both.verify(renamed, now)))
        // A key id that is not a key id at all.
        val odd = text.replace("\"kid\":\"$KID\"", "\"kid\":\"bad kid/1\"")
        assertEquals(OriginsRefusal.MALFORMED, refusal(both.verify(odd, now)))
    }

    @Test
    fun anUnknownKeyIsRefused() {
        val text = OriginsKit.sign(OriginsKit.payload(), kid = NEXT_KID, seed = NEXT_SEED)
        val verifier = OriginsVerifier(OriginsKit.trust())
        assertEquals(OriginsRefusal.UNKNOWN_KEY, refusal(verifier.verify(text, now)))
    }

    @Test
    fun anotherBrandsListIsRefused() {
        val text = OriginsKit.sign(OriginsKit.payload(brand = "other"))
        assertEquals(OriginsRefusal.WRONG_BRAND, refusal(OriginsVerifier(OriginsKit.trust()).verify(text, now)))
    }

    @Test
    fun aMalformedEnvelopeIsRefused() {
        val verifier = OriginsVerifier(OriginsKit.trust())
        val good = OriginsKit.sign(OriginsKit.payload())
        val cases = listOf(
            "not json",
            "[]",
            """{"alg":"Ed25519","kid":"$KID"}""",
            good.replace("\"alg\":\"Ed25519\"", "\"alg\":\"HS256\""),
            good.replace("\"payload\":\"", "\"payload\":\"=="),
        )
        for (text in cases) assertEquals(text, OriginsRefusal.MALFORMED, refusal(verifier.verify(text, now)))
    }

    @Test
    fun aSignedPayloadThatIsNotTheDocumentIsRefused() {
        val verifier = OriginsVerifier(OriginsKit.trust())
        val cases = listOf(
            "[1,2]",
            """{"brand":"_template"}""",
            OriginsKit.payload(version = 0),
            OriginsKit.payload(issuedAt = "yesterday"),
            OriginsKit.payload(issuedAt = "2026-12-09T10:00:00.000Z", expiresAt = "2026-12-09T10:00:00.000Z"),
            OriginsKit.payload(api = emptyList()),
            OriginsKit.payload(api = listOf("http://api.example.com", "https://api.example.com/v1", "ftp://x")),
        )
        for (payload in cases) assertEquals(payload, OriginsRefusal.MALFORMED, refusal(verifier.verify(OriginsKit.sign(payload), now)))
    }

    // MARK: - Time

    @Test
    fun anExpiredListIsRefusedWhenFetchedButReadWhenCached() {
        val text = OriginsKit.sign(OriginsKit.payload(expiresAt = "2026-11-19T23:59:59.999Z"))
        val verifier = OriginsVerifier(OriginsKit.trust())
        assertEquals(OriginsRefusal.EXPIRED, refusal(verifier.verify(text, now)))
        // Exactly at expiresAt is expired too.
        assertEquals(OriginsRefusal.EXPIRED, refusal(verifier.verify(OriginsKit.sign(OriginsKit.payload(expiresAt = "2026-11-20T00:00:00.000Z")), now)))
        // A cached copy is checked without the clock: still the last known good list.
        assertEquals(7L, valid(verifier.verify(text, now = null)).version)
    }

    @Test
    fun aListFromTheFutureIsRefused() {
        val verifier = OriginsVerifier(OriginsKit.trust())
        val ahead = OriginsKit.sign(OriginsKit.payload(issuedAt = "2026-11-21T00:00:00.001Z", expiresAt = "2026-12-21T00:00:00.000Z"))
        assertEquals(OriginsRefusal.NOT_YET_VALID, refusal(verifier.verify(ahead, now)))
        // A phone clock up to a day behind is tolerated.
        val skew = OriginsKit.sign(OriginsKit.payload(issuedAt = "2026-11-20T23:00:00.000Z", expiresAt = "2026-12-21T00:00:00.000Z"))
        assertEquals(7L, valid(verifier.verify(skew, now)).version)
    }

    // MARK: - Rotation

    @Test
    fun duringARotationBothKeysAreAccepted() {
        val verifier = OriginsVerifier(OriginsKit.trust(KID to RFC_PUBLIC, NEXT_KID to NEXT_PUBLIC))
        assertEquals(KID, valid(verifier.verify(OriginsKit.sign(OriginsKit.payload()), now)).kid)
        assertEquals(NEXT_KID, valid(verifier.verify(OriginsKit.sign(OriginsKit.payload(), NEXT_KID, NEXT_SEED), now)).kid)
        // After the rotation only the new key is compiled in: the old key's lists are refused.
        val after = OriginsVerifier(OriginsKit.trust(NEXT_KID to NEXT_PUBLIC))
        assertEquals(OriginsRefusal.UNKNOWN_KEY, refusal(after.verify(OriginsKit.sign(OriginsKit.payload()), now)))
    }

    @Test
    fun theBuildsKeysAreReadFromTheirBuildConfigForm() {
        val text = "$KID:${Base64Url.encode(RFC_PUBLIC)},$NEXT_KID:${Base64Url.encode(NEXT_PUBLIC)}"
        val trust = OriginsTrust.parse("_template", text)
        assertEquals(setOf(KID, NEXT_KID), trust.keys.keys)
        assertArrayEquals(RFC_PUBLIC, trust.keys[KID])
        assertTrue(trust.enabled)
        assertFalse("no keys", OriginsTrust.parse("_template", "").enabled)
        assertFalse("a short key", OriginsTrust.parse("_template", "$KID:abc").enabled)
    }

    // MARK: - Hosts

    @Test
    fun hostsThatAreNotBareHttpsOriginsAreDropped() {
        val payload = OriginsKit.payload(
            api = listOf(
                "https://api.example.com",
                "http://plain.example.com",
                "https://API.example.com",
                "https://api.example.com/path",
                "https://user@api.example.com",
                "https://api.example.com:8443",
                "https://api.example.com:70000",
                "https://[2001:4860::8888]",
                "https://api.example.com",
            ),
            realtime = listOf("wss://rt.example.com", "https://rt.example.com"),
            bootstrap = listOf("https://cdn.example.com/o.json", "http://cdn.example.com/o.json", "https://cdn.example.com/o.json?x=1"),
            extra = ""","future":{"anything":true}""",
        )
        val list = valid(OriginsVerifier(OriginsKit.trust()).verify(OriginsKit.sign(payload), now))
        assertEquals(listOf("https://api.example.com", "https://api.example.com:8443", "https://[2001:4860::8888]"), list.api)
        assertEquals(listOf("https://rt.example.com"), list.realtime)
        assertEquals(listOf("https://cdn.example.com/o.json"), list.bootstrap)
    }
}
