package app.core.feature.legal

import app.core.common.Clock
import app.core.model.ConsentVersions
import app.core.model.LegalVersions
import app.core.model.Wire
import app.core.storage.SecretStore
import kotlinx.serialization.Serializable

/**
 * The privacy notice and terms this install showed and the person accepted,
 * before any account existed. Sent with the basics
 * (`PUT /v1/me/basics` `consents`), which is when the server records them.
 *
 * A plain value, not a credential, under a fixed neutral key.
 */
class LegalAcceptance(private val store: SecretStore, private val clock: Clock) {

    @Serializable
    private data class Accepted(val terms: Int, val privacy: Int, val atMillis: Long)

    /** The versions accepted here, or null when the notice was not accepted on this install. */
    suspend fun accepted(): ConsentVersions? =
        store.read(KEY)?.let { raw ->
            runCatching { Wire.json.decodeFromString(Accepted.serializer(), raw) }.getOrNull()
        }?.let { ConsentVersions(terms = it.terms, privacy = it.privacy) }

    /** Accepted only if the versions shown are still the current ones. */
    suspend fun acceptedCurrent(current: LegalVersions): ConsentVersions? =
        accepted()?.takeIf { it.terms >= current.terms && it.privacy >= current.privacy }

    suspend fun accept(shown: LegalVersions) {
        store.write(KEY, Wire.json.encodeToString(Accepted.serializer(), Accepted(shown.terms, shown.privacy, clock.nowMillis())))
    }

    private companion object {
        const val KEY = "legal.accepted"
    }
}
