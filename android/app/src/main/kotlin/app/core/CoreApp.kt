package app.core

import android.app.Application
import androidx.work.Configuration
import app.core.push.PushChannels
import app.core.push.PushConfig

/**
 * The process. [onCreate] does only what must exist before anything else can
 * run, and nothing that costs a cold start: the Firebase app a push is
 * delivered through (no network, no token), and the notification channels a
 * background push is drawn in. The graph is built the first time something
 * asks for it.
 *
 * WorkManager is started on demand from [workManagerConfiguration] instead
 * of by its content provider at every launch (see the manifest).
 */
class CoreApp : Application(), Configuration.Provider {
    val graph: AppGraph by lazy { AppGraph(this) }

    override fun onCreate() {
        super.onCreate()
        PushConfig.initialize(this)
        PushChannels.ensure(this)
    }

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setMinimumLoggingLevel(android.util.Log.WARN).build()
}
