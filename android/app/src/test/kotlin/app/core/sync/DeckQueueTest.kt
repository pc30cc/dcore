package app.core.sync

import app.core.model.Photo
import app.core.model.ProfileCard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeckQueueTest {

    private fun card(id: String, v: Long = 1, photos: Int = 2) = ProfileCard(
        id = id,
        v = v,
        name = id,
        photos = (1..photos).map { Photo(id = "$id$it", url = "https://cdn.test/p/$id$it/1/640.webp?sig=$it") },
    )

    @Test
    fun pagesAppendInServerOrderAndRepeatsAreDropped() {
        val queue = DeckQueue()
        assertEquals(3, queue.add(listOf(card("a"), card("b"), card("c"))))
        // The server's queue still starts with the cards the phone holds.
        assertEquals(2, queue.add(listOf(card("b"), card("c"), card("d"), card("e"))))
        assertEquals(listOf("a", "b", "c", "d", "e"), queue.snapshot().map { it.id })
        assertEquals("a", queue.top?.id)
    }

    @Test
    fun aSwipedPersonNeverComesBackInTheSameSession() {
        val queue = DeckQueue()
        queue.add(listOf(card("a"), card("b")))
        queue.remove("a")
        assertEquals(0, queue.add(listOf(card("a"))))
        assertFalse(queue.contains("a"))
        assertTrue(queue.wasHandled("a"))
    }

    @Test
    fun removingSomeoneNotQueuedStillKeepsThemOut() {
        // A like back from the likes list: that person must not show up in the deck later.
        val queue = DeckQueue()
        assertNull(queue.remove("z"))
        assertEquals(0, queue.add(listOf(card("z"))))
    }

    @Test
    fun aNewerVersionReplacesTheQueuedCardInPlace() {
        val queue = DeckQueue()
        queue.add(listOf(card("a", v = 1), card("b", v = 1)))
        queue.add(listOf(card("a", v = 3).copy(name = "edited")))
        assertEquals("edited", queue.top?.name)
        queue.add(listOf(card("a", v = 2).copy(name = "older")))
        assertEquals("edited", queue.top?.name)
        assertEquals(2, queue.size)
    }

    @Test
    fun restorePutsTheCardBackOnTopAndForgetsTheSwipe() {
        val queue = DeckQueue()
        queue.add(listOf(card("a"), card("b")))
        val a = queue.remove("a")!!
        queue.restore(a)
        assertEquals(listOf("a", "b"), queue.snapshot().map { it.id })
        assertFalse(queue.wasHandled("a"))
    }

    @Test
    fun wantsMoreAtFiveOrFewer() {
        val queue = DeckQueue()
        queue.add((1..7).map { card("c$it") })
        assertFalse(queue.wantsMore)
        queue.remove("c1")
        queue.remove("c2")
        assertTrue(queue.wantsMore)
    }

    @Test
    fun preloadCoversTheTopCardAndTheNextThreeFirstPhotosFirst() {
        val queue = DeckQueue()
        queue.add((1..6).map { card("c$it", photos = 2) })
        val urls = queue.photosToPreload()
        assertEquals(8, urls.size)
        assertEquals(listOf("c11", "c21", "c31", "c41"), urls.take(4).map { it.substringAfter("/p/").substringBefore('/') })
        assertTrue(urls.none { it.contains("/c5") || it.contains("/c6") })
    }

    @Test
    fun clearForgetsCardsAndSwipes() {
        val queue = DeckQueue()
        queue.add(listOf(card("a")))
        queue.remove("a")
        queue.clear()
        assertEquals(1, queue.add(listOf(card("a"))))
    }

    @Test
    fun markHandledDropsQueuedCardsAndKeepsThemOut() {
        val queue = DeckQueue()
        queue.add(listOf(card("a"), card("b")))
        queue.markHandled(listOf("a"))
        assertEquals(listOf("b"), queue.snapshot().map { it.id })
        assertEquals(0, queue.add(listOf(card("a"))))
    }
}
