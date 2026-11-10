package app.core.net

import android.content.Context
import app.core.common.Clock
import app.core.store.StoreBilling

/**
 * Chooses the backend for this launch. **Release build.**
 *
 * There is no choice to make. `SampleApi` lives in `src/debug` and is not on
 * this build's classpath, so a shipped app cannot reach it however hard
 * anything tries: no flag, no file, no server answer.
 *
 * Keeping the two files in step is the price of that guarantee: a change to
 * the debug [Backend]'s signature has to be made here too, and the build says
 * so at once rather than at run time.
 */
object Backend {
    @Suppress("UNUSED_PARAMETER", "FunctionOnlyReturningConstant")
    fun isSample(context: Context?): Boolean = false

    @Suppress("UNUSED_PARAMETER")
    fun create(context: Context, clock: Clock, settingsTap: SettingsTap, real: () -> ServerApi): ServerApi = real()

    @Suppress("UNUSED_PARAMETER")
    fun billing(context: Context, real: () -> StoreBilling): StoreBilling = real()
}
