package app.core.net

import app.core.brand.AppBrand
import app.core.model.AuthMethod
import app.core.model.UiConfig
import app.core.model.AuthOptions
import app.core.model.BillingPeriod
import app.core.model.CallSwitches
import app.core.model.Catalog
import app.core.model.CatalogEntry
import app.core.model.City
import app.core.model.Config
import app.core.model.ConsumableProduct
import app.core.model.DiscoveryPreferences
import app.core.model.Distance
import app.core.model.FieldDef
import app.core.model.FieldOption
import app.core.model.Gender
import app.core.model.Intention
import app.core.model.LegalLinks
import app.core.model.Limits
import app.core.model.MinVersion
import app.core.model.OwnPhoto
import app.core.model.OwnPrompt
import app.core.model.OwnProfile
import app.core.model.Photo
import app.core.model.PhotoStatus
import app.core.model.Plan
import app.core.model.ProfileCard
import app.core.model.ProfileFieldValue
import app.core.model.ProfilePrompt
import app.core.model.PromptDef
import app.core.model.Settings
import app.core.model.SubscriptionProduct
import app.core.model.TextState
import app.core.model.WalletItem
import java.time.LocalDate

/**
 * What the sample backend shows. Deliberately awkward rather than tidy: a very
 * long Latin name beside Persian and Turkish ones, mixed scripts in one list,
 * a card with no prompts, a match nobody has written in yet. A layout proves
 * itself against the cases that break it, not against rows that fit by luck.
 *
 * Photo URLs point at a reserved example host: screens show the blurhash
 * placeholders.
 */
internal object SampleData {

    /** The one-time code every sample sign-in accepts. */
    const val CODE = "123456"

    /** The phone number of the existing sample account; any other valid number makes a new one. */
    const val KNOWN_PHONE = "+989120000000"

    const val ME: String = "aaaaaaaaaaaaa"

    val cities: List<City> = listOf(
        City(112931, "تهران", "IR"),
        City(418863, "اصفهان", "IR"),
        City(115019, "شیراز", "IR"),
        City(124665, "مشهد", "IR"),
        City(113646, "تبریز", "IR"),
        City(745044, "İstanbul", "TR"),
        City(323786, "Ankara", "TR"),
        City(311046, "İzmir", "TR"),
        City(2643743, "London", "GB"),
    )

    /** Rough centres, only to pick the nearest sample city for a position (never echoed). */
    val cityCentres: Map<Int, Pair<Double, Double>> = mapOf(
        112931 to (35.69 to 51.39),
        418863 to (32.65 to 51.67),
        115019 to (29.61 to 52.53),
        124665 to (36.30 to 59.61),
        113646 to (38.08 to 46.29),
        745044 to (41.01 to 28.95),
        323786 to (39.93 to 32.86),
        311046 to (38.42 to 27.14),
        2643743 to (51.51 to -0.13),
    )

    fun city(id: Int): City = cities.first { it.id == id }

    private val blurhashes = listOf(
        "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
        "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
        "LKN]Rv%2Tw=w]~RBVZRi};RPxuwH",
        "LPODnIj[~qof-;ayWBj[~qj[M{ay",
        "L9AB*A%LPqys8_H=yDR5nMMeVXR5",
    )

    fun photo(id: Long, index: Int = 0): Photo = Photo(
        id = id.toString(),
        w = 1080,
        h = 1350,
        blurhash = blurhashes[(id % blurhashes.size).toInt()],
        url = "https://media.example.com/p/$id/1/640.webp?d=${index + 1}",
    )

    private fun card(
        id: String,
        name: String,
        age: Int,
        gender: Gender,
        cityId: Int,
        km: Int,
        firstPhoto: Long,
        photos: Int,
        intention: Intention? = null,
        job: String? = null,
        about: String? = null,
        verified: Boolean = false,
        prompts: List<ProfilePrompt> = emptyList(),
        fields: List<ProfileFieldValue> = emptyList(),
        likesYou: Boolean = false,
        activeRecently: Boolean = false,
    ) = ProfileCard(
        id = id,
        v = 3,
        name = name,
        age = age,
        gender = gender,
        verified = verified,
        intention = intention,
        job = job,
        about = about,
        city = city(cityId),
        distance = if (km < 2) Distance(2, lessThan = true) else Distance(km),
        activeRecently = activeRecently,
        likesYou = likesYou,
        photos = (0 until photos).map { photo(firstPhoto + it, it) },
        prompts = prompts,
        fields = fields,
    )

