package app.core.push

import app.core.CoreApp
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Where FCM hands this app its messages and its tokens.
 *
 * Notification pushes arriving while the app is in the background are drawn
 * by the system from the server's text: this class is not called for them,
 * no socket is opened and nothing is polled. Rings are data-only, so they
 * land here in every state of the app, cold included; so does every push
 * while the app is in front. Both go to [PushRouter], within FCM's time for
 * a message (the work is local, bounded here).
 */
class PushMessagingService : FirebaseMessagingService() {

    @Deprecated("FCM 25.1 replaces it with onRegistered; both say the same here.")
    override fun onNewToken(token: String) {
        // The token itself is not taken from here: the registrar asks
        // Firebase for the current one, so there is exactly one source for
        // it. This says "register again", on WorkManager, because it can run
        // with no screen and no network.
        PushRegistrationWorker.enqueue(applicationContext, reason = "token rotated")
    }

    override fun onRegistered(token: String) {
        PushRegistrationWorker.enqueue(applicationContext, reason = "token rotated")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val graph = (application as? CoreApp)?.graph ?: return
        runBlocking {
            withTimeoutOrNull(HANDLE_TIMEOUT_MS) {
                graph.push.router.onMessage(
                    data = message.data,
                    title = message.notification?.title,
                    body = message.notification?.body,
                    sentTimeMillis = message.sentTime,
                )
            }
        }
    }

    private companion object {
        /** FCM allows about 20 s; a ring needs its photo within 2 s. */
        const val HANDLE_TIMEOUT_MS = 8_000L
    }
}
