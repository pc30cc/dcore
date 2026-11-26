package app.core.feature.onboarding

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowLocationManager

/**
 * The platform side of [CoarseLocation]: a fresh request is registered with
 * the location service and withdrawn once answered or cancelled, a provider
 * the device does not have answers nothing without throwing, and the app
 * asks for the coarse permission only.
 */
@RunWith(AndroidJUnit4::class)
class SystemLocationPlatformTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager = context.getSystemService(LocationManager::class.java)
    private val shadow: ShadowLocationManager = shadowOf(manager)
    private val platform = SystemLocationPlatform(manager, Runnable::run)

    @Before
    fun allow() {
        shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>()).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
        shadow.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    }

    private fun gpsFix() = Location(LocationManager.GPS_PROVIDER).apply {
        latitude = 35.712
        longitude = 51.398
        accuracy = 2000f
        time = System.currentTimeMillis()
        elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
    }

    @Test
    fun aProviderIsOnOnlyWhenTheDeviceHasItAndItIsOn() {
        assertFalse(platform.enabled("no-such-provider"))
        assertTrue(platform.enabled(LocationManager.GPS_PROVIDER))
        shadow.setProviderEnabled(LocationManager.GPS_PROVIDER, false)
        assertFalse(platform.enabled(LocationManager.GPS_PROVIDER))
    }

    @Test
    fun aFreshRequestIsRegisteredAndWithdrawnOnceAnswered() = runBlocking(Dispatchers.Unconfined) {
        val answer = async(start = CoroutineStart.UNDISPATCHED) { platform.fresh(LocationManager.GPS_PROVIDER) }
        assertEquals(1, shadow.getLocationRequests(LocationManager.GPS_PROVIDER).size)
        shadow.simulateLocation(LocationManager.GPS_PROVIDER, gpsFix())
        val reading = answer.await()
        assertNotNull(reading)
        assertEquals(LocationManager.GPS_PROVIDER, reading!!.provider)
        assertEquals(35.712, reading.lat, 1e-9)
        assertTrue(shadow.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
    }

    @Test
    fun cancellingWithdrawsTheRequest() = runBlocking(Dispatchers.Unconfined) {
        val answer = async(start = CoroutineStart.UNDISPATCHED) { platform.fresh(LocationManager.GPS_PROVIDER) }
        assertEquals(1, shadow.getLocationRequests(LocationManager.GPS_PROVIDER).size)
        answer.cancel()
        yield()
        assertTrue(shadow.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
    }

    @Test
    fun aProviderTheDeviceDoesNotHaveAnswersNothing() = runBlocking {
        assertNull(platform.fresh("no-such-provider"))
    }

    @Test
    fun aLastKnownFixWithOnlyAWallClockTimeIsYoung() {
        shadow.setLastKnownLocation(LocationManager.NETWORK_PROVIDER, Location(LocationManager.NETWORK_PROVIDER).apply {
            latitude = 35.70
            longitude = 51.40
            time = System.currentTimeMillis()
        })
        val reading = platform.lastKnown(LocationManager.NETWORK_PROVIDER)
        assertNotNull(reading)
        assertTrue("age ${reading!!.ageMs}", reading.ageMs in 0..60_000)
    }

    @Test
    fun theAppAsksForTheCoarsePermissionOnly() {
        val requested = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty().toList()
        assertTrue(Manifest.permission.ACCESS_COARSE_LOCATION in requested)
        assertFalse(Manifest.permission.ACCESS_FINE_LOCATION in requested)
        assertFalse(Manifest.permission.ACCESS_BACKGROUND_LOCATION in requested)
    }
}
