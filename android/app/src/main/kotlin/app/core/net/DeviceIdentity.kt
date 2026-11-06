package app.core.net

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings.Secure
import app.core.storage.Preferences
import java.security.MessageDigest

/**
 * How sign-in names this phone: a random install id, and a key derived from
 * the platform's per-app device id. Neither is the hardware's serial, and
 * the raw device id never leaves the phone.
 */
interface DeviceIdentity {
    suspend fun installId(): String

    /** SHA-256 (lowercase hex) of the per-app device id. */
    fun deviceKey(): String
}

class AndroidDeviceIdentity(
    private val context: Context,
    private val preferences: Preferences,
) : DeviceIdentity {
    override suspend fun installId(): String = preferences.installId()

    // ANDROID_ID is per app signing key and per user since Android 8: it
    // tells a reinstall on the same phone apart from a new phone without
    // being an identifier other apps share.
    @SuppressLint("HardwareIds")
    override fun deviceKey(): String {
        val raw = Secure.getString(context.contentResolver, Secure.ANDROID_ID).orEmpty()
        return sha256Hex(raw)
    }

    companion object {
        fun sha256Hex(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
    }
}
