package app.core.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/**
 * `GET /v1/me/export` (`{status, url?, expiresAt?}`) and the `account`
 * realtime event's `export`: one shape the app reads either way, and a link
 * only while it is valid.
 */
class ExportStatusTest {

    private val expires = Instant.parse("2026-11-07T09:14:03.120Z")
    private val link = "https://cdn.example.com/exports/1287390234923499901.zip?exp=1794096000&sig=c2lnbmF0dXJl"

    @Test
    fun everyStateOfTheServerDecodes() {
        assertEquals(ExportStatus(ExportState.None), Wire.json.decodeFromString(ExportStatus.serializer(), """{"status":"none"}"""))
        assertEquals(ExportStatus(ExportState.Pending), Wire.json.decodeFromString(ExportStatus.serializer(), """{"status":"pending"}"""))
        val ready = Wire.json.decodeFromString(ExportStatus.serializer(), """{"status":"ready","url":"$link","expiresAt":"2026-11-07T09:14:03.120Z"}""")
        assertEquals(ExportStatus(ExportState.Ready, link, expires), ready)
        assertEquals(ExportState.Unknown, Wire.json.decodeFromString(ExportStatus.serializer(), """{"status":"archived"}""").status)
    }

    @Test
    fun theLinkOpensOnlyWhileItIsValid() {
        val ready = ExportStatus(ExportState.Ready, link, expires)
        assertEquals(link, ready.link(expires.minusSeconds(1)))
        assertNull("expired", ready.link(expires))
        assertNull("not ready", ExportStatus(ExportState.Pending, link, expires).link(expires.minusSeconds(60)))
        assertNull("no address", ExportStatus(ExportState.Ready, null, expires).link(expires.minusSeconds(60)))
        assertNull("not a web address", ExportStatus(ExportState.Ready, "file:///sdcard/x.zip", expires).link(expires.minusSeconds(60)))
        assertEquals("the server sends the link only while valid", link, ExportStatus(ExportState.Ready, link, null).link(expires))
    }

    @Test
    fun theRealtimeAnnouncementReadsLikeAReadyStatus() {
        val event = RealtimeEvents.decode(
            Wire.json.parseToJsonElement(
                """{"t":"account","v":1,"id":"1287390234923417622","at":"2026-11-06T09:14:03.120Z",
                   "d":{"status":"active","export":{"url":"$link","expiresAt":"2026-11-07T09:14:03.120Z"}}}""",
            ),
        ) as RealtimeEvent.AccountChanged
        val export = event.account.export!!
        assertEquals(ExportStatus(ExportState.Ready, link, expires), ExportStatus.of(export))
        assertEquals(AccountStatus.Active, event.account.status)
    }
}
