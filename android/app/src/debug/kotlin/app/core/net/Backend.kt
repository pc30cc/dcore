package app.core.net

import android.content.Context
import app.core.BuildConfig
import app.core.common.Clock
import java.io.File

/**
 * Chooses the backend for this launch. **Debug build.**
 *
 * The app talks to the real server. The in-memory [SampleApi] exists to lay
 * out and screenshot screens that otherwise need a live account, and to run
 * UI tests with no account, no network and no credentials. It is fenced off
 * twice over:
 *
 * - It is compiled into debug builds only: it and this file live in
 *   `src/debug`, and a release build has its own [Backend] (in `src/release`)
 *   that cannot name `SampleApi`, because `SampleApi` is not on its classpath.
 * - Even in debug it needs an explicit switch: the JVM property `app.sample`
 *   set to `true` (tests), the environment variable `APP_SAMPLE=1`, or the
 *   marker file [SAMPLE_MARKER] in the app's files directory
 *   (`adb shell run-as <applicationId> touch files/sample-backend`). No
 *   setting, gesture or server answer reaches it.
 */
object Backend {
    const val SAMPLE_PROPERTY = "app.sample"
    const val SAMPLE_ENV = "APP_SAMPLE"
    const val SAMPLE_MARKER = "sample-backend"

    fun isSample(context: Context?): Boolean =
        System.getProperty(SAMPLE_PROPERTY) == "true" ||
            System.getenv(SAMPLE_ENV) == "1" ||
            (context != null && File(context.filesDir, SAMPLE_MARKER).exists())

    /** [real] is built only when it is the one used. */
    fun create(context: Context, clock: Clock, real: () -> ServerApi): ServerApi =
        if (isSample(context)) SampleApi(store = BuildConfig.STORE, clock = clock) else real()
}