    /** Everyone the sample account can meet. Public ids are 13 base32 characters, like the server's. */
    val people: List<ProfileCard> = listOf(
        card(
            "bnegar2kq7xm4", "نگار", 27, Gender.Woman, 112931, 4, 9001, 4,
            intention = Intention.Serious, job = "معمار", verified = true, likesYou = true, activeRecently = true,
            about = "عاشق کوه و قهوهٔ تلخ. آخر هفته‌ها یا دماوندم یا یه کافهٔ کوچیک توی خیابون ولیعصر.",
            prompts = listOf(ProfilePrompt(1, "یه سفر بی‌برنامه به شمال"), ProfilePrompt(4, "صبحونهٔ مفصل جمعه")),
            fields = listOf(ProfileFieldValue(1, number = 168), ProfileFieldValue(2, option = 21)),
        ),
        card(
            "celif5ztr3wa2", "Elif", 25, Gender.Woman, 745044, 7, 9011, 3,
            intention = Intention.NotSure, job = "UX designer", likesYou = true,
            about = "Kadıköy'de yaşıyorum. Vapur, simit ve uzun yürüyüşler.",
            prompts = listOf(ProfilePrompt(2, "Bir pazar sabahı Moda sahilinde kahve")),
        ),
        card(
            "dolivia6nb4ks", "Olivia", 29, Gender.Woman, 2643743, 1, 9021, 2,
            intention = Intention.Friendship, job = "Data analyst", verified = true,
            about = "New in town, looking for people to explore markets with.",
        ),
        card(
            "emaximil7a2pq",
            "Maximiliana Alexandrovna Rosenthal-Villanueva",
            31, Gender.Woman, 323786, 128, 9031, 6,
            intention = Intention.Marriage,
            job = "Principal software engineer at a very long company name that wraps twice",
            about = "A deliberately long profile text to show how the card handles three lines and more. ".repeat(4).trim(),
            prompts = listOf(
                ProfilePrompt(1, "Two weeks with no plan and a rail pass"),
                ProfilePrompt(3, null, audioMs = 14_200, audioUrl = "https://media.example.com/a/9039/1.m4a"),
                ProfilePrompt(5, "Pineapple on pizza is fine, actually"),
            ),
            likesYou = true,
        ),
        card("fsara3xkd7lmq", "سارا", 24, Gender.Woman, 418863, 340, 9041, 2, intention = Intention.Serious),
        card("gzeynep4hq2wv", "Zeynep", 28, Gender.Woman, 311046, 12, 9051, 5, job = "Hekim", verified = true),
        card("hmahsa5lw6rtn", "مهسا", 30, Gender.Woman, 115019, 21, 9061, 3, intention = Intention.Marriage, activeRecently = true),
        card("iarash6pq3dfz", "آرش", 32, Gender.Man, 112931, 9, 9071, 3, job = "عکاس"),
        card("jemre7vb2ncxa", "Emre", 26, Gender.Man, 745044, 3, 9081, 2, likesYou = true),
        card("kalex2mn5kqrs", "Alex", 27, Gender.Nonbinary, 2643743, 5, 9091, 3, intention = Intention.NotSure),
        card("layse3rt6wpzu", "Ayşe", 23, Gender.Woman, 323786, 44, 9101, 2),
        card("mroya4gh7jkle", "رویا", 26, Gender.Woman, 124665, 6, 9111, 4, about = "", likesYou = true),
        // Further away: a deck within 50 km runs out, and widening the distance brings these in.
        card(
            "nnazanin5kq2a", "نازنین", 27, Gender.Woman, 112931, 9, 9121, 3,
            intention = Intention.Serious, job = "پزشک", verified = true,
            prompts = listOf(ProfilePrompt(2, "کتاب‌فروشی‌های انقلاب و یه چای داغ")),
            fields = listOf(ProfileFieldValue(1, number = 165), ProfileFieldValue(3, options = listOf(31, 33))),
        ),
        card("oleyla6mw3pzb", "Leyla", 29, Gender.Woman, 113646, 86, 9131, 3, intention = Intention.Serious, job = "Mimar"),
        card("pdeniz7xr4kqa", "Deniz", 25, Gender.Woman, 311046, 160, 9141, 2, intention = Intention.Friendship),
        card("qsepideh2nb5t", "سپیده", 31, Gender.Woman, 124665, 260, 9151, 3, intention = Intention.Marriage, likesYou = true),
    )

