package app.core.push

import android.app.Application
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * The Cafe Bazaar build declares no Play services resolution screen, and push
 * on a phone without Play services stays quiet: no dialog, no screen, no
 * token, just "no Play services" for the in-app notice.
 */
@RunWith(AndroidJUnit4::class)
class BazaarPushManifestTest {

    private val app = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun theResolutionScreenIsNotInTheManifest() {
        @Suppress("DEPRECATION")
        val activities = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_ACTIVITIES).activities.orEmpty().map { it.name }
        assertFalse(activities.toString(), activities.any { it.endsWith("GoogleApiActivity") })
    }

    @Test
    fun withoutPlayServicesPushStepsAsideQuietly() = runTest {
        val push = FirebasePush(app)
        assertEquals(PushAvailability.NO_PLAY_SERVICES, push.availability())
        assertNull(push.token())
        push.deleteToken()
        assertNull("nothing was opened", shadowOf(app).nextStartedActivity)
    }
}
