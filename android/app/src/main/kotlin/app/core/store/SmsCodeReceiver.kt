package app.core.store

import android.content.Context
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

/**
 * Reads a sign-in code out of the text message that carries it, without the
 * SMS permission (on Play: the SMS Retriever API, which matches the message
 * by the app's hash). The Cafe Bazaar build has none: [None]; there the code
 * comes from the keyboard's suggestion (autofill) or is typed.
 */
interface SmsCodeReceiver {
    /**
     * The 11-character hash the message must carry for this app (sent to the
     * server with the code request), or null when this build has no
     * retriever.
     */
    fun appHash(context: Context): String?

    /**
     * Listens for one message for as long as the flow is collected (the
     * platform gives up after five minutes), and emits the [length]-digit
     * code it finds.
     */
    fun codes(context: Context, length: Int): Flow<String>

    object None : SmsCodeReceiver {
        override fun appHash(context: Context): String? = null
        override fun codes(context: Context, length: Int): Flow<String> = emptyFlow()
    }

    companion object {
        /**
         * The code in [message]: the first run of exactly [length] digits
         * (Persian and Arabic-Indic digits included, returned as ASCII).
         */
        fun extractCode(message: String, length: Int): String? {
            if (length <= 0) return null
            val ascii = buildString(message.length) {
                for (c in message) append(asciiDigit(c) ?: c)
            }
            return Regex("(?<![0-9])[0-9]{$length}(?![0-9])").find(ascii)?.value
        }

        /** '0'-'9' for an ASCII, Persian (۰-۹) or Arabic-Indic (٠-٩) digit, else null. */
        fun asciiDigit(c: Char): Char? = when (c) {
            in '0'..'9' -> c
            in '۰'..'۹' -> '0' + (c - '۰')
            in '٠'..'٩' -> '0' + (c - '٠')
            else -> null
        }
    }
}
