package app.core.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences as DataStorePreferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.core.common.Diag
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
 * Small values kept on the phone, with credentials encrypted.
 *
 * An interface so what is built on it (the session, the preferences) is
 * tested on the JVM, where the Android Keystore does not exist.
 */
interface SecretStore {
    /** A credential, decrypted; null when absent or when its key is gone (an ordinary "signed out"). */
    suspend fun readSecret(name: String): String?

    /** Seals and stores a credential; null removes it. */
    suspend fun writeSecret(name: String, value: String?)

    // Plain values: settings, not credentials.
    suspend fun read(name: String): String?
    suspend fun write(name: String, value: String)
    suspend fun remove(name: String)
}

/**
 * A file that no longer reads (a crash mid-write on an old device, a full
 * disk) is started again empty instead of failing every read for ever, which
 * would be an app that crashes at launch until its data is cleared by hand.
 * What is lost is a preference and a sign-in.
 *
 * The file name is a fixed neutral constant: never derived from the brand, so
 * a rebrand signs nobody out.
 */
private val Context.appStore by preferencesDataStore(
    name = "session",
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
)

/**
 * [SecretStore] on DataStore, with credentials sealed by a key the app can use
 * but never read out.
 *
 * A credential is sealed with AES-GCM under a key generated inside the
 * Android Keystore, and only the ciphertext reaches DataStore. The key does
 * not require an unlocked screen (the app refreshes in the background after a
 * push), is not exportable and does not survive a restore onto another
 * device; `data_extraction_rules.xml` keeps the file out of backups and
 * transfers too, so a new phone asks for a sign-in.
 *
 * Every read and write runs on IO, whoever asks: the Keystore is a call into
 * another process, and DataStore runs an edit's transform in the caller's
 * context while it holds the file's write lock, so an edit launched from a
 * screen's scope would otherwise wait on that screen's dispatcher.
 */
class SecureStore(
    private val context: Context,
    private val diag: Diag = Diag.Android,
) : SecretStore {
    private companion object {
        const val AREA = "Secure"

        /** Fixed and neutral, like the file name: a rebrand must not lose the key. */
        const val KEY_ALIAS = "app.session"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val IV_BYTES = 12
    }

    // Inside the IO block, not around it: a caller cancelled mid-read must
    // hear the cancellation, not get "no session", which a caller would keep
    // as this run's answer and show a signed-in person the sign-in screen.
    override suspend fun readSecret(name: String): String? = read(name)?.let { sealed ->
        withContext(Dispatchers.IO) {
            runCatching { decrypt(sealed) }
                .onFailure {
                    // The key is gone: the app was reinstalled, or the lock
                    // screen changed in a way that invalidated it. Nobody is
                    // signed in; an ordinary answer, not a bug.
                    diag.info(AREA, "a stored credential could not be decrypted; treating it as absent")
                }
                .getOrNull()
        }
    }

    override suspend fun writeSecret(name: String, value: String?) {
        if (value == null) {
            remove(name)
            return
        }
        val sealed = withContext(Dispatchers.IO) { runCatching { encrypt(value) } }
        sealed.mapCatching { write(name, it) }.onFailure {
            // Logged, not thrown: the app keeps working on the copy in memory
            // and the next launch asks for a sign-in, with this line to say why.
            diag.warn(AREA, "could not store a credential (${it.javaClass.simpleName}); the next launch signs in again")
        }
    }

    /** A read that fails is an unset value, not a crash: callers already handle "not set". */
    override suspend fun read(name: String): String? = withContext(Dispatchers.IO) {
        context.appStore.data
            .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
            .first()[key(name)]
    }

    override suspend fun write(name: String, value: String) {
        withContext(Dispatchers.IO) { context.appStore.edit { it[key(name)] = value } }
    }

    override suspend fun remove(name: String) {
        withContext(Dispatchers.IO) { context.appStore.edit { it.remove(key(name)) } }
    }

    private fun key(name: String): DataStorePreferences.Key<String> = stringPreferencesKey(name)

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Background work after a push must be able to read it.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    /** `base64(iv ‖ ciphertext)`: the IV is not a secret and travels with it. */
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

/** In memory, for JVM tests and as a stand-in nothing persists through. */
class MemorySecretStore : SecretStore {
    private val secrets = mutableMapOf<String, String>()
    private val plain = mutableMapOf<String, String>()

    /** What a test can inspect: the credentials as stored. */
    val storedSecrets: Map<String, String> get() = synchronized(this) { secrets.toMap() }

    override suspend fun readSecret(name: String): String? = synchronized(this) { secrets[name] }

    override suspend fun writeSecret(name: String, value: String?) {
        synchronized(this) { if (value == null) secrets.remove(name) else secrets[name] = value }
    }

    override suspend fun read(name: String): String? = synchronized(this) { plain[name] }

    override suspend fun write(name: String, value: String) {
        synchronized(this) { plain[name] = value }
    }

    override suspend fun remove(name: String) {
        synchronized(this) {
            plain.remove(name)
            secrets.remove(name)
        }
    }
}
