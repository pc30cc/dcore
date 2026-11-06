package app.core.store

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.os.BundleCompat
import app.core.common.Diag
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emptyFlow
import java.security.MessageDigest

/**
 * The SMS Retriever API: the code is read from the one message that ends
 * with this app's hash, without the SMS permission. **Play build only.**
 *
 * Without Google Play services it does nothing (and says so to no one): the
 * code is then typed, or offered by the keyboard.
 */
internal class PlaySmsRetriever(private val diag: Diag) : SmsCodeReceiver {

    private var cachedHash: String? = null

    override fun appHash(context: Context): String? {
        cachedHash?.let { return it }
        if (!servicesAvailable(context)) return null
        return computeHash(context)?.also { cachedHash = it }
    }

    override fun codes(context: Context, length: Int): Flow<String> {
        val app = context.applicationContext
        if (!servicesAvailable(app)) return emptyFlow()
        return callbackFlow {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
                    val extras = intent.extras ?: return
                    val status = BundleCompat.getParcelable(extras, SmsRetriever.EXTRA_STATUS, Status::class.java) ?: return
                    if (status.statusCode == CommonStatusCodes.SUCCESS) {
                        val message = extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE).orEmpty()
                        SmsCodeReceiver.extractCode(message, length)?.let { trySend(it) }
                    }
                    // TIMEOUT (five minutes) ends listening; typing still works.
                }
            }
            ContextCompat.registerReceiver(
                app,
                receiver,
                IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
                SmsRetriever.SEND_PERMISSION,
                null,
                ContextCompat.RECEIVER_EXPORTED,
            )
            runCatching { SmsRetriever.getClient(app).startSmsRetriever().await() }
                .onFailure { diag.info(AREA, "retriever did not start: ${it.javaClass.simpleName}") }
            awaitClose { runCatching { app.unregisterReceiver(receiver) } }
        }
    }

    private fun servicesAvailable(context: Context): Boolean =
        GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS

    /**
     * The 11 characters SMS Retriever matches: base64 of the first 9 bytes of
     * SHA-256("<package> <signing certificate>"). It follows the key the
     * installed copy is signed with, so a Play-installed copy and a local
     * build have different hashes; the server only passes it into the text.
     */
    @SuppressLint("PackageManagerGetSignatures")
    private fun computeHash(context: Context): String? = runCatching {
        val pm = context.packageManager
        val signatures: Array<Signature> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            info.signingInfo?.apkContentsSigners ?: emptyArray()
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures ?: emptyArray()
        }
        val signature = signatures.firstOrNull() ?: return null
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${context.packageName} ${signature.toCharsString()}".toByteArray(Charsets.UTF_8))
        Base64.encodeToString(digest.copyOfRange(0, 9), Base64.NO_PADDING or Base64.NO_WRAP).substring(0, 11)
    }.onFailure { diag.info(AREA, "app hash unavailable: ${it.javaClass.simpleName}") }.getOrNull()

    private companion object {
        const val AREA = "SmsRetriever"
    }
}
