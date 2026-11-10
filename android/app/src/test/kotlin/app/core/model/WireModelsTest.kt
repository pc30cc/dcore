package app.core.model

import app.core.testing.Fixtures
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/**
 * The wire models against the fixtures: every example decodes, unknown keys
 * are ignored, unknown enum values degrade to `Unknown`, and request bodies
 * carry exactly the keys the contract expects.
 */
class WireModelsTest {

    /** Which model reads which fixture. A fixture with no entry here fails [everyFixtureDecodes]. */
    private val decoders: Map<String, KSerializer<*>> = mapOf(
        "appeal" to AppealBody.serializer(),
        "auth-result" to AuthResult.serializer(),
        "blocks" to BlockList.serializer(),
        "boost" to BoostStarted.serializer(),
        "call" to CallBody.serializer(),
        "call-accept" to CallAcceptance.serializer(),
        "call-ended" to CallBody.serializer(),
        "call-token" to CallToken.serializer(),
        "cities" to CityList.serializer(),
        "config" to Config.serializer(),
        "config-ui" to Config.serializer(),
        "consents" to ConsentList.serializer(),
        "conversation" to Conversation.serializer(),
        "conversation-body" to ConversationBody.serializer(),
        "conversations" to ConversationsPage.serializer(),
        "deck" to DeckPage.serializer(),
        "deletion" to DeletionScheduled.serializer(),
        "deletion-preflight" to DeletionPreflight.serializer(),
        "entitlements" to Entitlements.serializer(),
        "entitlements-free" to Entitlements.serializer(),
        "export" to ExportStarted.serializer(),
        "export-status" to ExportStatus.serializer(),
        "google-nonce" to GoogleNonce.serializer(),
        "likes" to LikesPage.serializer(),
        "location" to LocationResult.serializer(),
        "me" to Me.serializer(),
        "me-deleted" to Me.serializer(),
        "message-sent" to SentMessageBody.serializer(),
        "messages" to MessagesPage.serializer(),
        "moderation" to ModerationHistory.serializer(),
        "notifications" to NotificationPrefs.serializer(),
        "otp-start" to OtpChallenge.serializer(),
        "own-profile" to OwnProfile.serializer(),
        "photo-complete" to PhotoCompleted.serializer(),
        "photo-upload" to PhotoUploadTicket.serializer(),
        "preferences" to DiscoveryPreferences.serializer(),
        "products-play" to StoreProducts.serializer(),
        "profile-card" to ProfileCard.serializer(),
        "public-deletion-start" to PublicDeletionChallenge.serializer(),
        "purchase" to PurchaseResult.serializer(),
        "purchase-pending" to PurchaseResult.serializer(),
        "realtime-token" to RealtimeToken.serializer(),
        "report" to ReportReceipt.serializer(),
        "request-sent" to SentRequestBody.serializer(),
        "requests" to MessageRequestsPage.serializer(),
        "restore" to RestoreResult.serializer(),
        "restore-account" to RestoredAccount.serializer(),
        "settings" to Settings.serializer(),
        "settings-template" to Settings.serializer(),
        "support-message" to SupportMessageBody.serializer(),
        "support-messages" to SupportMessages.serializer(),
        "support-ticket" to SupportTicketBody.serializer(),
        "support-tickets" to SupportTickets.serializer(),
        "swipes" to SwipesResult.serializer(),
        "token-pair" to TokenPair.serializer(),
        "verification-session" to VerificationSession.serializer(),
        "verification-state" to VerificationState.serializer(),
    )

    @Test
    fun everyFixtureDecodes() {
        val names = Fixtures.names().filterNot { it.startsWith("problem-") }
        assertTrue("fixtures were found", names.size > 40)
        val unmapped = names - decoders.keys
        assertTrue("fixtures without a decoder: $unmapped", unmapped.isEmpty())
        for (name in names) {
            try {
                Fixtures.decode(name, decoders.getValue(name))
            } catch (e: SerializationException) {
                fail("$name did not decode: ${e.message}")
            }
        }
    }

