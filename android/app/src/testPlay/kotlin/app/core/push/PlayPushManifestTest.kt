package app.core.push

import android.app.Application
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The Play build keeps Play services' resolution screen, which its own FCM errors may open. */
@RunWith(AndroidJUnit4::class)
class PlayPushManifestTest {

    @Test
    fun theResolutionScreenIsKept() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        @Suppress("DEPRECATION")
        val activities = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_ACTIVITIES).activities.orEmpty().map { it.name }
        assertTrue(activities.toString(), activities.any { it == "com.google.android.gms.common.api.GoogleApiActivity" })
    }
}
