package app.core.feature.auth

import app.core.model.OtpChallenge
import app.core.model.OtpChannel
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.net.ApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class OtpFlowTest {

    private val homeIr = PhoneNumbers.country("IR")!!
    private val t0 = 1_000_000L

    private fun http(status: Int, code: String, vararg members: Pair<String, Any?>) = ApiError.Http(status, Problem.of(status, code, *members))

    private fun onCode(length: Int = 6, ttl: Int = 300, resend: Int = 60): OtpState {
        var s = OtpFlow.phoneChanged(OtpFlow.start(homeIr, t0), "0912 123 4567")
        val (sending, effect) = OtpFlow.send(s)
        assertEquals(OtpEffect.Send("+989121234567", null), effect)
        s = OtpFlow.sent(sending, "+989121234567", OtpChallenge("ch1", codeLength = length, ttlSeconds = ttl, resendAfterSeconds = resend), t0)
        return s
    }

    @Test
    fun `the number is sent only when complete, and only once at a time`() {
        var s = OtpFlow.start(homeIr, t0)
        assertFalse(s.canSend)
        assertNull(OtpFlow.send(s).second)
        s = OtpFlow.phoneChanged(s, "۰۹۱۲۱۲۳۴۵۶۷")
        assertEquals("09121234567", s.phoneInput)
        assertTrue(s.canSend)
        val (sending, effect) = OtpFlow.send(s)
        assertTrue(effect is OtpEffect.Send)
        assertTrue(sending.sending)
        assertNull("a second tap while sending sends nothing", OtpFlow.send(sending).second)
    }

    @Test
    fun `typing a country code moves the picker`() {
        val s = OtpFlow.phoneChanged(OtpFlow.start(homeIr, t0), "+90 532")
        assertEquals("TR", s.country.iso)
        val back = OtpFlow.countryChanged(s, homeIr)
        assertEquals("IR", back.country.iso)
        assertEquals("532", back.phoneInput)
    }

    @Test
    fun `the boxes follow the length the server sent`() {
        assertEquals(4, onCode(length = 4).codeLength)
        assertEquals(8, onCode(length = 8).codeLength)
        // Nonsense from a server is clamped, not trusted.
        assertEquals(OtpFlow.MIN_CODE, onCode(length = 1).codeLength)
        assertEquals(OtpFlow.MAX_CODE, onCode(length = 40).codeLength)
    }

    @Test
    fun `a full code verifies at once, once, and extra digits are dropped`() {
        val s = onCode(length = 5)
        val (partial, none) = OtpFlow.codeChanged(s, "123")
        assertNull(none)
        assertEquals("123", partial.code)
        val (full, verify) = OtpFlow.codeChanged(partial, "12345999")
        assertEquals(OtpEffect.Verify("ch1", "12345"), verify)
        assertTrue(full.verifying)
        // The same code again (a keyboard re-sending it) does not verify twice.
        assertNull(OtpFlow.codeChanged(full.copy(verifying = false), "12345").second)
    }

    @Test
    fun `Persian digits and a pasted message are read as the code`() {
        val (s, verify) = OtpFlow.codeChanged(onCode(length = 6), "کد شما: ۱۲۳۴۵۶")
        assertEquals("123456", s.code)
        assertEquals(OtpEffect.Verify("ch1", "123456"), verify)
    }

    @Test
    fun `a wrong code says how many tries are left and clears the boxes`() {
        val (verifying, _) = OtpFlow.codeChanged(onCode(), "111111")
        val failed = OtpFlow.verifyFailed(verifying, http(400, ProblemCodes.OTP_INVALID, "attemptsLeft" to 3), t0 + 5_000)
        assertEquals(CodeError.Wrong(3), failed.codeError)
        assertEquals("", failed.code)
        assertFalse(failed.verifying)
        // Typing again clears the message.
        assertNull(OtpFlow.codeChanged(failed, "1").first.codeError)
    }

    @Test
    fun `a lock or an expiry asks for a new code and opens "send again" at once`() {
        val (verifying, _) = OtpFlow.codeChanged(onCode(resend = 60), "111111")
        val locked = OtpFlow.verifyFailed(verifying, http(429, ProblemCodes.OTP_LOCKED), t0 + 10_000)
        assertEquals(CodeError.Locked, locked.codeError)
        assertTrue(locked.expired)
        assertEquals(0, locked.resendInSeconds)
        assertTrue(locked.canResend)
        // A locked code takes no more digits.
        assertNull(OtpFlow.codeChanged(locked, "123456").second)

        val stale = OtpFlow.tick(onCode(ttl = 120), t0 + 121_000)
        assertEquals(CodeError.Expired, stale.codeError)
        assertTrue(stale.canResend)
        assertEquals(CodeError.Expired, OtpFlow.codeError(http(410, ProblemCodes.OTP_EXPIRED), t0))
    }

    @Test
    fun `send again waits for the server's interval, and a refusal's wait on top`() {
        var s = onCode(resend = 60)
        assertEquals(60, OtpFlow.tick(s, t0).resendInSeconds)
        assertFalse(OtpFlow.tick(s, t0 + 30_000).canResend)
        assertNull(OtpFlow.resend(OtpFlow.tick(s, t0 + 30_000)).second)
        s = OtpFlow.tick(s, t0 + 60_000)
        assertTrue(s.canResend)
        val (resending, effect) = OtpFlow.resend(s, OtpChannel.Call)
        assertEquals(OtpEffect.Send("+989121234567", OtpChannel.Call), effect)
        val refused = OtpFlow.sendFailed(resending, http(429, ProblemCodes.RATE_LIMITED, "retryAfterSeconds" to 90), t0 + 60_000)
        assertEquals(90, refused.resendInSeconds)
        assertFalse(refused.canResend)
        assertTrue(OtpFlow.tick(refused, t0 + 150_000).canResend)
    }

    @Test
    fun `a new code replaces the old one and starts its own clocks`() {
        val first = OtpFlow.codeChanged(onCode(), "12").first
        val renewed = OtpFlow.sent(first, "+989121234567", OtpChallenge("ch2", codeLength = 4, ttlSeconds = 300, resendAfterSeconds = 30), t0 + 70_000)
        assertEquals("ch2", renewed.challenge?.id)
        assertEquals("", renewed.code)
        assertEquals(4, renewed.codeLength)
        assertEquals(30, renewed.resendInSeconds)
    }

    @Test
    fun `no answer keeps the code and lets the same one be tried again`() {
        val (verifying, _) = OtpFlow.codeChanged(onCode(), "123456")
        val offline = OtpFlow.verifyFailed(verifying, ApiError.Network(IOException("down")), t0 + 1_000)
        assertEquals(CodeError.Offline, offline.codeError)
        assertEquals("123456", offline.code)
        assertEquals(OtpEffect.Verify("ch1", "123456"), OtpFlow.retryVerify(offline).second)
    }

    @Test
    fun `refusals of the number map to what the screen says`() {
        assertEquals(SendError.Invalid, OtpFlow.sendError(http(400, ProblemCodes.PHONE_INVALID), t0))
        assertEquals(SendError.NotAllowed, OtpFlow.sendError(http(403, ProblemCodes.PHONE_NOT_ALLOWED), t0))
        assertEquals(SendError.Banned, OtpFlow.sendError(http(403, ProblemCodes.PHONE_BANNED), t0))
        assertEquals(SendError.Banned, OtpFlow.sendError(http(403, ProblemCodes.DEVICE_BANNED), t0))
        assertEquals(SendError.SmsUnavailable, OtpFlow.sendError(http(503, ProblemCodes.SMS_UNAVAILABLE), t0))
        assertEquals(SendError.Offline, OtpFlow.sendError(ApiError.Network(IOException()), t0))
        assertEquals(SendError.RateLimited(t0 + 42_000), OtpFlow.sendError(http(429, ProblemCodes.RATE_LIMITED, "retryAfterSeconds" to 42), t0))
        assertEquals(SendError.RateLimited(null), OtpFlow.sendError(http(429, "something_new"), t0))
        assertEquals(SendError.Failed, OtpFlow.sendError(http(500, ProblemCodes.INTERNAL), t0))
    }

    @Test
    fun `a rate-limited number cannot be sent until the wait is over`() {
        val s = OtpFlow.phoneChanged(OtpFlow.start(homeIr, t0), "09121234567")
        val (sending, _) = OtpFlow.send(s)
        val refused = OtpFlow.sendFailed(sending, http(429, ProblemCodes.RATE_LIMITED, "retryAfterSeconds" to 30), t0)
        assertFalse(refused.canSend)
        // Editing the number keeps the wait.
        assertTrue(OtpFlow.phoneChanged(refused, "09121234568").sendBlocked)
        assertTrue(OtpFlow.tick(refused, t0 + 31_000).canSend)
    }

    @Test
    fun `changing the number forgets the code in flight`() {
        val back = OtpFlow.changeNumber(OtpFlow.codeChanged(onCode(), "12").first)
        assertNull(back.challenge)
        assertEquals("", back.code)
        assertEquals("09121234567", PhoneNumbers.digits(back.phoneInput).let { if (it.startsWith("0")) it else "0$it" })
    }
}
