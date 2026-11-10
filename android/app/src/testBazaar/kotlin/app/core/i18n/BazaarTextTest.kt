package app.core.i18n

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/**
 * The Cafe Bazaar build signs in by phone only: no text it can show names
 * Google, in any of its languages. The only strings that still do are the
 * Play build's sign-in texts, which this build never reaches (the Google
 * button needs [BuildConfig.SUPPORTS_GOOGLE_SIGN_IN]). The store's name and
 * terms are each build's own (`strings_store.xml`).
 */
@RunWith(AndroidJUnit4::class)
class BazaarTextTest {

    private val base = ApplicationProvider.getApplicationContext<Context>()

    private fun resources(tag: String) =
        base.createConfigurationContext(Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) }).resources

    /** Reached only through Google sign-in, which this build does not have. */
    private val playOnly = setOf(
        "auth_continue_google",
        "auth_google_no_account",
        "auth_google_unavailable",
        "auth_google_failed",
    )

    private val google = Regex("google|گوگل", RegexOption.IGNORE_CASE)

    @Test
    fun noStringThisBuildCanShowNamesGoogle() {
        assertFalse("the reasoning above holds only without Google sign-in", BuildConfig.SUPPORTS_GOOGLE_SIGN_IN)
        val strings = R.string::class.java.fields.map { it.name to it.getInt(null) }
        assertTrue("found the app's strings", strings.size > 300)
        for (tag in listOf("en", "fa", "tr")) {
            val res = resources(tag)
            val hits = strings.filter { (name, id) -> name !in playOnly && google.containsMatchIn(res.getString(id)) }.map { it.first }
            assertEquals("strings naming Google in $tag", emptyList<String>(), hits)
        }
    }

    @Test
    fun thePrivacySummaryNamesThePhoneNumberOnly() {
        assertEquals("Phone number", resources("en").getString(R.string.privacy_only_us_1))
        assertEquals("شماره موبایل", resources("fa").getString(R.string.privacy_only_us_1))
        assertEquals("Telefon numarası", resources("tr").getString(R.string.privacy_only_us_1))
    }
}
