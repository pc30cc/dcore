package app.core.feature.auth

import app.core.i18n.AppLanguage
import androidx.compose.ui.text.AnnotatedString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneNumbersTest {

    private val homeIr = PhoneNumbers.country("IR")!!
    private val homeTr = PhoneNumbers.country("TR")!!
    private val uk = PhoneNumbers.country("GB")!!

    @Test
    fun `digits come out ASCII from any keyboard, a leading plus is kept`() {
        assertEquals("09121234567", PhoneNumbers.digits("۰۹۱۲ ۱۲۳-۴۵۶۷"))
        assertEquals("09121234567", PhoneNumbers.digits("٠٩١٢١٢٣٤٥٦٧"))
        assertEquals("+905321234567", PhoneNumbers.digits(" +90 (532) 123 45 67"))
        assertEquals("905321234567", PhoneNumbers.digits("90+532 123 45 67"))
    }

    @Test
    fun `a national number drops its trunk zero and gets the country code`() {
        assertEquals(PhoneParse.Valid("+989121234567", homeIr), PhoneNumbers.parse(homeIr, "09121234567"))
        assertEquals(PhoneParse.Valid("+989121234567", homeIr), PhoneNumbers.parse(homeIr, "9121234567"))
        assertEquals(PhoneParse.Valid("+905321234567", homeTr), PhoneNumbers.parse(homeTr, "0532 123 45 67"))
    }

    @Test
    fun `incomplete and impossible numbers are told apart`() {
        assertEquals(PhoneParse.Incomplete, PhoneNumbers.parse(homeIr, ""))
        assertEquals(PhoneParse.Incomplete, PhoneNumbers.parse(homeIr, "0912123"))
        assertEquals(PhoneParse.Invalid, PhoneNumbers.parse(homeIr, "091212345678"))
        // Mobile numbers start with 9 under +98, with 7 under +44.
        assertEquals(PhoneParse.Invalid, PhoneNumbers.parse(homeIr, "02112345678"))
        assertEquals(PhoneParse.Invalid, PhoneNumbers.parse(uk, "02079460000"))
        assertEquals(PhoneParse.Valid("+447700900123", uk), PhoneNumbers.parse(uk, "07700 900123"))
    }

    @Test
    fun `a number typed with its code is read on its own terms`() {
        assertEquals(PhoneParse.Valid("+905321234567", homeTr), PhoneNumbers.parse(homeIr, "+90 532 123 45 67"))
        assertEquals(PhoneParse.Valid("+905321234567", homeTr), PhoneNumbers.parse(homeIr, "0090 532 123 45 67"))
        // A calling code the picker does not list still goes to the server when its length is plausible.
        val other = PhoneNumbers.parse(homeIr, "+372 5123 4567")
        assertTrue(other is PhoneParse.Valid && other.e164 == "+37251234567" && other.country == null)
        assertEquals(PhoneParse.Incomplete, PhoneNumbers.parse(homeIr, "+372 51"))
    }

    @Test
    fun `shared calling codes name their main country`() {
        assertEquals("US", PhoneNumbers.international("+1 202 555 0143")?.first?.iso)
        assertEquals("RU", PhoneNumbers.international("+7 912 345 6789")?.first?.iso)
        assertNull(PhoneNumbers.international("0912"))
    }

    @Test
    fun `numbers are grouped for display`() {
        assertEquals("912 123 4567", PhoneNumbers.group(homeIr, "9121234567"))
        assertEquals("532 123 45 67", PhoneNumbers.group(homeTr, "5321234567"))
        assertEquals("+98 912 123 4567", PhoneNumbers.display("+989121234567"))
        assertEquals("91", PhoneNumbers.group(homeIr, "91"))
    }

    @Test
    fun `the default country follows the store, then the SIM, then the language`() {
        assertEquals("IR", PhoneNumbers.defaultCountry("IR", "tr", "tr", "en").iso)
        assertEquals("TR", PhoneNumbers.defaultCountry(null, "tr", null, "en").iso)
        assertEquals("DE", PhoneNumbers.defaultCountry(null, "", "de", "en").iso)
        assertEquals("IR", PhoneNumbers.defaultCountry(null, null, null, "fa").iso)
        assertEquals("US", PhoneNumbers.defaultCountry(null, null, null, "en").iso)
    }

    @Test
    fun `every listed country is well formed and listed once`() {
        val isos = PhoneNumbers.countries.map { it.iso }
        assertEquals(isos.size, isos.toSet().size)
        PhoneNumbers.countries.forEach { c ->
            assertTrue(c.iso, c.iso.matches(Regex("[A-Z]{2}")))
            assertTrue(c.iso, c.dialCode.matches(Regex("[1-9][0-9]{0,2}")))
            assertTrue(c.iso, c.nationalLengths.first >= 6 && c.nationalLengths.last <= 13)
            assertEquals(c.iso, 4, c.flag.codePointCount(0, c.flag.length) * 2)
            // The example fits the country's own check.
            val example = PhoneNumbers.parse(c, c.example)
            assertTrue("${c.iso} example ${c.example}", example is PhoneParse.Valid || c.nationalLengths.last > 10)
        }
    }

    @Test
    fun `the field shows groups and the language's digits, and the caret maps back`() {
        val persian = PhoneVisualTransformation(homeIr, AppLanguage.FA).filter(AnnotatedString("09121234567"))
        assertEquals("۰۹۱۲ ۱۲۳ ۴۵۶۷", persian.text.text)
        val english = PhoneVisualTransformation(homeIr, AppLanguage.EN).filter(AnnotatedString("9121234567"))
        assertEquals("912 123 4567", english.text.text)
        // After the fourth digit the caret sits after the space it was given.
        assertEquals(5, english.offsetMapping.originalToTransformed(4))
        assertEquals(4, english.offsetMapping.transformedToOriginal(5))
        assertEquals(english.text.length, english.offsetMapping.originalToTransformed(10))
        val typedWithCode = PhoneVisualTransformation(homeIr, AppLanguage.EN).filter(AnnotatedString("+905321234567"))
        assertEquals("+905321234567", typedWithCode.text.text)
    }
}
