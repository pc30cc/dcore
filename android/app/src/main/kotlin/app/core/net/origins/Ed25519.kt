package app.core.net.origins

import com.google.crypto.tink.subtle.Ed25519Verify
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import kotlin.io.encoding.Base64

/**
 * Ed25519 signature checks (RFC 8032, pure Ed25519, no context).
 *
 * The platform has Ed25519 from API 33 only and minSdk is 24, so this is
 * Tink's Java verifier (`subtle.Ed25519Verify`): wrong lengths, a public key
 * that is not a curve point and a non-canonical `S` are all refused.
 */
internal object Ed25519 {
    const val PUBLIC_KEY_BYTES = 32
    const val SIGNATURE_BYTES = 64

    fun verify(publicKey: ByteArray, signature: ByteArray, message: ByteArray): Boolean {
        if (publicKey.size != PUBLIC_KEY_BYTES || signature.size != SIGNATURE_BYTES) return false
        return try {
            Ed25519Verify(publicKey).verify(signature, message)
            true
        } catch (e: java.security.GeneralSecurityException) {
            false
        } catch (e: IllegalArgumentException) {
            false
        }
    }
}

/** Unpadded base64url, strict both ways. */
internal object Base64Url {
    private val codec = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT)

    /** The bytes, or null unless [text] is exactly what encoding them gives (no padding, no stray bits). */
    fun decode(text: String): ByteArray? {
        val bytes = try {
            codec.decode(text)
        } catch (e: IllegalArgumentException) {
            return null
        } catch (e: IndexOutOfBoundsException) {
            return null
        }
        return if (codec.encode(bytes) == text) bytes else null
    }

    fun encode(bytes: ByteArray): String = codec.encode(bytes)
}

/** UTF-8 that refuses malformed input instead of replacing it. */
internal fun strictUtf8(bytes: ByteArray): String? =
    try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (e: CharacterCodingException) {
        null
    }
