package app.core.feature.card

import app.core.model.Catalog
import app.core.model.FieldDef
import app.core.model.Photo
import app.core.model.ProfileCard
import app.core.model.ProfilePrompt

/** One block of the full profile page. */
sealed interface ProfileSection {
    val key: String

    data class PhotoBlock(val photo: Photo, val index: Int, val count: Int) : ProfileSection {
        override val key: String get() = "photo:${photo.id}"
    }

    /** Name, age, badge, intention, job, city and distance. */
    data object Header : ProfileSection {
        override val key: String get() = "header"
    }

    data class About(val text: String) : ProfileSection {
        override val key: String get() = "about"
    }

    data class PromptBlock(val prompt: ProfilePrompt, val question: String?) : ProfileSection {
        override val key: String get() = "prompt:${prompt.promptId}"
    }

    data class Fields(val lines: List<FieldLine>) : ProfileSection {
        override val key: String get() = "fields"
    }
}

/** A field as the page shows it: its label from the catalogue and the value in words. */
data class FieldLine(val fieldId: Int, val label: String, val value: String)

/**
 * The full profile as one continuous page, not a box of text: photos,
 * prompts and the fields interleaved, so every screenful has a face on it.
 *
 * Order: photo 1, the header, the about text, then prompt 1, photo 2, the
 * fields, prompt 2, photo 3, prompt 3, photo 4, and whatever photos are left.
 * A prompt with neither a text nor a voice answer, and a field the catalogue
 * no longer has, are left out.
 */
fun profileSections(card: ProfileCard, catalog: Catalog, number: (Int) -> String = Int::toString): List<ProfileSection> {
    val photos = card.photos
    val prompts = card.prompts.filter { !it.answer.isNullOrBlank() || it.audioUrl != null }
    val fields = fieldLines(card, catalog, number)
    val questions = catalog.prompts.associate { it.id to it.text }

    val out = ArrayList<ProfileSection>()
    fun photo(index: Int) {
        photos.getOrNull(index)?.let { out += ProfileSection.PhotoBlock(it, index, photos.size) }
    }

    photo(0)
    out += ProfileSection.Header
    card.about?.trim()?.takeIf { it.isNotEmpty() }?.let { out += ProfileSection.About(it) }

    var fieldsPlaced = fields.isEmpty()
    var photoIndex = 1
    for ((i, prompt) in prompts.withIndex()) {
        out += ProfileSection.PromptBlock(prompt, questions[prompt.promptId])
        photo(photoIndex++)
        if (i == 0 && !fieldsPlaced) {
            out += ProfileSection.Fields(fields)
            fieldsPlaced = true
        }
    }
    if (!fieldsPlaced) {
        // No prompts: the second photo, then the fields.
        photo(photoIndex++)
        out += ProfileSection.Fields(fields)
    }
    while (photoIndex < photos.size) photo(photoIndex++)
    return out
}

/** The card's answered fields in the catalogue's order, as label and value; [number] writes numbers in the reader's digits. */
fun fieldLines(card: ProfileCard, catalog: Catalog, number: (Int) -> String = Int::toString): List<FieldLine> {
    val defs = catalog.fields.associateBy { it.id }
    val order = catalog.fields.withIndex().associate { it.value.id to it.index }
    return card.fields
        .mapNotNull { value ->
            val def = defs[value.fieldId] ?: return@mapNotNull null
            if (def.isPrivate) return@mapNotNull null
            val text = fieldValue(def, value.option, value.options, value.number, value.text, number) ?: return@mapNotNull null
            FieldLine(def.id, def.label, text)
        }
        .sortedBy { order[it.fieldId] ?: Int.MAX_VALUE }
}

private fun fieldValue(def: FieldDef, option: Int?, options: List<Int>?, number: Int?, text: String?, format: (Int) -> String): String? {
    fun label(id: Int) = def.options.firstOrNull { it.id == id }?.label
    return when (def.kind) {
        "single" -> option?.let(::label)
        "multi" -> options?.mapNotNull(::label)?.takeIf { it.isNotEmpty() }?.joinToString(", ")
        "number" -> number?.let { n -> if (def.unit.isNullOrBlank()) format(n) else "${format(n)} ${def.unit}" }
        "text" -> text?.trim()?.takeIf { it.isNotEmpty() }
        else -> option?.let(::label) ?: number?.let(format) ?: text?.trim()?.takeIf { it.isNotEmpty() }
    }
}
