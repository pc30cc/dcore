package app.core.feature.card

import app.core.model.Catalog
import app.core.model.FieldDef
import app.core.model.Intention
import app.core.model.Photo
import app.core.model.ProfileCard
import app.core.model.ProfilePrompt

/** One block of the full profile page, after its first screen (the photos, the name and the line). */
sealed interface ProfileSection {
    val key: String

    data class PhotoBlock(val photo: Photo, val index: Int, val count: Int) : ProfileSection {
        override val key: String get() = "photo:${photo.id}"
    }

    data class About(val text: String) : ProfileSection {
        override val key: String get() = "about"
    }

    /** A text answer (a pull quote) or a voice answer (the voice card). */
    data class PromptBlock(val prompt: ProfilePrompt, val question: String?) : ProfileSection {
        override val key: String get() = "prompt:${prompt.promptId}"
        val voice: Boolean get() = prompt.answer.isNullOrBlank() && prompt.audioUrl != null
    }

    /** The fact grid: the catalogue's public fields and what they look for. */
    data class Fields(val lines: List<FieldLine>, val intention: Intention?) : ProfileSection {
        override val key: String get() = "fields"
    }
}

/** A field as the page shows it: its label from the catalogue and the value in words. */
data class FieldLine(val fieldId: Int, val label: String, val value: String)

/**
 * The full profile after its first screen, as one continuous page: about,
 * the voice answers, the fact grid, then each text answer followed by one
 * more photo (photo 2 after the first answer, and so on), then whatever
 * photos are left. The first photo is the first screen's. A prompt with
 * neither a text nor a voice answer, and a field the catalogue no longer
 * has, are left out.
 */
fun profileSections(
    card: ProfileCard,
    catalog: Catalog,
    number: (Int) -> String = Int::toString,
    separator: String = ", ",
): List<ProfileSection> {
    val photos = card.photos
    val prompts = card.prompts.filter { !it.answer.isNullOrBlank() || it.audioUrl != null }
    val fields = fieldLines(card, catalog, number, separator)
    val questions = catalog.prompts.associate { it.id to it.text }
    val intention = card.intention?.takeIf { it != Intention.Unknown }

    val out = ArrayList<ProfileSection>()
    card.about?.trim()?.takeIf { it.isNotEmpty() }?.let { out += ProfileSection.About(it) }
    val blocks = prompts.map { ProfileSection.PromptBlock(it, questions[it.promptId]) }
    out += blocks.filter { it.voice }
    if (fields.isNotEmpty() || intention != null) out += ProfileSection.Fields(fields, intention)
    var photoIndex = 1
    for (block in blocks.filterNot { it.voice }) {
        out += block
        photos.getOrNull(photoIndex)?.let { out += ProfileSection.PhotoBlock(it, photoIndex, photos.size) }
        photoIndex++
    }
    while (photoIndex < photos.size) {
        out += ProfileSection.PhotoBlock(photos[photoIndex], photoIndex, photos.size)
        photoIndex++
    }
    return out
}

/** The card's answered fields in the catalogue's order, as label and value; [number] writes numbers in the reader's digits. */
fun fieldLines(card: ProfileCard, catalog: Catalog, number: (Int) -> String = Int::toString, separator: String = ", "): List<FieldLine> {
    val defs = catalog.fields.associateBy { it.id }
    val order = catalog.fields.withIndex().associate { it.value.id to it.index }
    return card.fields
        .mapNotNull { value ->
            val def = defs[value.fieldId] ?: return@mapNotNull null
            if (def.isPrivate) return@mapNotNull null
            val text = fieldValue(def, value.option, value.options, value.number, value.text, number, separator) ?: return@mapNotNull null
            FieldLine(def.id, def.label, text)
        }
        .sortedBy { order[it.fieldId] ?: Int.MAX_VALUE }
}

private fun fieldValue(def: FieldDef, option: Int?, options: List<Int>?, number: Int?, text: String?, format: (Int) -> String, separator: String): String? {
    fun label(id: Int) = def.options.firstOrNull { it.id == id }?.label
    return when (def.kind) {
        "single" -> option?.let(::label)
        "multi" -> options?.mapNotNull(::label)?.takeIf { it.isNotEmpty() }?.joinToString(separator)
        "number" -> number?.let { n -> if (def.unit.isNullOrBlank()) format(n) else "${format(n)} ${def.unit}" }
        "text" -> text?.trim()?.takeIf { it.isNotEmpty() }
        else -> option?.let(::label) ?: number?.let(format) ?: text?.trim()?.takeIf { it.isNotEmpty() }
    }
}
