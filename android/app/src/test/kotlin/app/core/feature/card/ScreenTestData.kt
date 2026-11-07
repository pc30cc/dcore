package app.core.feature.card

import app.core.model.Catalog
import app.core.model.CatalogEntry
import app.core.model.City
import app.core.model.Distance
import app.core.model.FieldDef
import app.core.model.FieldOption
import app.core.model.Gender
import app.core.model.Intention
import app.core.model.Photo
import app.core.model.ProfileCard
import app.core.model.ProfileFieldValue
import app.core.model.ProfilePrompt
import app.core.model.PromptDef

/** Cards and a catalogue for the screen tests: no server, no network. */
object ScreenTestData {

    val catalog = Catalog(
        fields = listOf(
            FieldDef(1, "height", "Height", "number", min = 120, max = 230, unit = "cm"),
            FieldDef(2, "smoking", "Smoking", "single", options = listOf(FieldOption(21, "No"), FieldOption(22, "Sometimes"))),
            FieldDef(3, "languages", "Languages", "multi", options = listOf(FieldOption(31, "Persian"), FieldOption(33, "English"))),
            FieldDef(4, "religion", "Religion", "text", isPrivate = true),
        ),
        prompts = listOf(
            PromptDef(1, "The best trip I took…"),
            PromptDef(2, "A perfect day is…"),
            PromptDef(3, "Hear it in my voice…", category = "voice"),
        ),
        intentions = listOf(CatalogEntry("serious", "Something serious")),
    )

    fun photo(id: Long) = Photo(id = id.toString(), w = 1080, h = 1350, blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url = "https://media.test/p/$id/1/640.webp")

    val negar = ProfileCard(
        id = "bnegar2kq7xm4",
        v = 3,
        name = "Negar",
        age = 27,
        gender = Gender.Woman,
        verified = true,
        intention = Intention.Serious,
        job = "Architect",
        about = "Mountains and bitter coffee.",
        city = City(112931, "Tehran", "IR"),
        distance = Distance(4),
        activeRecently = true,
        likesYou = true,
        photos = (9001L..9004L).map(::photo),
        prompts = listOf(ProfilePrompt(1, "A trip north with no plan"), ProfilePrompt(2, "A long Friday breakfast")),
        fields = listOf(ProfileFieldValue(1, number = 168), ProfileFieldValue(2, option = 21), ProfileFieldValue(4, text = "hidden")),
    )

    val elif = ProfileCard(
        id = "celif5ztr3wa2",
        v = 1,
        name = "Elif",
        age = 25,
        gender = Gender.Woman,
        city = City(745044, "İstanbul", "TR"),
        distance = Distance(2, lessThan = true),
        photos = listOf(photo(9011), photo(9012)),
    )

    val olivia = ProfileCard(id = "dolivia6nb4ks", v = 1, name = "Olivia", age = 29, photos = listOf(photo(9021)))
}
