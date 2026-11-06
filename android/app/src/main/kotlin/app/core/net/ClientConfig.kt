package app.core.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /config`: what the server tells every client before anyone signs in
 * (brand texts, profile field catalog, prompts, feature flags, the minimum
 * version).
 *
 * PROVISIONAL. The server's contract for this endpoint is not written yet;
 * these are the fields the app shell needs, every one optional, and unknown
 * fields are ignored, so the server can grow the document without breaking a
 * shipped build. Align the names with the server's schema when it lands.
 */
@Serializable
data class ClientConfig(
    /** The display name `{appName}` stands for, when the server overrides the build's. */
    @SerialName("appName") val appName: String? = null,
    /** Builds below this version code must update before they can be used. Per store. */
    @SerialName("minVersionCode") val minVersionCode: Map<String, Int> = emptyMap(),
    /** Feature switches by key. Absent means off. */
    @SerialName("features") val features: Map<String, Boolean> = emptyMap(),
)
