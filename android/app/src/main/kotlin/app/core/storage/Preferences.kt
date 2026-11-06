package app.core.storage

import java.util.UUID

/**
 * The choices and markers that must survive a restart. Plain values, not
 * credentials. The language is not here: it must be known before the first
 * frame (see `AppLocales`).
 *
 * Key names are fixed neutral constants, never derived from the brand.
 */
class Preferences(private val store: SecretStore) {
    private companion object {
        const val INSTALL_ID = "prefs.installId"
        const val APPEARANCE = "prefs.appearance"
        const val PENDING_SIGN_OUT = "session.pendingSignOut"
    }

    /**
     * A random id for this install, made on first use and sent at sign-in.
     * Not derived from the hardware and not backed up: a reinstall or a new
     * phone is a new install.
     */
    suspend fun installId(): String {
        store.read(INSTALL_ID)?.takeIf { it.isNotBlank() }?.let { return it }
        val fresh = UUID.randomUUID().toString()
        store.write(INSTALL_ID, fresh)
        return fresh
    }

    suspend fun appearance(): Appearance = Appearance.from(store.read(APPEARANCE)) ?: Appearance.SYSTEM

    suspend fun setAppearance(appearance: Appearance) {
        store.write(APPEARANCE, appearance.key)
    }

    /**
     * A sign-out whose clean-up has not finished: written before the clean-up
     * starts and removed when it is done, so a process that ends half-way
     * finishes at the next launch instead of leaving notifications and the
     * push token behind.
     */
    suspend fun pendingSignOut(): Boolean = store.read(PENDING_SIGN_OUT) == "1"

    suspend fun setPendingSignOut(pending: Boolean) {
        if (pending) store.write(PENDING_SIGN_OUT, "1") else store.remove(PENDING_SIGN_OUT)
    }
}

/** Light, dark, or whatever the phone is doing (the default). */
enum class Appearance(val key: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
    ;

    companion object {
        fun from(key: String?): Appearance? = entries.firstOrNull { it.key == key }
    }
}
