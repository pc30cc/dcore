package app.core.i18n

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/**
 * One Persian word for each of the app's own ideas, on every screen, in
 * notifications and in what TalkBack reads: a match is «مچ» (never «هم‌پسندی»
 * or «همدیگر را پسندیدید» on one screen and «مچ» on the next), a like is
 * «لایک» (never «پسند»). Every string and plural this build can show, store
 * overrides included.
 */
@RunWith(AndroidJUnit4::class)
class PersianVocabularyTest {

    private val base = ApplicationProvider.getApplicationContext<Context>()
    private val persian = base.createConfigurationContext(
        Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag("fa")) },
    ).resources

    /** Every Persian text by its resource name (each plural in its forms). */
    private val texts: Map<String, String> by lazy {
        val strings = R.string::class.java.fields.associate { it.name to persian.getString(it.getInt(null)) }
        val plurals = R.plurals::class.java.fields.associate { field ->
            val id = field.getInt(null)
            field.name to listOf(1, 2, 5).joinToString(" | ") { persian.getQuantityString(id, it, it) }
        }
        strings + plurals
    }

    private class Idea(val name: String, val word: Regex, val others: Regex)

    private val ideas = listOf(
        Idea("match", word = Regex("(?<!\\p{L})مچ"), others = Regex("هم‌پسند|همپسند|هم پسند|همدیگر را پسند")),
        Idea("like", word = Regex("لایک"), others = Regex("پسند")),
    )

    @Test
    fun eachIdeaHasOneWord() {
        assertTrue("read the app's strings", texts.size > 300)
        for (idea in ideas) {
            val using = texts.filterValues { idea.word.containsMatchIn(it) }.keys
            val other = texts.filterValues { idea.others.containsMatchIn(it) }.keys
            assertTrue("the ${idea.name} word is in use", using.isNotEmpty())
            assertEquals("strings saying ${idea.name} in another word than ${idea.word.pattern}", emptySet<String>(), other)
        }
    }
}
