package app.core.push

/** Whether this phone can receive pushes, and if not, why. */
enum class PushAvailability {
    /** Google Play services is there and the build (or the server) named a Firebase project. */
    AVAILABLE,

    /**
     * No usable Google Play services (many phones that install from Cafe
     * Bazaar): nothing reaches the phone while the app is closed. The app
     * receives everything over realtime while it is open, and tells the
     * server it has no push token so no push is attempted.
     */
    NO_PLAY_SERVICES,

    /** Play services is there, but no Firebase project was given (a build without one, the sample backend). */
    NOT_CONFIGURED,
}

/**
 * Where push tokens come from. FCM in both store builds ([FirebasePush]);
 * another transport would implement the same three calls (and the server
 * would need to know it).
 */
interface PushTransport {
    fun availability(): PushAvailability

    /** The current token, minting one if needed. Null when [availability] is not [PushAvailability.AVAILABLE]. */
    suspend fun token(): String?

    /**
     * Forgets the token, so the next one is new. Done at sign-out: whatever
     * a stale message addressed to the old token says, it can no longer
     * reach this phone.
     */
    suspend fun deleteToken()

    /** No push at all: tests, and builds where push is switched off. */
    object None : PushTransport {
        override fun availability(): PushAvailability = PushAvailability.NOT_CONFIGURED
        override suspend fun token(): String? = null
        override suspend fun deleteToken() = Unit
    }
}
