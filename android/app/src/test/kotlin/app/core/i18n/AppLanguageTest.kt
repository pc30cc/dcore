package app.core.i18n

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppLanguageTest {

    @Test
    fun `tags are matched on the language alone`() {
        assertEquals(AppLanguage.FA, AppLanguage.fromTag("fa-IR"))
        assertEquals(AppLanguage.TR, AppLanguage.fromTag("tr_TR"))
        assertEquals(AppLanguage.EN, AppLanguage.fromTag("EN-gb"))
        assertNull(AppLanguage.fromTag("de-DE"))
        assertNull(AppLanguage.fromTag(""))
        assertNull(AppLanguage.fromTag(null))
    }

    @Test
    fun `a choice the person made wins over everything`() {
        val language = AppLanguage.resolve(chosenTag = "tr", deviceTags = listOf("fa-IR"), defaultTag = "fa", followsDevice = true)
        assertEquals(AppLanguage.TR, language)
    }

    @Test
    fun `the bazaar build opens in Persian whatever the phone speaks`() {
        val language = AppLanguage.resolve(chosenTag = null, deviceTags = listOf("en-US", "tr-TR"), defaultTag = "fa", followsDevice = false)
        assertEquals(AppLanguage.FA, language)
    }

    @Test
    fun `the play build follows the first device language it has`() {
        val language = AppLanguage.resolve(chosenTag = null, deviceTags = listOf("de-DE", "tr-TR", "en-US"), defaultTag = "en", followsDevice = true)
        assertEquals(AppLanguage.TR, language)
    }

    @Test
    fun `the play build falls back to English for a device language it does not ship`() {
        val language = AppLanguage.resolve(chosenTag = null, deviceTags = listOf("de-DE", "ja-JP"), defaultTag = "en", followsDevice = true)
        assertEquals(AppLanguage.EN, language)
    }

    @Test
    fun `an unshipped choice or default never yields a missing language`() {
        val language = AppLanguage.resolve(chosenTag = "de", deviceTags = emptyList(), defaultTag = "xx", followsDevice = false)
        assertEquals(AppLanguage.EN, language)
    }

    @Test
    fun `only Persian is right to left`() {
        assertEquals(listOf(AppLanguage.FA), AppLanguage.entries.filter { it.rightToLeft })
    }

    @Test
    fun `the app name placeholder is filled in`() {
        assertEquals("Welcome to Example", brandText("Welcome to {appName}", "Example"))
        assertEquals("به Example خوش آمدید", brandText("به {appName} خوش آمدید", "Example"))
        assertEquals("No placeholder", brandText("No placeholder", "Example"))
    }
}