    fun person(id: String): ProfileCard? = people.firstOrNull { it.id == id }

    fun ownProfile(): OwnProfile = OwnProfile(
        id = ME,
        v = 7,
        name = "Sam",
        age = 29,
        gender = Gender.Man,
        verified = false,
        intention = Intention.Serious,
        job = "Product designer",
        about = "Coffee, cycling and old maps.",
        city = city(112931),
        photos = listOf(
            OwnPhoto("8001", 0, PhotoStatus.Approved, w = 1080, h = 1350, blurhash = blurhashes[0], url = "https://media.example.com/p/8001/1/640.webp"),
            OwnPhoto("8002", 1, PhotoStatus.Approved, w = 1080, h = 1350, blurhash = blurhashes[1], url = "https://media.example.com/p/8002/1/640.webp"),
            OwnPhoto("8003", 2, PhotoStatus.Rejected, rejectReason = "A face must be visible in the first photos.", w = 1080, h = 1350, blurhash = blurhashes[2]),
        ),
        textState = TextState.Approved,
        prompts = listOf(
            OwnPrompt(1, position = 0, answer = "A night train with a good book", status = TextState.Approved),
            OwnPrompt(4, position = 1, answer = "Sunday pancakes", status = TextState.Checking),
        ),
        fields = listOf(ProfileFieldValue(1, number = 181), ProfileFieldValue(2, option = 22), ProfileFieldValue(3, options = listOf(31, 33))),
        completeness = 78,
        birthDate = LocalDate.of(1996, 9, 14),
        settings = Settings(acceptCalls = true, template = "default"),
    )

    val preferences = DiscoveryPreferences(
        interestedIn = listOf(Gender.Woman),
        ageMin = 23,
        ageMax = 34,
        maxDistanceKm = 50,
        intents = listOf(Intention.Serious, Intention.Marriage),
    )

    private fun localized(locale: String, fa: String, en: String, tr: String) = when (locale) {
        "fa" -> fa
        "tr" -> tr
        else -> en
    }

