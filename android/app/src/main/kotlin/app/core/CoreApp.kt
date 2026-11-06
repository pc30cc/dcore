package app.core

import android.app.Application

/**
 * The process. [onCreate] does nothing that costs a cold start: the graph is
 * built the first time something asks for it.
 */
class CoreApp : Application() {
    val graph: AppGraph by lazy { AppGraph(this) }
}
