@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import java.time.Instant

// Sign-in, refresh and sign-out (/v1/auth/*, /v1/me/phone/*).
//
// Request models: a field with no default is always sent (a nullable one as
// `null`); a field with a default is sent only when it differs from it.

@Serializable
data class OtpStartRequest(
    /** E.164, e.g. `+989121234567`. */
    val phone: String,
    val locale: String,
    val channel: OtpChannel? = null,
    /** The 11-character app hash the SMS Retriever API matches the text against. */
    val smsAppHash: String? = null,
    /** A Play Integrity token, in the play build only. */
    val integrityToken: String? = null,
)

@Serializable
data class OtpChallenge(
    val challengeId: String,
    val codeLength: Int = 6,
    val ttlSeconds: Int = 300,
    val resendAfterSeconds: Int = 60,
    val channel: OtpChannel = OtpChannel.Sms,
)

/** The phone, as the server identifies devices. Nothing here names its holder. */
@Serializable
data class DeviceInfo(
    val model: String,
    val osVersion: String,
    val appVersion: String,
    val locale: String,
)

@Serializable
data class OtpVerifyRequest(
    val challengeId: String,
    val code: String,
    /** A random UUID made once per install. */
    val installId: String,
    /** SHA-256 (hex) of the platform's per-app device id. */
    val deviceKey: String,
    val device: DeviceInfo,
)

@Serializable
data class GoogleNonce(
    val nonceId: String,
    val nonce: String,
    val ttlSeconds: Int = 300,
)

@Serializable
data class GoogleSignInRequest(
    val idToken: String,
    val nonceId: String,
    val installId: String,
    val deviceKey: String,
    val device: DeviceInfo,
)

/** The account a session belongs to, as sign-in, refresh and restore name it. */
@Serializable
data class AuthUser(
    val id: PublicUid,
    val status: AccountStatus = AccountStatus.Unknown,
    val onboardingStep: Int = 0,
)

/** What a successful sign-in returns. */
@Serializable
data class AuthResult(
    val accessToken: String,
    val accessExpiresAt: Instant,
    val refreshToken: String,
    val refreshExpiresAt: Instant? = null,
    val user: AuthUser,
    val isNew: Boolean = false,
) {
    val tokens: TokenPair get() = TokenPair(accessToken, accessExpiresAt, refreshToken, refreshExpiresAt)
}

@Serializable
data class RefreshRequest(val refreshToken: String)

/** A rotated pair: the old refresh token stops working once this one is used. */
@Serializable
data class TokenPair(
    val accessToken: String,
    val accessExpiresAt: Instant,
    val refreshToken: String,
    val refreshExpiresAt: Instant? = null,
)

@Serializable
data class LogoutRequest(
    /** Every session of the account, not only this one. */
    val all: Boolean = false,
)

/** `POST /v1/me/phone/start`: the same body as sign-in's. */
@Serializable
data class PhoneStartRequest(
    val phone: String,
    val locale: String,
    val channel: OtpChannel? = null,
    val smsAppHash: String? = null,
)

@Serializable
data class PhoneVerifyRequest(
    val challengeId: String,
    val code: String,
)