    @Test
    fun configKeepsWhatItKnowsAndIgnoresTheRest() {
        val config = Fixtures.decode("config", Config.serializer())
        assertEquals(42L, config.v)
        assertEquals(10, config.minVersion.required)
        // `passkey` is a method this build does not know.
        assertEquals(listOf(AuthMethod.Phone, AuthMethod.Google, AuthMethod.Unknown), config.auth.methods)
        assertEquals(true, config.catalog.fields.single { it.key == "religion" }.isPrivate)
        assertEquals("Nobody new nearby", config.strings["deck.empty"])
        assertEquals("#E8466A", config.colors?.brand?.light)
        assertFalse(config.calls.video)
    }

    @Test
    fun templatesReadFromTheConfigAndTheSettings() {
        // A server older than templates sends neither: the app keeps its own choice and the built-in default.
        assertNull(Fixtures.decode("config", Config.serializer()).ui)
        assertNull(Fixtures.decode("settings", Settings.serializer()).template)
        val ui = Fixtures.decode("config-ui", Config.serializer()).ui!!
        assertEquals("white", ui.defaultTemplate)
        // An id this build does not ship stays in the list; the effective-template rule skips it.
        assertEquals(listOf("white", "neon", "sepia"), ui.templates)
        assertEquals("white", Fixtures.decode("settings-template", Settings.serializer()).template)
        // The patch sends only the template.
        assertEquals("""{"template":"neon"}""", Wire.json.encodeToString(SettingsPatch.serializer(), SettingsPatch(template = "neon")))
    }

    @Test
    fun meCarriesTheOwnProfileAndUnknownStatesDegrade() {
        val me = Fixtures.decode("me", Me.serializer())
        assertEquals(AccountStatus.Active, me.status)
        assertEquals(StoreName.Bazaar, me.store)
        val profile = me.profile!!
        assertEquals(LocalDate.of(1996, 9, 14), profile.birthDate)
        assertEquals(listOf(PhotoStatus.Approved, PhotoStatus.Rejected, PhotoStatus.Unknown), profile.photos.map { it.status })
        assertEquals("A face must be visible.", profile.photos[1].rejectReason)
        assertNull("a photo still processing has no URL yet", profile.photos[2].url)
        assertTrue(profile.settings.modeRomance)
        val preferences = me.preferences!!
        assertEquals(listOf(Gender.Woman, Gender.Nonbinary, Gender.Unknown), preferences.interestedIn)
        assertEquals(listOf(160, 185), preferences.filters["height"])
        assertEquals(ModerationKind.Suspension, me.moderation.single().kind)
        assertEquals(AppealStatus.Open, me.moderation.single().appeal?.status)
        assertEquals("Istanbul", me.location?.travel?.city?.name)
        assertEquals(Instant.parse("2026-12-06T09:14:03.120Z"), me.deletion?.purgeAt)
    }

    @Test
    fun aDeletingAccountGetsAMinimalMe() {
        val me = Fixtures.decode("me-deleted", Me.serializer())
        assertEquals(AccountStatus.Deleted, me.status)
        assertNull(me.profile)
        assertNull(me.preferences)
        assertTrue(me.moderation.isEmpty())
    }

    @Test
    fun aCardCarriesItsPartsAndNothingPrivate() {
        val card = Fixtures.decode("profile-card", ProfileCard.serializer())
        assertEquals(Distance(2, lessThan = true), card.distance)
        assertTrue(card.likesYou && card.superliked && card.traveling)
        assertEquals(14_200, card.prompts[1].audioMs)
        assertEquals(listOf(31, 33), card.fields.single { it.fieldId == 3 }.options)
        // The contract's privacy rule, as a property of the model: there is nowhere to put these.
        val names = ProfileCard.serializer().descriptor.let { d -> (0 until d.elementsCount).map(d::getElementName) }
        for (forbidden in listOf("birthDate", "lat", "lng", "cell", "phone", "email", "userId")) {
            assertFalse("ProfileCard must not have '$forbidden'", forbidden in names)
        }
    }

    @Test
    fun messagesOfUnknownKindsDegradeInsteadOfDroppingThePage() {
        val page = Fixtures.decode("messages", MessagesPage.serializer())
        assertEquals(
            listOf(MessageKind.Text, MessageKind.Reaction, MessageKind.Call, MessageKind.Image, MessageKind.Unknown, MessageKind.Unsend),
            page.items.map { it.kind },
        )
        val line = page.items[2].call!!
        assertEquals(CallOutcome.Completed, line.outcome)
        assertEquals(754L, line.durationSeconds)
        assertEquals("image/webp", page.items[3].media?.mime)
        assertEquals("1287390234923417601", page.items[5].refId)
        assertEquals("1287390234923417605", page.readCursors.me)
        assertTrue(page.hasMore)
        assertNull("the write lag comes from a header, never the body", page.writeLagMs)
    }

