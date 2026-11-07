package app.core.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SmsCodeReceiverTest {

    @Test
    fun `the code of the expected length is read out of the message`() {
        assertEquals("482913", SmsCodeReceiver.extractCode("<#> Your code is 482913\nAb12Cd34Ef5", 6))
        assertEquals("4829", SmsCodeReceiver.extractCode("Code 4829 - valid 5 minutes. FA+9qCX9VSu", 4))
        assertEquals("482913", SmsCodeReceiver.extractCode("کد ورود شما: ۴۸۲۹۱۳", 6))
        // A longer run of digits (a phone number) is not a code.
        assertNull(SmsCodeReceiver.extractCode("Call 02112345678 for help", 6))
        assertNull(SmsCodeReceiver.extractCode("no digits here", 6))
        assertNull(SmsCodeReceiver.extractCode("123456", 0))
    }
}
