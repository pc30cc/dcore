package app.core.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.cache.CacheDatabaseHolder
import app.core.cache.ChatStore
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.MessageKind
import app.core.model.ReceiptEvent
import app.core.testing.ChatApi
import app.core.testing.ChatApi.Companion.ME
import app.core.testing.ChatApi.Companion.PEER
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The unread count as the server keeps it: 0 once the reader's pointer
 * reaches the newest message counted for them (the peer's, not a reaction
 * or an unsend), whatever came after it; the server's count when the phone
 * cannot tell.
 */
@RunWith(AndroidJUnit4::class)
class ConversationRepositoryTest {

    private val api = ChatApi()
    private val clock = FakeClock()
    private val store = ChatStore(CacheDatabaseHolder(ApplicationProvider.getApplicationContext(), name = null, diag = Diag.Silent), Diag.Silent)
    private val conversations = ConversationRepository(api, store, clock, Diag.Silent)
    private val messages = MessageRepository(api, store, clock, diag = Diag.Silent)
    private val c = "1287390234923400001"

    private suspend fun row() = conversations.get(ME, c)!!

    /** The list as the server has it, then (when [read]) the thread read on this phone. */
    private suspend fun listed(unread: Int, read: Boolean, myReadId: String? = null) {
        api.fill(c, 1_000, 2)
        api.conversations[c] = api.conversation(c, last = api.threads.getValue(c).last(), unread = unread).copy(myReadId = myReadId)
        api.listChanged = true
        conversations.refresh(ME)
        if (read) messages.open(ME, c, 1_001)
    }

    /** A message heard over realtime, as the sync applies it. */
    private suspend fun arrives(id: Long, from: String, kind: MessageKind = MessageKind.Text, refId: String? = null) {
        val m = api.message(c, id, from = from, kind = kind, refId = refId)
        messages.applyRealtime(ME, m)
        conversations.onMessage(ME, m, viewing = false)
    }

    private fun readOnMyOtherPhone(upTo: Long) = ReceiptEvent(c, ME, readUpTo = upTo.toString())

    @Test
    fun aReadOnAnotherPhoneClearsTheCountThoughAReplyOfTheirsCameAfterIt() = runTest {
        listed(unread = 1, read = true)
        arrives(1_002, from = ME)
        assertEquals(1_002L, row().lastMessageId)
        assertEquals(1, row().unread)

        assertFalse("the phone holds the thread: nothing to ask", conversations.applyReceipt(ME, readOnMyOtherPhone(1_001)))
        assertEquals("read up to their newest message: nothing left, as the server says", 0, row().unread)
        assertEquals(1_001L, row().myReadId)
    }

    @Test
    fun theirUnsendAfterTheMessageReadLeavesNoCount() = runTest {
        listed(unread = 1, read = true)
        arrives(1_002, from = PEER, kind = MessageKind.Unsend, refId = "1001")
        assertEquals("the unsend of the preview is the preview", 1_002L, row().lastMessageId)

        conversations.applyReceipt(ME, readOnMyOtherPhone(1_001))
        assertEquals(0, row().unread)
    }

    @Test
    fun aReadShortOfTheirNewestMessageKeepsTheCount() = runTest {
        listed(unread = 1, read = true)
        arrives(1_002, from = PEER)
        assertEquals(2, row().unread)

        assertFalse(conversations.applyReceipt(ME, readOnMyOtherPhone(1_001)))
        assertEquals("1002 is still unread (the server keeps its count too)", 2, row().unread)
    }

    @Test
    fun aNewerMessageOfTheirsAReadBroughtIsNotClearedByAPointerAtThePreview() = runTest {
        listed(unread = 1, read = true)
        // A catch-up brought 1002 from them; the list row still shows 1001 until the next list read.
        api.fill(c, 1_002, 1)
        messages.markStale(ME, c)
        messages.open(ME, c, 1_001)
        assertEquals(1_001L, row().lastMessageId)

        assertFalse(conversations.applyReceipt(ME, readOnMyOtherPhone(1_001)))
        assertEquals("1002 is unread, as the server counts it", 1, row().unread)
    }

    @Test
    fun withoutTheThreadThePhoneCannotTellAndTakesTheServersCount() = runTest {
        listed(unread = 1, read = false)
        arrives(1_002, from = ME)

        assertTrue("not known here: the list must say", conversations.applyReceipt(ME, readOnMyOtherPhone(1_001)))
        assertEquals("kept until the server says", 1, row().unread)

        // The server's list after the receipt (its version moved with it): the count is 0.
        api.conversations[c] = api.conversations.getValue(c).copy(lastMessage = api.message(c, 1_002, from = ME), unread = 0, myReadId = "1001")
        api.listChanged = true
        conversations.refresh(ME)
        assertEquals(0, row().unread)
    }

    @Test
    fun aStaleThreadIsNotTrustedToHoldTheNewestOfTheirs() = runTest {
        listed(unread = 1, read = true)
        arrives(1_002, from = ME)
        messages.markAllStale(ME)

        assertTrue(conversations.applyReceipt(ME, readOnMyOtherPhone(1_001)))
        assertEquals(1, row().unread)
    }

    @Test
    fun thisPhonesOwnReceiptAndAThreadReadCompareWithTheirNewestMessageToo() = runTest {
        // A count a list gave while the last message is this account's own reply.
        listed(unread = 1, read = true)
        arrives(1_002, from = ME)
        conversations.markRead(ME, c, 1_001)
        assertEquals(0, row().unread)

        arrives(1_003, from = PEER)
        arrives(1_004, from = ME)
        assertEquals(1, row().unread)
        conversations.applyPointers(ME, c, ReadPointers(mine = 1_003, peerRead = null, peerDelivered = null))
        assertEquals(0, row().unread)
    }

    @Test
    fun aListReadTakesTheServersCountUnlessThePhoneHasReadFurther() = runTest {
        listed(unread = 1, read = true)
        arrives(1_002, from = ME)
        conversations.applyReceipt(ME, readOnMyOtherPhone(1_001))
        assertEquals(0, row().unread)

        // An answer made before that receipt reached the server: its pointer is behind this phone's.
        api.conversations[c] = api.conversations.getValue(c).copy(lastMessage = api.message(c, 1_002, from = ME), unread = 1, myReadId = "1000")
        api.listChanged = true
        conversations.refresh(ME)
        assertEquals("this phone read their newest message: the count stays 0", 0, row().unread)
        assertEquals(1_001L, row().myReadId)

        // A newer message of theirs: the server's count stands.
        arrives(1_003, from = PEER)
        api.conversations[c] = api.conversations.getValue(c).copy(lastMessage = api.message(c, 1_003, from = PEER), unread = 1, myReadId = "1001")
        api.listChanged = true
        conversations.refresh(ME)
        assertEquals(1, row().unread)
    }

    @Test
    fun anAnswerWithoutALastMessageNeverErasesTheOneShown() = runTest {
        listed(unread = 0, read = true)
        val shown = row()
        conversations.upsert(ME, api.conversations.getValue(c).copy(lastMessage = null))
        assertEquals(shown.lastMessageId, row().lastMessageId)
        assertEquals(shown.lastActivityAt, row().lastActivityAt)
    }
}
