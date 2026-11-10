package app.core.storage

import java.util.UUID

/**
 * The choices and markers that must survive a restart. Plain values, not
 * credentials. The language and the theme are not here: they must be known
 * before the first frame (see `AppLocales` and `TemplateStore`).
 *
 * Key names are fixed neutral constants, never derived from the brand.
 */
class Preferences(private val store: SecretStore) {
    private companion object {
        const val INSTALL_ID = "prefs.installId"
        const val PENDING_SIGN_OUT = "session.pendingSignOut"
        const val SIGNED_IN_AS = "session.signedInAs"
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

    /**
     * What the account was signed in with on this phone (the number in E.164,
     * or the Google account's address), for Settings to show; sealed with the
     * session's key, never sent anywhere, forgotten at sign-out. Null when
     * this phone did not see the sign-in (an older install).
     */
    suspend fun signedInAs(): String? {
        if (signedInKnown) return signedIn
        return store.readSecret(SIGNED_IN_AS)?.takeIf { it.isNotBlank() }.also {
            signedIn = it
            signedInKnown = true
        }
    }

    /** Kept in memory as well: a phone whose key store refuses the write still shows it until the app restarts. */
    suspend fun rememberSignIn(identity: String?) {
        val value = identity?.takeIf { it.isNotBlank() }
        signedIn = value
        signedInKnown = true
        store.writeSecret(SIGNED_IN_AS, value)
    }

    @Volatile private var signedIn: String? = null

    @Volatile private var signedInKnown = false
}
