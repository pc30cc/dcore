package app.core.net.origins

import app.core.common.FakeClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** API host selection: order, stickiness, the five-minute bad mark, the build's host, trust. */
class HostBookTest {

    private val clock = FakeClock()
    private val book = HostBook("https://build.test/", clock).apply { adopt(listOf(A, B, C)) }

    @Test
    fun theListsOrderComesFirstThenTheBuildsHost() {
        assertEquals(listOf(A, B, C, BUILD), book.candidates())
    }

    @Test
    fun theBuildsHostIsNotListedTwice() {
        book.adopt(listOf(A, BUILD, B))
        assertEquals(listOf(A, BUILD, B), book.candidates())
    }

    @Test
    fun theLastHostThatAnsweredStaysFirstUntilItFails() {
        book.reached(B)
        assertEquals(listOf(B, A, C, BUILD), book.candidates())
        clock.advance(HostBook.BAD_FOR_MS * 10)
        assertEquals("sticky across time", B, book.candidates().first())
        book.failed(B)
        assertEquals(listOf(A, C, BUILD), book.candidates())
    }

    @Test
    fun aNewlyAcceptedListStartsAtItsOwnFirstHost() {
        book.reached(C)
        book.adopt(listOf(B, C))
        assertEquals(listOf(B, C, BUILD), book.candidates())
    }

    @Test
    fun aFailedHostIsSkippedForFiveMinutes() {
        book.failed(A)
        assertTrue(book.isBad(A))
        assertEquals(listOf(B, C, BUILD), book.candidates())
        clock.advance(HostBook.BAD_FOR_MS - 1)
        assertEquals(listOf(B, C, BUILD), book.candidates())
        clock.advance(1)
        assertFalse(book.isBad(A))
        assertEquals(listOf(A, B, C, BUILD), book.candidates())
    }

    @Test
    fun aHostThatAnswersAgainIsNoLongerBad() {
        book.failed(A)
        book.reached(A)
        assertEquals(listOf(A, B, C, BUILD), book.candidates())
    }

    @Test
    fun whenEveryListedHostIsBadTheBuildsHostIsUsed() {
        book.failed(A)
        book.failed(B)
        book.failed(C)
        assertEquals(listOf(BUILD), book.candidates())
    }

    @Test
    fun whenEverythingIsBadTheMarkThatEndsFirstWins() {
        book.failed(B)
        clock.advance(1_000)
        book.failed(A)
        book.failed(C)
        book.failed(BUILD)
        assertEquals(listOf(B), book.candidates())
    }

    @Test
    fun withoutAListOnlyTheBuildsHostExists() {
        val bare = HostBook("https://build.test", clock)
        assertEquals(listOf(BUILD), bare.candidates())
        bare.failed(BUILD)
        assertEquals("never empty", listOf(BUILD), bare.candidates())
    }

    @Test
    fun onlyTheListAndTheBuildAreTrusted() {
        assertTrue(book.trusted(A))
        assertTrue(book.trusted(BUILD))
        assertFalse(book.trusted("https://evil.test"))
        book.adopt(listOf(B))
        assertFalse("a host the newer list dropped", book.trusted(A))
    }

    private companion object {
        const val A = "https://a.test"
        const val B = "https://b.test"
        const val C = "https://c.test"
        const val BUILD = "https://build.test"
    }
}
