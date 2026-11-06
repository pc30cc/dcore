package app.core.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.core.diag.Diag
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.io.IOException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * A file that no longer reads (a crash mid-write, a full disk) starts again
 * empty instead of failing every read for ever: what is lost is a sign-in.
 */
private val Context.sessionStore by preferencesDataStore(
    name = "session",
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
)

/**
 * Small values the app keeps, with credentials encrypted by a key the app can
 * use but never read out.
 *
 * A credential ([readSecret], [writeSecret]) is sealed with AES-GCM under a key
 * generated inside the Android Keystore, and only the ciphertext reaches
 * DataStore. The key does not require an unlocked screen (the app refreshes in
 * the background after a push), is not exportable and does not survive a
 * restore onto another device; `data_extraction_rules.xml` keeps the file out
 * of backups and transfers too, so a new phone asks for a sign-in.
 */
class SecureStore(
    private val context: Context,
    private val diag: Diag = Diag.Android,
) {
    private companion object {
        const val AREA = "Secure"
        const val KEY_ALIAS = "app.session"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val IV_BYTES = 12
    }

    /** A credential, decrypted; null when absent or when its key is gone (an ordinary "signed out"). */
    suspend fun readSecret(name: String): String? = read(name)?.let { sealed ->
        withContext(Dispatchers.IO) {
            runCatching { decrypt(sealed) }
                .onFailure { diag.info(AREA, "a stored credential could not be decrypted; treating it as absent") }
                .getOrNull()
        }
    }

    suspend fun writeSecret(name: String, value: String?) {
        if (value == null) {
            remove(name)
            return
        }
        val sealed = withContext(Dispatchers.IO) { runCatching { encrypt(value) } }
        sealed.mapCatching { write(name, it) }.onFailure {
            diag.warn(AREA, "could not store a credential (${it.javaClass.simpleName}); the next launch signs in again")
        }
    }

    // Plain values: settings, not credentials. All on IO, whoever asks.

    suspend fun read(name: String): String? = withContext(Dispatchers.IO) {
        context.sessionStore.data
            .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
            .first()[key(name)]
    }

    suspend fun write(name: String, value: String) {
        withContext(Dispatchers.IO) { context.sessionStore.edit { it[key(name)] = value } }
    }

    suspend fun remove(name: String) {
        withContext(Dispatchers.IO) { context.sessionStore.edit { it.remove(key(name)) } }
    }

    private fun key(name: String): Preferences.Key<String> = stringPreferencesKey(name)

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "unexpected GCM IV length ${iv.size}" }
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + sealed, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        require(bytes.size > IV_BYTES) { "sealed value too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, bytes, 0, IV_BYTES))
        return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    }
}
