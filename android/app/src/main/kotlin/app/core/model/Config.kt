package app.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /v1/config?store=&locale=`: what every client reads before anyone
 * signs in. Cacheable at the edge and revalidated with its `ETag`, so it
 * carries nothing per user (per-user switches are `Me.flags`).
 */
@Serializable
data class Config(
    /** The document's version counter. */
    val v: Long = 0,
    /** What `{appName}` stands for, when the server overrides the build's name. */
    val appName: String? = null,
    val colors: BrandColors? = null,
    val legal: LegalLinks = LegalLinks(),
    /** Plan key (`plus`, `premium`) to its display name, in the requested language. */
    val planNames: Map<String, String> = emptyMap(),
    /** For the store named in the query. */
    val minVersion: MinVersion = MinVersion(),
    val maintenance: Maintenance = Maintenance(),
    val auth: AuthOptions = AuthOptions(),
    val catalog: Catalog = Catalog(),
    val limits: Limits = Limits(),
    val calls: CallSwitches = CallSwitches(),
    /** Text overrides from the admin panel, for this locale only; the app ships its own strings. */
    val strings: Map<String, String> = emptyMap(),
    /** Push for the store in the query; used only by a build that has no Firebase project of its own. */
    val push: PushOptions = PushOptions(),
    /** The signed-out welcome's block from the admin panel; the app reads its pictures (the brand's own otherwise). */
    val welcome: WelcomeConfig? = null,
    /** The visual templates the admin offers and the default one; absent from a server older than templates. */
    val ui: UiConfig? = null,
)

/**
 * `config.ui`: the template a person on `default` gets ([defaultTemplate])
 * and the ids offered to choose from, in display order ([templates], which
 * always holds the default). Ids are neutral (`neon`, `white`); an id this
 * build does not ship is skipped by the effective-template rule
 * (`TemplateRule`), never an error.
 */
@Serializable
data class UiConfig(
    val defaultTemplate: String = DEFAULT_TEMPLATE,
    val templates: List<String> = DEFAULT_OFFERED,
) {
    companion object {
        const val DEFAULT_TEMPLATE: String = "neon"
        val DEFAULT_OFFERED: List<String> = listOf("neon", "white")

        /** What the server sends when the admin never set anything (and what a server without `ui` means). */
        val Default: UiConfig = UiConfig()
    }
}

/**
 * The welcome screen's block, for the requested locale only (like
 * [Config.strings]). Every field is optional. The welcome draws [images]
 * (the brand's own pictures when there are none); its title is the app's
 * own string, so the texts and the gradient are read but not drawn.
 */
@Serializable
data class WelcomeConfig(
    /** The small line above the headline. */
    val eyebrow: String? = null,
    /** The headline (words between asterisks were the emphasis). */
    val headline: String? = null,
    val subtitle: String? = null,
    val gradient: WelcomeGradient? = null,
    /** Picture URLs for the welcome (brand pictures, never a member's photo); cached like photos. */
    val images: List<String> = emptyList(),
)

/** Three `#RRGGBB` colours, top to bottom. */
@Serializable
data class WelcomeGradient(
    val top: String,
    val middle: String,
    val bottom: String,
)

@Serializable
data class PushOptions(val firebase: FirebaseClient? = null)

/** A Firebase project's public client values (the same names as the brand file's). None of them is a credential. */
@Serializable
data class FirebaseClient(
    val appId: String = "",
    val apiKey: String = "",
    val projectId: String = "",
    val projectNumber: String = "",
)

@Serializable
data class ThemedColor(val light: String, val dark: String)

@Serializable
data class BrandColors(
    val brand: ThemedColor? = null,
    val onBrand: ThemedColor? = null,
)

@Serializable
data class LegalLinks(
    val privacyUrl: String = "",
    val termsUrl: String = "",
    val guidelinesUrl: String = "",
    val childSafetyUrl: String = "",
    val deleteAccountUrl: String = "",
    val supportEmail: String = "",
    /** The text versions a person must have accepted. */
    val versions: LegalVersions = LegalVersions(),
)

/** Version codes: below [required] the app cannot be used; below [recommended] it suggests an update. */
@Serializable
data class MinVersion(
    val required: Int = 0,
    val recommended: Int = 0,
)

@Serializable
data class Maintenance(
    val enabled: Boolean = false,
    val message: String? = null,
)

@Serializable
data class AuthOptions(
    val otpLength: Int = 6,
    val methods: List<AuthMethod> = listOf(AuthMethod.Phone),
)

/** One choice of a profile field. */
@Serializable
data class FieldOption(
    val id: Int,
    val label: String,
)

/**
 * A profile field the admin panel defines. Which value a [ProfileFieldValue]
 * carries follows [kind]: `single` → `option`, `multi` → `options`,
 * `number` → `number` (between [min] and [max]), `text` → `text`.
 */
@Serializable
data class FieldDef(
    val id: Int,
    val key: String = "",
    val label: String = "",
    val kind: String = "",
    val options: List<FieldOption> = emptyList(),
    val min: Int? = null,
    val max: Int? = null,
    val unit: String? = null,
    /** Shown to its holder only. */
    @SerialName("private") val isPrivate: Boolean = false,
    /** Usable as an advanced filter. */
    val filterable: Boolean = false,
    /** A special category (religion, ...): stored only with the sensitive-fields consent. */
    val sensitive: Boolean = false,
    /** Must be answered before the profile is complete. */
    val required: Boolean = false,
)

@Serializable
data class PromptDef(
    val id: Int,
    val text: String,
    val category: String? = null,
)

/** A labelled choice from a catalogue list (intentions, report reasons, deletion reasons). */
@Serializable
data class CatalogEntry(
    val key: String,
    val label: String,
)

@Serializable
data class Catalog(
    val fields: List<FieldDef> = emptyList(),
    val prompts: List<PromptDef> = emptyList(),
    val intentions: List<CatalogEntry> = emptyList(),
    val reportReasons: List<CatalogEntry> = emptyList(),
    val deletionReasons: List<CatalogEntry> = emptyList(),
)

@Serializable
data class Limits(
    val photosMax: Int = 9,
    val photosMin: Int = 2,
    val promptsMax: Int = 3,
    val aboutMax: Int = 500,
    val messageMax: Int = 2000,
    val commentMax: Int = 300,
)

/** Whether audio and video calls are switched on at all. */
@Serializable
data class CallSwitches(
    val audio: Boolean = false,
    val video: Boolean = false,
)
