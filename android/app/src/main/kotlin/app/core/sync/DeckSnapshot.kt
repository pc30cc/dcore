package app.core.sync

import app.core.common.Diag
import app.core.model.DeckSuggestion
import app.core.model.ProfileCard
import app.core.model.PublicUid
import app.core.model.Swipe
import app.core.model.Wire
import app.core.net.CachedResponse
import app.core.net.ResponseCache
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable

/**
 * What the deck had when the app last stopped: the cards not yet swiped and
 * the swipes not yet sent. A launch starts from it, so opening the app shows
 * cards with no request at all, and a pass made just before the process died
 * is still sent.
 */
@Serializable
data class DeckSnapshot(
    val account: PublicUid,
    val savedAtMillis: Long,
    val cards: List<ProfileCard> = emptyList(),
    val pending: List<Swipe> = emptyList(),
    val suggestions: List<DeckSuggestion> = emptyList(),
    /** The last page said nobody more was coming. */
    val exhausted: Boolean = false,
) {
    companion object {
        /**
         * Cards older than this are not shown again: photo links are signed for
         * 24 hours, and someone who hid their profile since must leave the
         * phone's deck soon too. The swipes are sent whatever their age.
         */
        const val MAX_CARD_AGE_MS: Long = 6 * 60 * 60 * 1000L
    }
}

interface DeckSnapshotStore {
    suspend fun load(): DeckSnapshot?

    /** Null removes it. */
    suspend fun save(snapshot: DeckSnapshot?)
}

class MemoryDeckSnapshotStore : DeckSnapshotStore {
    @Volatile var saved: DeckSnapshot? = null

    override suspend fun load(): DeckSnapshot? = saved

    override suspend fun save(snapshot: DeckSnapshot?) {
        saved = snapshot
    }
}

/**
 * Keeps the snapshot as one row of the response cache: the same file, cleared
 * with it when someone signs in or the session is lost, and rebuilt with it
 * when it is damaged. The account inside the row is checked on load as well.
 */
class CachedDeckSnapshotStore(
    private val cache: ResponseCache,
    private val diag: Diag = Diag.Silent,
) : DeckSnapshotStore {

    override suspend fun load(): DeckSnapshot? {
        val row = cache.read(KEY) ?: return null
        return try {
            Wire.json.decodeFromString(DeckSnapshot.serializer(), row.body)
        } catch (e: CancellationException) {
            throw e
        } catch (e: SerializationException) {
            diag.warn(AREA, "deck snapshot unreadable; dropped")
            cache.remove(KEY)
            null
        } catch (e: IllegalArgumentException) {
            diag.warn(AREA, "deck snapshot unreadable; dropped")
            cache.remove(KEY)
            null
        }
    }

    override suspend fun save(snapshot: DeckSnapshot?) {
        if (snapshot == null) {
            cache.remove(KEY)
            return
        }
        val body = Wire.json.encodeToString(DeckSnapshot.serializer(), snapshot)
        cache.write(KEY, CachedResponse(etag = null, body = body, storedAtMillis = snapshot.savedAtMillis))
    }

    private companion object {
        /** Not a request's key: nothing revalidates it (no ETag). */
        const val KEY = "deck:snapshot:1"
        const val AREA = "Deck"
    }
}
