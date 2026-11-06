@file:UseSerializers(InstantSerializer::class, LocalDateSerializer::class)

package app.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import java.time.Instant
import java.time.LocalDate

// The account itself: /v1/me, profile, photos, location, devices, verification.

@Serializable
data class Travel(
    val city: City,
    val until: Instant? = null,
)

/** Where the account is, as far as anyone is told: a city and a country, never a position. */
@Serializable
data class AccountLocation(
    val city: City? = null,
    val country: String? = null,
    val travel: Travel? = null,
)

@Serializable
data class PendingDeletion(val purgeAt: Instant)

/**
 * `GET /v1/me`. A deleted account in its grace period gets a minimal answer
 * (no profile, no preferences), so everything below the status is optional.
 */
@Serializable
data class Me(
    val id: PublicUid,
    val status: AccountStatus = AccountStatus.Unknown,
    val onboardingStep: Int = 0,
    val store: StoreName = StoreName.Unknown,
    /** The store-side account reference purchases are bound to. */
    val billingRef: String? = null,
    val profile: OwnProfile? = null,
    val preferences: DiscoveryPreferences? = null,
    val location: AccountLocation? = null,
    val notifications: NotificationPrefs? = null,
    val flags: Map<String, Boolean> = emptyMap(),
    /** Active ones only; the history is a separate read. */
    val moderation: List<ModerationAction> = emptyList(),
    val deletion: PendingDeletion? = null,
    /** Legal texts whose current version the person has not accepted yet. */
    val consentsDue: List<ConsentKind> = emptyList(),
)

@Serializable
data class BasicsRequest(
    val birthDate: LocalDate,
    val gender: Gender,
    /** The legal text versions the person was shown and accepted. */
    val consents: ConsentVersions,
)

/**
 * A field edit. With none of the four values set the field's answer is
 * removed.
 */
@Serializable
data class FieldEdit(
    val fieldId: Int,
    val option: Int? = null,
    val options: List<Int>? = null,
    val number: Int? = null,
    val text: String? = null,
)

/** A prompt in a position; [answer] `null` removes it from that position. */
@Serializable
data class PromptEdit(
    val position: Int,
    val promptId: Int,
    val answer: String?,
)

/** `PATCH /v1/me/profile`: only the fields set are changed. */
@Serializable
data class ProfilePatch(
    val displayName: String? = null,
    val about: String? = null,
    val jobTitle: String? = null,
    val intention: Intention? = null,
    val modeRomance: Boolean? = null,
    val onboardingStep: Int? = null,
    val fields: List<FieldEdit>? = null,
    val prompts: List<PromptEdit>? = null,
)

/** `PATCH /v1/me/preferences`; `filters` needs the advanced-filters feature. */
@Serializable
data class PreferencesPatch(
    val interestedIn: List<Gender>? = null,
    val ageMin: Int? = null,
    val ageMax: Int? = null,
    val maxDistanceKm: Int? = null,
    val wholeCountry: Boolean? = null,
    val verifiedOnly: Boolean? = null,
    val intents: List<Intention>? = null,
    val filters: Map<String, List<Int>>? = null,
)

/** `PATCH /v1/me/settings`; `incognito` needs its feature, `snoozed` pauses discovery. */
@Serializable
data class SettingsPatch(
    val incognito: Boolean? = null,
    val hideAge: Boolean? = null,
    val hideDistance: Boolean? = null,
    val showOnline: Boolean? = null,
    val acceptCalls: Boolean? = null,
    val modeRomance: Boolean? = null,
    val snoozed: Boolean? = null,
)

@Serializable
data class NotificationPrefsPatch(
    val messages: Boolean? = null,
    val matches: Boolean? = null,
    val likes: Boolean? = null,
    val calls: Boolean? = null,
    val offers: Boolean? = null,
    val previews: Boolean? = null,
)

/**
 * `PUT /v1/me/location`. The server keeps only a coarse cell of it; the body
 * itself is never logged, here or there. A city picked from the list
 * (`source = city`) is sent as its [cityId] alone, without a position.
 */
@Serializable
data class LocationUpdate(
    val lat: Double? = null,
    val lng: Double? = null,
    val source: LocationSource,
    val accuracyM: Int? = null,
    val cityId: Int? = null,
)

@Serializable
data class LocationResult(
    val city: City? = null,
    val country: String? = null,
)

@Serializable
data class CityList(val items: List<City> = emptyList())

@Serializable
data class PhotoUploadRequest(
    /** 0-8. */
    val position: Int,
    val mime: PhotoMime,
    /** Size in bytes, at most 15 MB. */
    val bytes: Long,
)

/** A presigned PUT to the private bucket. The photo is not shown to anyone until processed and approved. */
@Serializable
data class UploadTarget(
    val url: String,
    val method: String = "PUT",
    val headers: Map<String, String> = emptyMap(),
    val expiresAt: Instant? = null,
)

@Serializable
data class PhotoUploadTicket(
    val photoId: Id,
    val upload: UploadTarget,
)

@Serializable
data class PhotoProcessing(
    val id: Id,
    val position: Int,
    val status: PhotoStatus = PhotoStatus.Processing,
)

@Serializable
data class PhotoCompleted(val photo: PhotoProcessing)

@Serializable
data class PhotoOrderRequest(val photoIds: List<Id>)

/**
 * `PUT /v1/devices/current`. [pushToken] is always sent: `null` says this
 * phone has no push (no Google Play services) or turned it off.
 */
@Serializable
data class DeviceUpdate(
    val pushToken: String?,
    val notificationsEnabled: Boolean,
    val appVersion: String,
    val locale: String,
)

/** A face-verification session; [params] is whatever the provider's SDK needs to start. */
@Serializable
data class VerificationSession(
    val id: Id,
    val provider: String? = null,
    val expiresAt: Instant? = null,
    val params: Map<String, String> = emptyMap(),
)

@Serializable
data class VerificationState(
    val status: VerificationStatus = VerificationStatus.Unknown,
    val reason: String? = null,
)