    @Test
    fun conversationsDegradeUnknownStatesAndNullPointers() {
        val page = Fixtures.decode("conversations", ConversationsPage.serializer())
        val first = page.items[0]
        assertEquals(CallsAllowed(me = true, peer = false), first.callsAllowed)
        assertFalse(first.callsAllowed.both)
        assertTrue(first.peer.online)
        val second = page.items[1]
        assertEquals(ConversationSource.ItemLike, second.source)
        assertEquals(ConversationState.Unknown, second.state)
        assertNull(second.lastMessage)
        assertNull(second.myReadId)
        assertNull(page.nextCursor)
    }

    @Test
    fun swipeResultsAndSuggestionsDegrade() {
        val deck = Fixtures.decode("deck", DeckPage.serializer())
        assertEquals(listOf(DeckSuggestion.WidenDistance, DeckSuggestion.Unknown), deck.suggestions)
        assertEquals(Gender.Woman, deck.cards[1].gender)

        val swipes = Fixtures.decode("swipes", SwipesResult.serializer())
        assertEquals(listOf(SwipeOutcome.Matched, SwipeOutcome.Passed, SwipeOutcome.Unknown), swipes.results.map { it.result })
        assertEquals("1287390234923400001", swipes.results[0].conversation?.id)
        assertTrue(swipes.quotas.likes!!.unlimited)
    }

    @Test
    fun freeLikesAreBlurredAndPaidOnesCarryTheCard() {
        val likes = Fixtures.decode("likes", LikesPage.serializer())
        assertEquals(7, likes.total)
        assertNull(likes.items[0].liker)
        assertEquals("LEHV6nWB2yk8pyo0adR*.7kCMdnj", likes.items[0].blurhash)
        assertEquals(LikeKind.Superlike, likes.items[1].kind)
        assertEquals(ItemKind.Photo, likes.items[1].item?.kind)
    }

    @Test
    fun entitlementsReadTheFeatureKeysAndDefaultTheRest() {
        val paid = Fixtures.decode("entitlements", Entitlements.serializer())
        assertEquals("plus", paid.plan)
        assertEquals(EntitlementSource.Play, paid.source)
        assertTrue(paid.features.seeLikes && paid.features.advancedFilters && paid.features.travelMode)
        assertFalse(paid.features.readReceipts)
        assertEquals(Int.MAX_VALUE, paid.quotas.likes!!.left)
        assertEquals(2, paid.quotas.superlikes!!.left)
        assertEquals(3, paid.wallet.dm)

        val free = Fixtures.decode("entitlements-free", Entitlements.serializer())
        assertEquals(PlanKey.FREE, free.plan)
        assertFalse(free.features.seeLikes)
        assertEquals(47, free.quotas.likes!!.left)
        assertNull(free.quotas.boosts)
        assertEquals(Wallet(), free.wallet)
    }

    @Test
    fun productsOfUnknownPeriodsAndItemsDegradeAndAnyPlanKeyIsKept() {
        val products = Fixtures.decode("products-play", StoreProducts.serializer())
        assertEquals(StoreName.Play, products.store)
        assertEquals(listOf(BillingPeriod.Month, BillingPeriod.Week, BillingPeriod.Unknown), products.subscriptions.map { it.period })
        // Plans are the admin's keys, not a list in the app: a key this build never heard of is kept as it is.
        assertEquals(listOf("plus", "premium", "gold"), products.subscriptions.map { it.plan })
        assertTrue("an older server lists no plans", products.plans.isEmpty())
        assertEquals(WalletItem.Unknown, products.consumables[1].item)
    }

    @Test
    fun callsAndTokens() {
        val accepted = Fixtures.decode("call-accept", CallAcceptance.serializer())
        assertEquals(CallRole.Callee, accepted.call.role)
        assertEquals(CallState.Connecting, accepted.call.state)
        assertTrue(accepted.call.state.isLive)
        assertNull(accepted.token.turn)
        assertEquals(IcePolicy.All, accepted.token.icePolicy)

        val relayed = Fixtures.decode("call-token", CallToken.serializer())
        assertEquals(IcePolicy.Relay, relayed.icePolicy)
        assertEquals(listOf("turn:relay.example.com:3478?transport=udp"), relayed.turn?.urls)

        val ended = Fixtures.decode("call-ended", CallBody.serializer()).call
        assertFalse(ended.state.isLive)
        assertEquals(754L, ended.durationSeconds)
    }

