package app.core.i18n

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/** The Play build offers Google sign-in, so its privacy summary names the Google account too. */
@RunWith(AndroidJUnit4::class)
class PlayTextTest {

    private val base = ApplicationProvider.getApplicationContext<Context>()

    private fun text(tag: String, id: Int): String =
        base.createConfigurationContext(Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) }).resources.getString(id)

    @Test
    fun thePrivacySummaryNamesThePhoneNumberAndTheGoogleAccount() {
        // What only the service keeps: the number or the Google account this build signs in with.
        org.junit.Assert.assertEquals("Phone number or Google account", text("en", R.string.privacy_only_us_1))
        org.junit.Assert.assertEquals("شماره موبایل یا حساب گوگل", text("fa", R.string.privacy_only_us_1))
        org.junit.Assert.assertEquals("Telefon numarası veya Google hesabı", text("tr", R.string.privacy_only_us_1))
    }

    /** The Play build names no other store, in any of its languages ("nothing that names Bazaar"). */
    @Test
    fun noStringThisBuildCanShowNamesTheOtherStore() {
        val strings = R.string::class.java.fields.map { it.name to it.getInt(null) }
        val other = Regex("bazaar|بازار|cafebazaar", RegexOption.IGNORE_CASE)
        for (tag in listOf("en", "fa", "tr")) {
            val res = base.createConfigurationContext(Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) }).resources
            val hits = strings.filter { (_, id) -> other.containsMatchIn(res.getString(id)) }.map { it.first }
            org.junit.Assert.assertEquals("strings naming the other store in $tag", emptyList<String>(), hits)
        }
        assertTrue(text("en", R.string.store_name) == "Google Play")
    }
}
