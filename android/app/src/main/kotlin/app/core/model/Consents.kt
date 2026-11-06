@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import java.time.Instant

// Accepted legal texts and explicit consents (/v1/me/consents, the basics'
// `consents`, `Me.consentsDue`, `Config.legal.versions`).

/** What a person can accept or withdraw. */
@Serializable(with = ConsentKind.Serializer::class)
enum class ConsentKind(override val wire: String) : WireEnum {
    Terms("terms"),
    Privacy("privacy"),
    Guidelines("guidelines"),
    SensitiveFields("sensitive_fields"),
    GenderMatching("gender_matching"),
    MarketingPush("marketing_push"),
    SelfieBiometrics("selfie_biometrics"),
    Unknown(""),
    ;

    internal object Serializer : WireEnumSerializer<ConsentKind>("ConsentKind", ConsentKind.entries.toTypedArray(), ConsentKind.Unknown)
}

/**
 * The versions of the legal texts the server currently asks for. A higher
 * number than the one a person accepted asks them again (`Me.consentsDue`).
 */
@Serializable
data class LegalVersions(
    val terms: Int = 1,
    val privacy: Int = 1,
    val guidelines: Int = 1,
)

/**
 * The versions the person was shown and accepted, sent with the basics.
 * [guidelines] is null until the guidelines step: they are accepted on their
 * own screen at the end of onboarding (`PUT /v1/me/consents/guidelines`).
 */
@Serializable
data class ConsentVersions(
    val terms: Int,
    val privacy: Int,
    val guidelines: Int? = null,
)

/** One accepted consent, as `GET /v1/me/consents` lists them. */
@Serializable
data class ConsentRecord(
    val kind: ConsentKind = ConsentKind.Unknown,
    val version: Int = 0,
    val acceptedAt: Instant? = null,
    val withdrawnAt: Instant? = null,
)

@Serializable
data class ConsentList(val consents: List<ConsentRecord> = emptyList())

/** `PUT /v1/me/consents/:kind`. */
@Serializable
data class ConsentUpdate(
    val version: Int,
    val accepted: Boolean,
)

/** The version an explicit consent that has no entry in [LegalVersions] is recorded under. */
const val EXPLICIT_CONSENT_VERSION: Int = 1
