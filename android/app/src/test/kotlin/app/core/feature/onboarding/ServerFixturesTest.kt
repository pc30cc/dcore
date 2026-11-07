package app.core.feature.onboarding

import app.core.model.AccountStatus
import app.core.model.AuthResult
import app.core.model.CityList
import app.core.model.Config
import app.core.model.ConsentKind
import app.core.model.ConsentList
import app.core.model.LocationResult
import app.core.model.Me
import app.core.model.OtpChallenge
import app.core.model.PhotoCompleted
import app.core.model.PhotoUploadTicket
import app.core.model.Problem
import app.core.model.Wire
import kotlinx.serialization.KSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The server's own examples of what sign-in and sign-up read
 * (`server/packages/shared/fixtures/v1`, written from its schemas) decode
 * into this build's models and mean the same. Skipped when the folder is
 * not next to the app (a checkout of the app alone).
 */
class ServerFixturesTest {

    private val folder = File("../../server/packages/shared/fixtures/v1")

    private fun <T> decode(name: String, serializer: KSerializer<T>): T {
        val file = File(folder, "$name.json")
        assumeTrue("no server fixture $name", file.isFile)
        return Wire.json.decodeFromString(serializer, file.readText())
    }

    @Test
    fun signInShapes() {
        assumeTrue(folder.isDirectory)
        val challenge = decode("otp-start", OtpChallenge.serializer())
        assertTrue(challenge.codeLength in 4..10)
        val signedIn = decode("auth-result", AuthResult.serializer())
        assertEquals(AccountStatus.Onboarding, signedIn.user.status)
    }

    @Test
    fun signUpShapes() {
        assumeTrue(folder.isDirectory)
        val config = decode("config", Config.serializer())
        assertTrue(config.legal.versions.terms >= 1)
        assertTrue(config.catalog.fields.isNotEmpty())
        val me = decode("me-onboarding", Me.serializer())
        assertEquals(AccountStatus.Onboarding, me.status)
        assertTrue(ConsentKind.Guidelines in me.consentsDue)
        // A sign-up that has not created its profile yet starts at the beginning.
        assertEquals(OnboardingStep.Name, OnboardingPlan.resume(OnboardingFacts.from(me, config, privacyAccepted = true, notificationsAskable = true)))
        assertTrue(decode("consents", ConsentList.serializer()).consents.isNotEmpty())
        assertTrue(decode("location", LocationResult.serializer()).city != null)
        assertTrue(decode("cities", CityList.serializer()).items.isNotEmpty())
        val ticket = decode("photo-upload", PhotoUploadTicket.serializer())
        assertEquals("PUT", ticket.upload.method)
        assertEquals(ticket.photoId, decode("photo-complete", PhotoCompleted.serializer()).photo.id)
    }

    @Test
    fun refusalsCarryWhatTheScreensRead() {
        assumeTrue(folder.isDirectory)
        val consent = File(folder, "problem-consent-required.json")
        assumeTrue(consent.isFile)
        assertEquals(listOf("terms"), Problem.parse(403, consent.readText()).kinds)
        val limited = File(folder, "problem-rate-limited.json")
        assumeTrue(limited.isFile)
        assertEquals(42L, Problem.parse(429, limited.readText()).retryAfterSeconds)
    }
}
