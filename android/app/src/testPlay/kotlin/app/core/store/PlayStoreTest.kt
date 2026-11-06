package app.core.store

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.diag.Diag
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The Google Play build is configured as a Play build, end to end. */
@RunWith(AndroidJUnit4::class)
class PlayStoreTest {

    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val services = StoreModule.create(context, Diag.Silent)

    @Test
    fun `the build's settings are Google Play's`() {
        assertEquals("play", BuildConfig.STORE)
        assertEquals("en", BuildConfig.DEFAULT_LOCALE)
        assertTrue(BuildConfig.LOCALE_FOLLOWS_DEVICE)
        assertTrue(BuildConfig.SUPPORTS_GOOGLE_SIGN_IN)
    }

    @Test
    fun `every service is the Play one`() {
        assertEquals(Store.PLAY, services.info.store)
        assertEquals(Store.PLAY, services.billing.store)
        assertEquals("com.android.vending", services.info.storePackage)
        assertTrue(services.billing is PlayBilling)
    }

    @Test
    fun `the app page opens in the Play Store`() {
        val info = services.info as PlayStoreInfo
        val page = info.appPageIntent("com.example.app")
        assertEquals(Intent.ACTION_VIEW, page.action)
        assertEquals("market://details?id=com.example.app", page.dataString)
        assertEquals("com.android.vending", page.`package`)
        assertEquals("https://play.google.com/store/apps/details?id=com.example.app", info.appPageWebUrl("com.example.app"))
    }

    @Test
    fun `billing says the Play Store is missing on a bare device instead of failing obscurely`() = runTest {
        assertFalse(services.info.isStoreInstalled(context))
        val availability = services.billing.connect()
        assertEquals(BillingAvailability.Unavailable(BillingUnavailableReason.STORE_NOT_INSTALLED), availability)
    }

    @Test
    fun `integrity without a cloud project number says it is not configured`() = runTest {
        if (BuildConfig.PLAY_CLOUD_PROJECT_NUMBER == 0L) {
            assertTrue(services.integrity.token("hash") is IntegrityResult.Unsupported)
        }
    }
}
