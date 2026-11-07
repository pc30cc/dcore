package app.core.sync

import app.core.model.ProfileCard
import app.core.model.PublicUid

/**
 * The cards waiting to be shown, top first, and the people already handled
 * this session.
 *
 * `GET /v1/deck` reads from the head of the server's queue, and a card leaves
 * that queue only when its swipe arrives. So a page asked for while cards are
 * still on the phone, or while passes are still in the batch, repeats people
 * the phone already has; [add] drops them. A card someone has already swiped
 * here never comes back in the same session, whatever a page says, until
 * [restore] (rewind) or [clear] (filters changed).
 *
 * Not thread-safe: the deck repository calls it from one thread.
 */
class DeckQueue(
    /** At or below this many queued cards, the next page is wanted. */
    val refillAt: Int = REFILL_AT,
) {
    private val cards = ArrayList<ProfileCard>()
    private val handled = LinkedHashSet<PublicUid>()

    val size: Int get() = cards.size
    val isEmpty: Boolean get() = cards.isEmpty()
    val top: ProfileCard? get() = cards.firstOrNull()

    /** The queue, top first. A copy. */
    fun snapshot(): List<ProfileCard> = cards.toList()

    /** The first [count] cards, top first. */
    fun peek(count: Int): List<ProfileCard> = cards.take(count.coerceAtLeast(0))

    fun contains(id: PublicUid): Boolean = cards.any { it.id == id }

    fun wasHandled(id: PublicUid): Boolean = id in handled

    /** Whether the next page should be asked for now. */
    val wantsMore: Boolean get() = cards.size <= refillAt

    /**
     * Appends the new people of a page, in the server's order, and returns how
     * many were new. A card already queued is replaced in place when the page
     * carries a newer version of it (`v`): the person edited their profile.
     */
    fun add(page: List<ProfileCard>): Int {
        var added = 0
        for (card in page) {
            if (card.id in handled) continue
            val index = cards.indexOfFirst { it.id == card.id }
            if (index >= 0) {
                if (card.v > cards[index].v) cards[index] = card
                continue
            }
            cards += card
            added++
        }
        return added
    }

    /**
     * Takes [id] out of the queue and remembers it as handled. Returns the card,
     * or null when it was not queued (it is still remembered: a like from the
     * likes list must keep the same person out of the deck).
     */
    fun remove(id: PublicUid): ProfileCard? {
        handled += id
        val index = cards.indexOfFirst { it.id == id }
        return if (index >= 0) cards.removeAt(index) else null
    }

    /** Puts [card] back on top: a rewind, or a like that did not go through. */
    fun restore(card: ProfileCard) {
        handled -= card.id
        cards.removeAll { it.id == card.id }
        cards.add(0, card)
    }

    /** Remembers [ids] as handled without a card: swipes from an earlier launch still on their way. */
    fun markHandled(ids: Collection<PublicUid>) {
        handled += ids
        cards.removeAll { it.id in ids }
    }

    /** Drops the people in [ids] (blocked, or hidden from this account), without marking them handled. */
    fun drop(ids: Set<PublicUid>) {
        cards.removeAll { it.id in ids }
    }

    /** Forgets everything: the filters changed, or another account signed in. */
    fun clear() {
        cards.clear()
        handled.clear()
    }

    /** Starts from a saved queue (the previous launch's cards). */
    fun load(saved: List<ProfileCard>) {
        cards.clear()
        add(saved)
    }

    /** Every photo URL of the top card and the [ahead] cards after it, first photos first. */
    fun photosToPreload(ahead: Int = PRELOAD_AHEAD): List<String> = preloadUrls(cards, ahead)

    companion object {
        /** Ask for more while 5 are left: 3 preloaded behind the top always stay ready. */
        const val REFILL_AT = 5

        /** The next 3 cards (and the top one) are always loaded ahead. */
        const val PRELOAD_AHEAD = 3

        /** The photo URLs of the first card and the [ahead] after it: every first photo, then the rest. */
        fun preloadUrls(cards: List<ProfileCard>, ahead: Int = PRELOAD_AHEAD): List<String> {
            val window = cards.take(ahead + 1)
            val firsts = window.mapNotNull { it.photos.firstOrNull()?.url }
            val rest = window.flatMap { it.photos.drop(1).map { photo -> photo.url } }
            return (firsts + rest).filter { it.isNotBlank() }
        }
    }
}
