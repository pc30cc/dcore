package app.core.ui.components

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/** What TalkBack reads for the deck's buttons: each its own word, and rewind never the back button's, in every language. */
@RunWith(AndroidJUnit4::class)
class DeckActionLabelsTest {

    private val base = ApplicationProvider.getApplicationContext<Context>()

    private fun resources(tag: String): Resources = base.createConfigurationContext(
        Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) },
    ).resources

    @Test
    fun theDeckActionLabelsAreDistinctFromEachOtherAndFromBack() {
        for (tag in listOf("en", "fa", "tr")) {
            val r = resources(tag)
            val actions = listOf(R.string.ui_rewind, R.string.ui_pass, R.string.ui_super_like, R.string.ui_like, R.string.ui_boost).map(r::getString)
            assertEquals("$tag: $actions", actions.size, actions.toSet().size)
            val rewind = r.getString(R.string.ui_rewind)
            assertNotEquals("$tag: rewind reads as back", r.getString(R.string.ui_back), rewind)
            assertNotEquals("$tag: rewind reads as back", r.getString(R.string.action_back), rewind)
        }
    }
}
