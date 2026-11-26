package app.core.ui.theme

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which phones blur glass: Android 12+, battery saver off, not a low-RAM
 * phone, and a media performance class of 12 or later or about 5 GiB of RAM.
 */
class GlassSupportTest {

    private val gb4 = 3_600_000_000L
    private val gb8 = 7_500_000_000L

    @Test
    fun android11AndOlderNeverBlurs() {
        assertFalse(glassBlurAllowed(sdk = 30, powerSave = false, lowRam = false, performanceClass = 0, totalMemBytes = gb8))
    }

    @Test
    fun batterySaverTurnsItOff() {
        assertFalse(glassBlurAllowed(sdk = 34, powerSave = true, lowRam = false, performanceClass = 34, totalMemBytes = gb8))
    }

    @Test
    fun aLowRamPhoneNeverBlurs() {
        assertFalse(glassBlurAllowed(sdk = 34, powerSave = false, lowRam = true, performanceClass = 34, totalMemBytes = gb8))
    }

    @Test
    fun aFourGigabytePhoneWithoutAPerformanceClassDrawsTheFallback() {
        assertFalse(glassBlurAllowed(sdk = 34, powerSave = false, lowRam = false, performanceClass = 0, totalMemBytes = gb4))
    }

    @Test
    fun anEightGigabytePhoneBlurs() {
        assertTrue(glassBlurAllowed(sdk = 34, powerSave = false, lowRam = false, performanceClass = 0, totalMemBytes = gb8))
    }

    @Test
    fun aDeclaredPerformanceClassBlursWhateverItsRam() {
        assertTrue(glassBlurAllowed(sdk = 34, powerSave = false, lowRam = false, performanceClass = 33, totalMemBytes = gb4))
    }

    @Test
    fun theRamLineSitsBetweenFourAndSixGigabytePhones() {
        assertTrue(GLASS_MIN_RAM_BYTES in (gb4 + 1)..5_600_000_000L)
    }
}
