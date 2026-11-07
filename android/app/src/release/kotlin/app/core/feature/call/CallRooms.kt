package app.core.feature.call

import android.content.Context
import app.core.net.ServerApi

/**
 * Builds the media room for a call. **Release build**: always the real one.
 * The simulated room lives in `src/debug` and is not on this build's
 * classpath, so a shipped call can only ever be a real call.
 */
object CallRooms {
    @Suppress("UNUSED_PARAMETER")
    fun create(context: Context, api: ServerApi): CallRoom = LiveKitRoom(context)
}
