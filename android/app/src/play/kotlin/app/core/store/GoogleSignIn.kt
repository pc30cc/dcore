package app.core.store

import android.app.Activity
import android.content.Context
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import app.core.common.Diag
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import kotlinx.coroutines.CancellationException

/**
 * Sign in with Google through Credential Manager. **Play build only**: the
 * Bazaar build has no class of this name and no Credential Manager on its
 * classpath.
 *
 * [webClientId] is the OAuth web client the server verifies tokens against
 * (`-Pplay.googleWebClientId`); empty means not configured, and the button is
 * not offered.
 *
 * The token is bound to the server's one-time nonce. Nothing else from the
 * Google account (name, e-mail, picture) is read or kept.
 */
internal class GoogleSignIn(
    context: Context,
    private val webClientId: String,
    private val diag: Diag,
) : ExternalSignIn {

    private val manager = CredentialManager.create(context.applicationContext)

    override val available: Boolean = webClientId.isNotBlank()

    override suspend fun signIn(activity: Activity, nonce: String, silentFirst: Boolean): ExternalSignInResult {
        if (!available) return ExternalSignInResult.Unavailable
        if (silentFirst) {
            // An account that signed in here before, without the sheet asking.
            val quiet = GetGoogleIdOption.Builder()
                .setFilterByAuthorizedAccounts(true)
                .setAutoSelectEnabled(true)
                .setServerClientId(webClientId)
                .setNonce(nonce)
                .build()
            when (val result = request(activity, GetCredentialRequest.Builder().addCredentialOption(quiet).build())) {
                is ExternalSignInResult.Token, ExternalSignInResult.Cancelled -> return result
                else -> Unit
            }
        }
        // The visible button: works with no account signed in here yet, and
        // after the person dismissed the bottom sheet before.
        val button = GetSignInWithGoogleOption.Builder(webClientId).setNonce(nonce).build()
        return request(activity, GetCredentialRequest.Builder().addCredentialOption(button).build())
    }

    private suspend fun request(activity: Activity, request: GetCredentialRequest): ExternalSignInResult =
        try {
            val credential = manager.getCredential(activity, request).credential
            if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                ExternalSignInResult.Token(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } else {
                diag.warn(AREA, "unexpected credential type")
                ExternalSignInResult.Failed("credential type")
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (e: GetCredentialCancellationException) {
            ExternalSignInResult.Cancelled
        } catch (e: NoCredentialException) {
            ExternalSignInResult.NoAccount
        } catch (e: GoogleIdTokenParsingException) {
            diag.warn(AREA, "ID token did not parse")
            ExternalSignInResult.Failed("parse")
        } catch (e: GetCredentialException) {
            diag.warn(AREA, "credential request failed: ${e.type}")
            ExternalSignInResult.Failed(e.type)
        }

    override suspend fun signOut() {
        try {
            manager.clearCredentialState(ClearCredentialStateRequest())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (e: Exception) {
            diag.info(AREA, "clearing the credential state failed: ${e.javaClass.simpleName}")
        }
    }

    private companion object {
        const val AREA = "GoogleSignIn"
    }
}
