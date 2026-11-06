package app.core.diag

import android.util.Log
import kotlin.coroutines.cancellation.CancellationException

/**
 * What the app says about itself in logcat.
 *
 * The rule for every call site: counts, reasons, durations, status codes and
 * shortened ids. Never a message, a name, a phone number, a token, a purchase
 * token or a location: logcat is readable by anyone holding the phone over adb.
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

/**
 * [runCatching] without the part that catches cancellation.
 *
 * `runCatching` around a suspending call also catches the
 * `CancellationException` that unwinds a cancelled coroutine and reports it as
 * a failure, which then shows an error to a screen that has already gone
 * away. Rethrowing lets cancellation do its job.
 */
inline fun <T> runCatchingUnlessCancelled(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        Result.failure(error)
    }