    fun config(store: String, locale: String, version: Long): Config {
        fun t(fa: String, en: String, tr: String) = localized(locale, fa, en, tr)
        return Config(
            v = version,
            appName = AppBrand.appName,
            legal = LegalLinks(
                privacyUrl = AppBrand.Legal.privacyUrl,
                termsUrl = AppBrand.Legal.termsUrl,
                guidelinesUrl = AppBrand.Legal.guidelinesUrl,
                childSafetyUrl = AppBrand.Legal.guidelinesUrl,
                deleteAccountUrl = AppBrand.Legal.deleteAccountUrl,
                supportEmail = AppBrand.Legal.supportEmail,
            ),
            planNames = mapOf("plus" to t("پلاس", "Plus", "Plus"), "premium" to t("پریمیوم", "Premium", "Premium")),
            minVersion = MinVersion(required = 1, recommended = 1),
            auth = AuthOptions(
                otpLength = CODE.length,
                methods = if (store == "play") listOf(AuthMethod.Phone, AuthMethod.Google) else listOf(AuthMethod.Phone),
            ),
            catalog = Catalog(
                fields = listOf(
                    FieldDef(1, "height", t("قد", "Height", "Boy"), "number", min = 120, max = 230, unit = "cm"),
                    FieldDef(
                        2, "smoking", t("سیگار", "Smoking", "Sigara"), "single",
                        options = listOf(
                            FieldOption(21, t("نه", "No", "Hayır")),
                            FieldOption(22, t("گاهی", "Sometimes", "Bazen")),
                            FieldOption(23, t("بله", "Yes", "Evet")),
                        ),
                        filterable = true,
                    ),
                    FieldDef(
                        3, "languages", t("زبان‌ها", "Languages", "Diller"), "multi",
                        options = listOf(
                            FieldOption(31, t("فارسی", "Persian", "Farsça")),
                            FieldOption(32, t("ترکی", "Turkish", "Türkçe")),
                            FieldOption(33, t("انگلیسی", "English", "İngilizce")),
                        ),
                    ),
                    FieldDef(4, "religion", t("دین", "Religion", "Din"), "text", isPrivate = true, sensitive = true),
                ),
                prompts = listOf(
                    PromptDef(1, t("بهترین سفری که رفتم…", "The best trip I took…", "En iyi seyahatim…")),
                    PromptDef(2, t("یه روز عالی یعنی…", "A perfect day is…", "Mükemmel bir gün…")),
                    PromptDef(3, t("با صدای خودم بشنو…", "Hear it in my voice…", "Sesimden dinle…"), category = "voice"),
                    PromptDef(4, t("بهترین صبحونه…", "Best breakfast…", "En iyi kahvaltı…")),
                    PromptDef(5, t("نظر غیرمحبوب من…", "My unpopular opinion…", "Popüler olmayan fikrim…")),
                ),
                intentions = listOf(
                    CatalogEntry("serious", t("رابطهٔ جدی", "Something serious", "Ciddi bir ilişki")),
                    CatalogEntry("marriage", t("ازدواج", "Marriage", "Evlilik")),
                    CatalogEntry("friendship", t("دوستی", "Friendship", "Arkadaşlık")),
                    CatalogEntry("not_sure", t("هنوز مطمئن نیستم", "Not sure yet", "Henüz emin değilim")),
                ),
                reportReasons = listOf(
                    CatalogEntry("fake", t("پروفایل جعلی", "Fake profile", "Sahte profil")),
                    CatalogEntry("harassment", t("آزار", "Harassment", "Taciz")),
                    CatalogEntry("inappropriate", t("محتوای نامناسب", "Inappropriate content", "Uygunsuz içerik")),
                    CatalogEntry("scam", t("کلاهبرداری", "Scam", "Dolandırıcılık")),
                    CatalogEntry("under_18", t("زیر ۱۸ سال", "Under 18", "18 yaş altı")),
                    CatalogEntry("threat", t("تهدید", "Threat", "Tehdit")),
                    CatalogEntry("spam", t("هرزنامه", "Spam", "Spam")),
                    CatalogEntry("child_safety", t("ایمنی کودکان", "Child safety", "Çocuk güvenliği")),
                    CatalogEntry("other", t("دیگر", "Other", "Diğer")),
                ),
                deletionReasons = listOf(
                    CatalogEntry("found_someone", t("کسی را پیدا کردم", "I met someone", "Birini buldum")),
                    CatalogEntry("break", t("به استراحت نیاز دارم", "I need a break", "Ara vermek istiyorum")),
                    CatalogEntry("other", t("دیگر", "Other", "Diğer")),
                ),
            ),
            limits = Limits(messageMax = 2000),
            calls = CallSwitches(audio = true, video = true),
            ui = UiConfig.Default,
        )
    }

    fun subscriptions(store: String): List<SubscriptionProduct> =
        if (store == "play") {
            listOf(Plan.Plus, Plan.Premium).flatMapIndexed { tier, plan ->
                listOf("w1" to BillingPeriod.Week, "m1" to BillingPeriod.Month, "m3" to BillingPeriod.ThreeMonths, "m6" to BillingPeriod.SixMonths)
                    .mapIndexed { i, (base, period) ->
                        SubscriptionProduct("sub.${plan.wire}", base, plan, period, badge = if (base == "m3") "popular" else null, sort = tier * 10 + i)
                    }
            }
        } else {
            listOf(Plan.Plus, Plan.Premium).flatMapIndexed { tier, plan ->
                listOf("1m" to BillingPeriod.Month, "3m" to BillingPeriod.ThreeMonths, "6m" to BillingPeriod.SixMonths, "12m" to BillingPeriod.Year)
                    .mapIndexed { i, (suffix, period) ->
                        SubscriptionProduct("sub.${plan.wire}.$suffix", null, plan, period, badge = if (suffix == "3m") "popular" else null, sort = tier * 10 + i)
                    }
            }
        }

    val consumables: List<ConsumableProduct> = listOf(
        ConsumableProduct("cons.superlike.5", WalletItem.Superlike, 5, sort = 1),
        ConsumableProduct("cons.superlike.15", WalletItem.Superlike, 15, badge = "best_value", sort = 2),
        ConsumableProduct("cons.boost.1", WalletItem.Boost, 1, sort = 3),
        ConsumableProduct("cons.boost.5", WalletItem.Boost, 5, badge = "popular", sort = 4),
        ConsumableProduct("cons.spotlight.1", WalletItem.Spotlight, 1, badge = "new", sort = 5),
        ConsumableProduct("cons.dm.5", WalletItem.Dm, 5, sort = 6),
    )
}
