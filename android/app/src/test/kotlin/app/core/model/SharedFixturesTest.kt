package app.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.time.LocalDate

/**
 * The server's contract fixtures (`server/packages/shared/fixtures`), decoded
 * with the app's models. The server validates every one of these files
 * strictly against its schemas, so a file that decodes here, with no field
 * falling back to `Unknown`, is a shape both sides agree on. The files are
 * read from the repository: unit tests run inside `android/app`.
 *
 * The app's own examples in `src/test/resources/fixtures/v1` stay: they mix
 * in unknown keys and values on purpose, to prove the models degrade.
 */
class SharedFixturesTest {

    private val root: File = generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "server/packages/shared/fixtures") }
        .firstOrNull { it.isDirectory }
        ?: error("server/packages/shared/fixtures not found above ${System.getProperty("user.dir")}")

    private fun names(dir: String): List<String> =
        File(root, dir).listFiles().orEmpty().filter { it.name.endsWith(".json") }.map { it.name.removeSuffix(".json") }.sorted()

    private fun text(dir: String, name: String): String = File(root, "$dir/$name.json").readText()

    /** Which model reads each response fixture. A fixture with no entry fails [everyResponseDecodes]. */
    private val responses: Map<String, KSerializer<*>> = mapOf(
        "appeal" to AppealBody.serializer(),
        "auth-result" to AuthResult.serializer(),
        "blocks" to BlockList.serializer(),
        "call-acceptance" to CallAcceptance.serializer(),
        "call-body" to CallBody.serializer(),
        "call-token" to CallToken.serializer(),
        "cities" to CityList.serializer(),
        "config" to Config.serializer(),
        "consents" to ConsentList.serializer(),
        "conversation" to Conversation.serializer(),
        "conversation-body" to ConversationBody.serializer(),
        "conversations-page" to ConversationsPage.serializer(),
        "message-request-sent" to SentRequestBody.serializer(),
        "message-requests-page" to MessageRequestsPage.serializer(),
        "messages-page" to MessagesPage.serializer(),
        "sent-message" to SentMessageBody.serializer(),
        "deck-page" to DeckPage.serializer(),
        "likes-page" to LikesPage.serializer(),
        "swipes-result" to SwipesResult.serializer(),
        "deletion" to DeletionScheduled.serializer(),
        "deletion-preflight" to DeletionPreflight.serializer(),
        "google-nonce" to GoogleNonce.serializer(),
        "location" to LocationResult.serializer(),
        "me" to Me.serializer(),
        "me-deleted" to Me.serializer(),
        "me-onboarding" to Me.serializer(),
        "moderation" to ModerationHistory.serializer(),
        "notifications" to NotificationPrefs.serializer(),
        "otp-start" to OtpChallenge.serializer(),
        "own-profile" to OwnProfile.serializer(),
        "photo-complete" to PhotoCompleted.serializer(),
        "photo-upload" to PhotoUploadTicket.serializer(),
        "preferences" to DiscoveryPreferences.serializer(),
        "profile-card" to ProfileCard.serializer(),
        "public-deletion-start" to PublicDeletionChallenge.serializer(),
        "realtime-token" to RealtimeToken.serializer(),
        "report" to ReportReceipt.serializer(),
        "restore-account" to RestoredAccount.serializer(),
        "settings" to Settings.serializer(),
        "token-pair" to TokenPair.serializer(),
        "export-started" to ExportStarted.serializer(),
        "export-status" to ExportStatus.serializer(),
    )

    /** The model of every realtime event's payload (`d`). A fixture with no entry fails [everyRealtimePayloadDecodesWithoutFallingBack]. */
    private val realtimePayloads: Map<String, KSerializer<*>> = mapOf(
        RealtimeTypes.MESSAGE to Message.serializer(),
        RealtimeTypes.RECEIPT to ReceiptEvent.serializer(),
        RealtimeTypes.TYPING to TypingEvent.serializer(),
        RealtimeTypes.CONVERSATION to ConversationEvent.serializer(),
        RealtimeTypes.CONVERSATION_END to ConversationEndEvent.serializer(),
        RealtimeTypes.LIKE to LikeEvent.serializer(),
        RealtimeTypes.REQUEST to RequestEvent.serializer(),
        RealtimeTypes.CALL to Call.serializer(),
        RealtimeTypes.ENTITLEMENT to Entitlements.serializer(),
        RealtimeTypes.PROFILE to ProfileEvent.serializer(),
        RealtimeTypes.ACCOUNT to AccountEvent.serializer(),
        RealtimeTypes.SUPPORT to SupportEvent.serializer(),
        RealtimeTypes.CONFIG to ConfigEvent.serializer(),
    )

    /** The `const val` strings of an object of constants (`RealtimeTypes`, `PushTypes`, `ProblemCodes`). */
    private fun constants(holder: Any): Set<String> = holder.javaClass.declaredFields
        .filter { java.lang.reflect.Modifier.isStatic(it.modifiers) && it.type == String::class.java }
        .map { it.isAccessible = true; it.get(null) as String }
        .toSet()

    @Suppress("UNCHECKED_CAST")
    private fun roundTrip(serializer: KSerializer<*>, json: String): JsonElement {
        val value = Wire.json.decodeFromString(serializer, json)
        return Wire.json.encodeToJsonElement(serializer as KSerializer<Any?>, value)
    }

    /** Every string in a tree: an enum that fell back to `Unknown` encodes as "unknown". */
    private fun strings(element: JsonElement): Sequence<String> = when (element) {
        is JsonObject -> element.values.asSequence().flatMap { strings(it) }
        is kotlinx.serialization.json.JsonArray -> element.asSequence().flatMap { strings(it) }
        is JsonPrimitive -> if (element.isString) sequenceOf(element.content) else emptySequence()
    }

    @Test
    fun everyResponseDecodesWithoutFallingBack() {
        val files = names("v1").filterNot { it.startsWith("problem-") }
        assertTrue("shared fixtures were found", files.size > 20)
        assertEquals("fixtures without a model", emptyList<String>(), files - responses.keys)
        assertEquals("models without a fixture", emptyList<String>(), (responses.keys - files.toSet()).toList())
        for (name in files) {
            val back = try {
                roundTrip(responses.getValue(name), text("v1", name))
            } catch (e: SerializationException) {
                fail("$name did not decode: ${e.message}")
                return
            }
            assertFalse("$name has a value this build does not know", strings(back).any { it == "unknown" })
        }
    }

    @Test
    fun theAccountReadsAsTheServerMeantIt() {
        val me = Wire.json.decodeFromString(Me.serializer(), text("v1", "me"))
        assertEquals(AccountStatus.Active, me.status)
        assertEquals(StoreName.Bazaar, me.store)
        assertEquals(listOf(ConsentKind.Terms), me.consentsDue)
        assertEquals(ModerationKind.Suspension, me.moderation.single().kind)
        val profile = me.profile!!
        assertEquals(LocalDate.of(1996, 9, 14), profile.birthDate)
        assertEquals(
            listOf(PhotoStatus.Approved, PhotoStatus.Rejected, PhotoStatus.Processing, PhotoStatus.Review),
            profile.photos.map { it.status },
        )
        assertTrue(profile.settings.modeRomance)

        val onboarding = Wire.json.decodeFromString(Me.serializer(), text("v1", "me-onboarding"))
        assertEquals(null, onboarding.profile)
        assertEquals(listOf(ConsentKind.Terms, ConsentKind.Privacy, ConsentKind.Guidelines), onboarding.consentsDue)

        val config = Wire.json.decodeFromString(Config.serializer(), text("v1", "config"))
        assertEquals(2, config.legal.versions.terms)
        assertTrue(config.catalog.fields.single { it.key == "religion" }.sensitive)
    }

    @Test
    fun problemsCarryTheirMembers() {
        val expected = mapOf(
            "problem-otp-invalid" to ProblemCodes.OTP_INVALID,
            "problem-suspended" to ProblemCodes.ACCOUNT_SUSPENDED,
            "problem-deleted" to ProblemCodes.ACCOUNT_DELETED,
            "problem-consent-required" to ProblemCodes.CONSENT_REQUIRED,
            "problem-upgrade-required" to ProblemCodes.UPGRADE_REQUIRED,
            "problem-maintenance" to ProblemCodes.MAINTENANCE,
            "problem-quota" to ProblemCodes.QUOTA_EXCEEDED,
            "problem-validation" to ProblemCodes.VALIDATION_FAILED,
            "problem-rate-limited" to ProblemCodes.RATE_LIMITED,
        )
        assertEquals(expected.keys.sorted(), names("v1").filter { it.startsWith("problem-") })
        for ((name, code) in expected) {
            val status = Wire.json.parseToJsonElement(text("v1", name)).jsonObject["status"]!!.intOrNull!!
            assertEquals(name, code, Problem.parse(status, text("v1", name)).code)
        }
        assertEquals(3, Problem.parse(400, text("v1", "problem-otp-invalid")).attemptsLeft)
        assertEquals(true, Problem.parse(403, text("v1", "problem-suspended")).appealable)
        assertEquals(12031, Problem.parse(426, text("v1", "problem-upgrade-required")).minVersionCode)
        assertEquals("Back in a few minutes.", Problem.parse(503, text("v1", "problem-maintenance")).message)
        assertEquals(listOf("terms"), Problem.parse(403, text("v1", "problem-consent-required")).kinds)
        assertEquals(42L, Problem.parse(429, text("v1", "problem-rate-limited")).retryAfterSeconds)
    }

    @Test
    fun everyRealtimePayloadDecodesWithoutFallingBack() {
        val files = names("realtime")
        assertEquals("realtime fixtures without a model", emptyList<String>(), files - realtimePayloads.keys)
        assertEquals("models without a realtime fixture", emptyList<String>(), (realtimePayloads.keys - files.toSet()).toList())
        assertEquals("envelope types this build names", files.toSet(), constants(RealtimeTypes))
        for ((type, serializer) in realtimePayloads) {
            val envelope = Wire.json.parseToJsonElement(text("realtime", type)).jsonObject
            assertEquals(type, envelope["t"]?.stringOrNull)
            assertEquals("$type: envelope version", 1, envelope["v"]?.intOrNull)
            val back = try {
                roundTrip(serializer, envelope["d"].toString())
            } catch (e: SerializationException) {
                fail("$type did not decode: ${e.message}")
                return
            }
            assertFalse("$type has a value this build does not know", strings(back).any { it == "unknown" })
            assertTrue("$type: the realtime decoder drops it", RealtimeEvents.decode(Wire.json.parseToJsonElement(text("realtime", type))) != null)
        }
    }

    @Test
    fun everyPushParsesToAKnownType() {
        val files = names("push")
        assertEquals("push types this build names", files.toSet(), constants(PushTypes))
        val stringMap = MapSerializer(String.serializer(), String.serializer())
        for (type in files) {
            // FCM data is a string map: every value must be a string.
            val data = try {
                Wire.json.decodeFromString(stringMap, text("push", type))
            } catch (e: SerializationException) {
                fail("$type is not a string map: ${e.message}")
                return
            }
            assertEquals(type, data["type"])
            val push = PushData.parse(data)
            assertTrue("$type did not parse: $push", push != null && push !is PushData.Unknown)
            assertEquals(type, push!!.type)
        }
    }

    /**
     * The problem codes the server can send (`server/packages/shared/src/problem.ts`,
     * its catalogue) and this build's [ProblemCodes]: the same set, so no
     * refusal is read by its HTTP status alone and no branch waits for a
     * code that never comes.
     */
    @Test
    fun theProblemCodesAreTheServersCatalogue() {
        val source = File(root, "../src/problem.ts").readText()
        val block = source.substringAfter("const catalogue = {").substringBefore("} as const")
        val server = Regex("^\\s+([a-z_]+): \\[(\\d{3}),", RegexOption.MULTILINE).findAll(block).map { it.groupValues[1] }.toSet()
        assertTrue("the catalogue was read", server.size > 40)
        val ours = constants(ProblemCodes)
        assertEquals("codes the server sends that this build does not name", emptySet<String>(), server - ours)
        assertEquals("codes this build names that the server never sends", emptySet<String>(), ours - server)
    }
}
