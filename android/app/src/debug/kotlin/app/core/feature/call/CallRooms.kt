package app.core.feature.call

import android.content.Context
import app.core.net.SampleApi
import app.core.net.ServerApi

/**
 * Builds the media room for a call. **Debug build.**
 *
 * With the in-memory sample backend there is no media server to join, so a
 * call gets [SimulatedCallRoom], which joins at once and puts a simulated
 * other person in the room: the whole call flow (ring, answer, live, end, the
 * notifications and the service) can be walked through and screenshotted. It
 * carries no audio and no video, and nothing about it reaches a release
 * build. With the real server the room is the real one.
 */
object CallRooms {
    fun create(context: Context, api: ServerApi): CallRoom =
        if (api is SampleApi) SimulatedCallRoom() else LiveKitRoom(context)
}
