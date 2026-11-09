package app.core.feature.call

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/**
 * A call's length reads as a length in every language: units, the
 * language's own words and joiners, the reader's digits, never `m:ss`. The
 * platform's unit formats on the line and for TalkBack, and the plural
 * strings they fall back to.
 */
@RunWith(AndroidJUnit4::class)
class CallLengthTest {

    private fun lengths(tag: String): CallLengthText {
        val locale = Locale.forLanguageTag(tag)
        val base = ApplicationProvider.getApplicationContext<Context>()
        val configuration = Configuration(base.resources.configuration).apply { setLocale(locale) }
        return CallLengthText(locale, base.createConfigurationContext(configuration).resources)
    }

    @Test
    fun englishIsShortOnTheLineAndSpeltOutForTalkBack() {
        val en = lengths("en-US")
        assertEquals("2 min, 5 sec", en.line(125))
        assertEquals("2 minutes, 5 seconds", en.spoken(125))
        assertEquals("45 sec", en.line(45))
        assertEquals("1 second", en.spoken(1))
        assertEquals("2 min", en.line(120))
        assertEquals("1 hour, 2 minutes", en.spoken(3723))
        assertEquals("", en.line(0))
    }

    @Test
    fun persianSaysItWithPersianWordsAndDigits() {
        val fa = lengths("fa")
        assertEquals("۲ دقیقه و ۵ ثانیه", fa.line(125))
        assertEquals("۲ دقیقه و ۵ ثانیه", fa.spoken(125))
        assertEquals("۴۵ ثانیه", fa.line(45))
        assertEquals("۱ ساعت و ۲ دقیقه", fa.line(3723))
        listOf(5L, 59L, 125L, 754L, 3600L, 3723L, 36_000L).forEach { s ->
            val text = fa.line(s)
            assertTrue("$s: $text", text.none { it in '0'..'9' } && text.any { it in '۰'..'۹' })
            assertTrue("$s: no clock time in $text", ':' !in text)
        }
    }

    @Test
    fun turkishUsesItsOwnUnits() {
        val tr = lengths("tr")
        assertEquals("2 dk. 5 sn.", tr.line(125))
        assertEquals("2 dakika 5 saniye", tr.spoken(125))
        assertEquals("1 saat 2 dakika", tr.spoken(3723))
    }

    @Test
    fun thePluralStringsSayTheSameWhenThePlatformCannot() {
        assertEquals("2 minutes, 5 seconds", lengths("en-US").fromStrings(125))
        assertEquals("1 minute, 1 second", lengths("en-US").fromStrings(61))
        assertEquals("۲ دقیقه و ۵ ثانیه", lengths("fa").fromStrings(125))
        assertEquals("۱ ساعت و ۲ دقیقه", lengths("fa").fromStrings(3723))
        assertEquals("2 dakika 5 saniye", lengths("tr").fromStrings(125))
    }
}