    @Test
    fun purchasesKeepTheServersState() {
        val pending = Fixtures.decode("purchase-pending", PurchaseResult.serializer())
        assertTrue(pending.purchase.pending)
        assertNull(pending.entitlements)
        val granted = Fixtures.decode("purchase", PurchaseResult.serializer())
        assertFalse(granted.purchase.pending)
        assertEquals("plus", granted.entitlements?.plan)
    }

    @Test
    fun moderationHistoryDegradesKindsItDoesNotShow() {
        val history = Fixtures.decode("moderation", ModerationHistory.serializer())
        assertEquals(listOf(ModerationKind.Warning, ModerationKind.Unknown), history.history.map { it.kind })
        assertEquals(Instant.parse("2026-11-08T10:00:00Z"), history.active.single().endsAt)
    }

    @Test
    fun timesReadAnyFractionAndOffsetAndWriteMilliseconds() {
        assertEquals(Instant.parse("2026-11-06T09:14:03Z"), InstantSerializer.parse("2026-11-06T09:14:03Z"))
        assertEquals(Instant.parse("2026-11-06T09:14:03.123456Z"), InstantSerializer.parse("2026-11-06T09:14:03.123456Z"))
        assertEquals(Instant.parse("2026-11-06T05:44:03.120Z"), InstantSerializer.parse("2026-11-06T09:14:03.120+03:30"))
        assertNull(InstantSerializer.parse("yesterday"))
        assertEquals("2026-11-06T09:14:03.000Z", InstantSerializer.format(Instant.parse("2026-11-06T09:14:03Z")))
        assertEquals("2026-11-06T09:14:03.120Z", InstantSerializer.format(Instant.parse("2026-11-06T09:14:03.120Z")))
    }

    @Test
    fun aRequiredTimeThatDoesNotParseIsADecodingError() {
        val broken = """{"endsAt":"soon"}"""
        try {
            Wire.json.decodeFromString(BoostStarted.serializer(), broken)
            fail("expected a decoding error")
        } catch (expected: SerializationException) {
        }
    }

    @Test
    fun unknownEnumValuesEncodeAsUnknownAndReadBack() {
        val list = ListSerializer(Gender.serializer())
        val text = Wire.json.encodeToString(list, listOf(Gender.Woman, Gender.Unknown))
        assertEquals("""["woman","unknown"]""", text)
        assertEquals(listOf(Gender.Woman, Gender.Unknown), Wire.json.decodeFromString(list, text))
    }

    // MARK: - Request bodies

    private fun keysOf(json: String): Set<String> = Wire.json.parseToJsonElement(json).jsonObject.keys

    @Test
    fun aPatchSendsOnlyWhatItChanges() {
        val body = Wire.json.encodeToString(SettingsPatch.serializer(), SettingsPatch(snoozed = true))
        assertEquals("""{"snoozed":true}""", body)
        val profile = Wire.json.encodeToString(ProfilePatch.serializer(), ProfilePatch(about = "Hi", intention = Intention.NotSure))
        assertEquals(setOf("about", "intention"), keysOf(profile))
        assertTrue(profile.contains("\"not_sure\""))
    }

    @Test
    fun aNullThatMeansClearIsSent() {
        val device = Wire.json.encodeToString(DeviceUpdate.serializer(), DeviceUpdate(null, false, "1.0.0", "fa"))
        assertEquals("""{"pushToken":null,"notificationsEnabled":false,"appVersion":"1.0.0","locale":"fa"}""", device)
        val prompt = Wire.json.encodeToString(PromptEdit.serializer(), PromptEdit(position = 1, promptId = 4, answer = null))
        assertEquals("""{"position":1,"promptId":4,"answer":null}""", prompt)
    }

