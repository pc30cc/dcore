package app.core.store

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.common.Diag
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The Cafe Bazaar build is configured as a Bazaar build, end to end. */
@RunWith(AndroidJUnit4::class)
class BazaarStoreTest {

    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val services = StoreModule.create(context, Diag.Silent)

    @Test
    fun `the build's settings are Cafe Bazaar's`() {
        assertEquals("bazaar", BuildConfig.STORE)
        assertEquals("fa", BuildConfig.DEFAULT_LOCALE)
        assertFalse(BuildConfig.LOCALE_FOLLOWS_DEVICE)
        assertFalse(BuildConfig.SUPPORTS_GOOGLE_SIGN_IN)
    }

    @Test
    fun `every service is the Bazaar one`() {
        assertEquals(Store.BAZAAR, services.info.store)
        assertEquals(Store.BAZAAR, services.billing.store)
        assertEquals("com.farsitel.bazaar", services.info.storePackage)
        assertTrue(services.billing is BazaarBilling)
    }

    @Test
    fun `the app page and the rating screen open in the Bazaar app`() {
        val info = services.info as BazaarStoreInfo
        val page = info.appPageIntent("com.example.app")
        assertEquals(Intent.ACTION_VIEW, page.action)
        assertEquals("bazaar://details?id=com.example.app", page.dataString)
        assertEquals("com.farsitel.bazaar", page.`package`)
        val rating = info.ratingIntent("com.example.app")
        assertEquals(Intent.ACTION_EDIT, rating.action)
        assertEquals("com.farsitel.bazaar", rating.`package`)
        assertEquals("https://cafebazaar.ir/app/com.example.app", info.appPageWebUrl("com.example.app"))
    }

    @Test
    fun `Bazaar is not on a bare device`() {
        assertFalse(services.info.isStoreInstalled(context))
    }

    @Test
    fun `there is no in-app update check or attestation, and they say so`() = runTest {
        assertTrue(services.updates.check() is UpdateCheck.Unsupported)
        assertTrue(services.integrity.token("hash") is IntegrityResult.Unsupported)
    }
}
