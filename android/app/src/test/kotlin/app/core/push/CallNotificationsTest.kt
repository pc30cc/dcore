package app.core.push

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.feature.call.at
import app.core.i18n.AppLocales
import app.core.i18n.brandString
import app.core.model.CallKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * The ring as the shade shows it: the platform's incoming-call style with a
 * full-screen intent where allowed, a heads-up with the same two buttons where
 * not, nobody's name or face on a locked screen, and a missed call left under
 * the server's own key only when the ring was missed here.
 */
@RunWith(AndroidJUnit4::class)
class CallNotificationsTest {

    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val manager get() = context.getSystemService(NotificationManager::class.java)

    private val ring = CallRing(
        callId = "9001",
        conversationId = "500",
        kind = CallKind.Video,
        peerName = "Negar",
        peerPhotoUrl = null,
        expiresAt = at(45_000),
    )

    @Before
    fun channels() {
        PushChannels.ensure(context)
    }

    /** The app's language (Persian in the Bazaar build, whatever the phone's), as the notifications use it. */
    private fun text(id: Int) = AppLocales.wrap(context).brandString(id)

    private fun posted(): List<Pair<String?, Notification>> = shadowOf(manager).activeNotifications.map { it.tag to it.notification }

    @Test
    fun aRingIsTheIncomingCallStyleFullScreenAndInsistent() {
        assertTrue(CallNotifications.showRing(context, ring, photo = null, now = at(0), fullScreen = true))
        val (_, ringing) = posted().single()
        assertEquals(PushChannels.CALLS, ringing.channelId)
        assertEquals(Notification.CATEGORY_CALL, ringing.category)
        assertNotNull("rings over the lock screen where allowed", ringing.fullScreenIntent)
        assertEquals("android.app.Notification\$CallStyle", ringing.extras.getString(Notification.EXTRA_TEMPLATE))
        assertTrue(ringing.flags and Notification.FLAG_INSISTENT != 0)
        assertEquals("Negar", ringing.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertTrue(CallNotifications.isRinging(context, "9001"))
        assertFalse(CallNotifications.isRinging(context, "9002"))
    }

    @Test
    fun theLockScreenShowsNeitherNameNorPhoto() {
        CallNotifications.showRing(context, ring, photo = null, now = at(0), fullScreen = true)
        val (_, ringing) = posted().single()
        assertEquals(NotificationCompat.VISIBILITY_PRIVATE, ringing.visibility)
        val public = ringing.publicVersion!!
        val title = public.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        assertFalse(title.contains("Negar"))
        assertEquals(text(R.string.call_notify_incoming_public), title)
        assertNull(public.extras.getParcelable<android.os.Parcelable>(Notification.EXTRA_LARGE_ICON))
    }

    @Test
    fun withoutFullScreenTheRingIsAHeadsUpWithTheSameTwoButtons() {
        CallNotifications.showRing(context, ring, photo = null, now = at(0), fullScreen = false)
        val (_, ringing) = posted().single()
        assertNull(ringing.fullScreenIntent)
        assertEquals(listOf(text(R.string.call_action_decline), text(R.string.call_action_answer)), ringing.actions.map { it.title.toString() })
    }

    @Test
    fun aRingPastItsExpiryOrWithoutPermissionIsNotPosted() {
        assertFalse(CallNotifications.showRing(context, ring, photo = null, now = at(46_000), fullScreen = true))
        shadowOf(manager).setNotificationsEnabled(false)
        assertFalse(CallNotifications.showRing(context, ring, photo = null, now = at(0), fullScreen = true))
        assertTrue(posted().isEmpty())
    }

    @Test
    fun aMissedRingLeavesAMissedCallUnderTheServersKey() {
        CallNotifications.showRing(context, ring, photo = null, now = at(0), fullScreen = true)
        CallNotifications.stopRing(context, "9001", missed = true)
        val (tag, missed) = posted().single()
        assertEquals("call:9001", tag)
        assertEquals(PushChannels.MESSAGES, missed.channelId)
        assertEquals(text(R.string.call_notify_missed_video), missed.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertFalse(missed.publicVersion!!.extras.getCharSequence(Notification.EXTRA_TITLE).toString().contains("Negar"))
        // The tap carries the push's own keys, so it opens the conversation like the server's.
        val tap = shadowOf(missed.contentIntent).savedIntent
        assertEquals("call_missed", tap.getStringExtra("type"))
        assertEquals("500", tap.getStringExtra("conversationId"))
    }

    @Test
    fun aRingDealtWithHereLeavesNothing() {
        CallNotifications.showRing(context, ring, photo = null, now = at(0), fullScreen = true)
        CallNotifications.forget("9001")
        CallNotifications.stopRing(context, "9001", missed = false)
        assertTrue(posted().isEmpty())
    }

    @Test
    fun aRingsOwnIntentsReadBackIntoALink() {
        CallNotifications.showRing(context, ring, photo = null, now = at(0), fullScreen = true)
        val (_, ringing) = posted().single()
        val show = shadowOf(ringing.contentIntent).savedIntent
        val link = IncomingCallLink.from(show)!!
        assertEquals("9001", link.callId)
        assertEquals("500", link.conversationId)
        assertEquals(CallKind.Video, link.kind)
        assertFalse(link.answer)
        assertNull("another intent is not a ring", IncomingCallLink.from(android.content.Intent(android.content.Intent.ACTION_MAIN)))
    }
}
