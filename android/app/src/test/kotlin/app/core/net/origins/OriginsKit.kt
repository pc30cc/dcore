package app.core.net.origins

import com.google.crypto.tink.subtle.Ed25519Sign
import java.io.File

/**
 * Signed origins documents for tests, made the way the server makes them
 * (Ed25519 over `"origins-v1." + payload`), with published test keys only:
 * RFC 8032 §7.1 test 1, which also signs the shared fixtures, and a second
 * key from a fixed seed for rotations.
 */
internal object OriginsKit {
    const val KID = "test-1"
    const val NEXT_KID = "test-2"
    const val BRAND = "_template"

    val RFC_SEED: ByteArray = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    val RFC_PUBLIC: ByteArray = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    val RFC_EMPTY_SIGNATURE: ByteArray = hex(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    )

    val NEXT_SEED: ByteArray = ByteArray(32) { (it * 7 + 3).toByte() }
    val NEXT_PUBLIC: ByteArray = Ed25519Sign.KeyPair.newKeyPairFromSeed(NEXT_SEED).publicKey

    fun trust(vararg keys: Pair<String, ByteArray>, brand: String = BRAND): OriginsTrust =
        OriginsTrust(brand, if (keys.isEmpty()) mapOf(KID to RFC_PUBLIC) else keys.toMap())

    fun payload(
        version: Long = 7,
        issuedAt: String = "2026-11-09T10:00:00.000Z",
        expiresAt: String = "2026-12-09T10:00:00.000Z",
        api: List<String> = listOf("https://api.example.com", "https://api2.example.net"),
        realtime: List<String> = listOf("https://rt.example.com"),
        web: List<String> = listOf("https://example.com"),
        bootstrap: List<String> = listOf("https://cdn.example.com/bootstrap/origins.json"),
        brand: String = BRAND,
        extra: String = "",
    ): String {
        fun list(values: List<String>) = values.joinToString(",", "[", "]") { "\"$it\"" }
        return """{"brand":"$brand","version":$version,"issuedAt":"$issuedAt","expiresAt":"$expiresAt",""" +
            """"hosts":{"api":${list(api)},"realtime":${list(realtime)},"rtc":[],"cdn":[],"web":${list(web)}},""" +
            """"bootstrap":${list(bootstrap)}$extra}"""
    }

    fun sign(payloadJson: String, kid: String = KID, seed: ByteArray = RFC_SEED): String {
        val payload = Base64Url.encode(payloadJson.toByteArray(Charsets.UTF_8))
        val sig = Ed25519Sign(seed).sign((OriginsVerifier.SIGNING_CONTEXT + payload).toByteArray(Charsets.US_ASCII))
        return envelope(kid, payload, Base64Url.encode(sig))
    }

    fun envelope(kid: String, payload: String, sig: String, alg: String = "Ed25519"): String =
        """{"alg":"$alg","kid":"$kid","payload":"$payload","sig":"$sig"}"""

    /** `server/packages/shared/fixtures/origins`, found above the module's directory. */
    val fixtures: File by lazy {
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
            .map { File(it, "server/packages/shared/fixtures/origins") }
            .firstOrNull { it.isDirectory }
            ?: error("server/packages/shared/fixtures/origins not found above ${System.getProperty("user.dir")}")
    }

    fun fixture(name: String): String = File(fixtures, name).readText()

    fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