    @Test
    fun requestBodiesUseTheContractsNames() {
        val verify = Wire.json.encodeToString(
            OtpVerifyRequest.serializer(),
            OtpVerifyRequest("ch_1", "123456", "8b0e7f3c-0000-4000-8000-000000000001", "ab".repeat(32), DeviceInfo("Pixel 8", "16", "1.0.0", "fa")),
        )
        assertEquals(setOf("challengeId", "code", "installId", "deviceKey", "device"), keysOf(verify))

        val swipe = Wire.json.encodeToString(
            SwipesRequest.serializer(),
            SwipesRequest(listOf(Swipe("bnegar2kq7xm4", SwipeAction.Superlike, LikedItem(ItemKind.Prompt, "12"), "Hi"))),
        )
        assertEquals(
            """{"swipes":[{"target":"bnegar2kq7xm4","action":"superlike","item":{"kind":"prompt","ref":"12"},"comment":"Hi"}]}""",
            swipe,
        )

        val location = Wire.json.encodeToString(LocationUpdate.serializer(), LocationUpdate(35.7, 51.4, LocationSource.Gps))
        assertEquals(setOf("lat", "lng", "source"), keysOf(location))

        val basics = Wire.json.encodeToString(
            BasicsRequest.serializer(),
            BasicsRequest(LocalDate.of(1995, 4, 2), Gender.Nonbinary, ConsentVersions(terms = 3, privacy = 2)),
        )
        assertEquals("""{"birthDate":"1995-04-02","gender":"nonbinary","consents":{"terms":3,"privacy":2}}""", basics)

        val byCity = Wire.json.encodeToString(LocationUpdate.serializer(), LocationUpdate(source = LocationSource.City, cityId = 112931))
        assertEquals("""{"source":"city","cityId":112931}""", byCity)

        val photo = Wire.json.encodeToString(PhotoUploadRequest.serializer(), PhotoUploadRequest(0, PhotoMime.Heic, 1_000L))
        assertEquals("""{"position":0,"mime":"image/heic","bytes":1000}""", photo)

        val report = Wire.json.encodeToString(
            ReportRequest.serializer(),
            ReportRequest("bnegar2kq7xm4", ReportContext.Chat, ReportReason.Under18, messageIds = listOf("1"), block = true),
        )
        assertEquals(setOf("target", "context", "reason", "messageIds", "block"), keysOf(report))
        assertTrue(report.contains("\"under_18\""))

        val event = Wire.json.encodeToString(
            AppEvent.serializer(),
            AppEvent("paywall_shown", Instant.parse("2026-11-06T09:14:03.120Z"), JsonObject(mapOf("source" to JsonPrimitive("deck")))),
        )
        assertEquals("""{"name":"paywall_shown","at":"2026-11-06T09:14:03.120Z","props":{"source":"deck"}}""", event)
    }

    // MARK: - Problems

    @Test
    fun problemsCarryTheirExtensionMembers() {
        val otp = Problem.parse(400, Fixtures.text("problem-otp-invalid"))
        assertEquals(ProblemCodes.OTP_INVALID, otp.code)
        assertEquals(3, otp.attemptsLeft)
        assertEquals("req-1", otp.requestId)

        val suspended = Problem.parse(403, Fixtures.text("problem-suspended"))
        assertEquals("Repeated reports of harassment.", suspended.reasonText)
        assertEquals("1287390234923455001", suspended.actionId)
        assertEquals(Instant.parse("2026-11-08T10:00:00Z"), suspended.until)
        assertEquals(true, suspended.appealable)

        val quota = Problem.parse(429, Fixtures.text("problem-quota"))
        assertEquals("dm", quota.feature)
        assertEquals(true, quota.canBuy)
        assertEquals(Instant.parse("2026-11-07T00:00:00Z"), quota.resetsAt)

        val invalid = Problem.parse(400, Fixtures.text("problem-validation"))
        assertEquals(listOf("/about"), invalid.invalidPointers)
    }

    @Test
    fun aFailureThatIsNotAProblemDocumentStillReads() {
        val html = Problem.parse(502, "<html><body>Bad gateway</body></html>", retryAfterHeader = "5")
        assertEquals(502, html.status)
        assertNull(html.code)
        assertEquals(5L, html.retryAfterSeconds)

        assertEquals("token_expired", Problem.parse(401, """{"error":{"code":"token_expired"}}""").code)
        assertEquals("maintenance", Problem.parse(503, """{"error":"maintenance"}""").code)
        assertNull(Problem.parse(500, "").code)
    }
}
