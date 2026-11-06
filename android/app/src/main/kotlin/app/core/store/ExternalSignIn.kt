package app.core.store

import android.app.Activity

/**
 * Signing in with an account the phone already holds (on Play: Google,
 * through Credential Manager). The Cafe Bazaar build has none: [None].
 *
 * The app never reads the person's e-mail or name from it: the ID token goes
 * to the server, which identifies the account by the provider's subject.
 */
interface ExternalSignIn {
    /** Whether this build can offer it at all (configured, and the store's build). */
    val available: Boolean

    /**
     * Shows the account picker and returns an ID token bound to [nonce] (the
     * server's one-time value). [silentFirst]: try an account that signed in
     * here before without asking, then the picker.
     */
    suspend fun signIn(activity: Activity, nonce: String, silentFirst: Boolean = false): ExternalSignInResult

    /** Forgets the chosen account on this phone, so the next sign-in asks again. */
    suspend fun signOut()

    object None : ExternalSignIn {
        override val available: Boolean = false
        override suspend fun signIn(activity: Activity, nonce: String, silentFirst: Boolean): ExternalSignInResult =
            ExternalSignInResult.Unavailable
        override suspend fun signOut() = Unit
    }
}

sealed interface ExternalSignInResult {
    data class Token(val idToken: String) : ExternalSignInResult

    /** The person closed the picker. Nothing to say. */
    data object Cancelled : ExternalSignInResult

    /** No account on the phone to pick. */
    data object NoAccount : ExternalSignInResult

    /** Not in this build, or not configured. */
    data object Unavailable : ExternalSignInResult

    data class Failed(val detail: String?) : ExternalSignInResult
}
