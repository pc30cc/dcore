package app.core.common

import android.util.Log

/**
 * What the app says about itself in logcat.
 *
 * `adb logcat -s App.Http App.Cache App.Session` reads the story of a
 * session: cache hits, refreshes, retries, status codes.
 *
 * The rule for every call site: counts, reasons, durations, status codes,
 * route names and shortened ids. Never a message body, a name, a phone number,
 * a token, a purchase token, a code or a location: logcat is readable by
 * anyone holding the phone over adb.
 *
 * The tag prefix is a fixed neutral constant, never the brand's name, so a
 * rebrand changes nothing a field report is filtered by.
 */
interface Diag {
    fun info(area: String, message: String)
    fun warn(area: String, message: String)

    /** Logcat, in every build: these lines are what a field report is diagnosed from. */
    object Android : Diag {
        private const val PREFIX = "App."

        override fun info(area: String, message: String) {
            runCatching { Log.i(PREFIX + area, message) }
        }

        override fun warn(area: String, message: String) {
            runCatching { Log.w(PREFIX + area, message) }
        }
    }

    object Silent : Diag {
        override fun info(area: String, message: String) = Unit
        override fun warn(area: String, message: String) = Unit
    }

    /** For tests that assert on what was (and was not) logged. */
    class Recording : Diag {
        private val _lines = mutableListOf<String>()
        val lines: List<String> get() = synchronized(_lines) { _lines.toList() }

        override fun info(area: String, message: String) {
            synchronized(_lines) { _lines += "I/$area: $message" }
        }

        override fun warn(area: String, message: String) {
            synchronized(_lines) { _lines += "W/$area: $message" }
        }
    }

    companion object {
        /** An id shortened to something that tells two apart and names nobody. */
        fun id(value: String?): String = value?.take(8) ?: "-"
    }
}
