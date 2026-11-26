package app.core.feature.match

import app.core.model.Id
import app.core.model.OwnPhoto
import app.core.model.Photo
import app.core.model.PhotoStatus
import java.io.File

/**
 * A face on the match moment. [Remote] is a copy the server serves: approved,
 * or ([approved] false) still in review, or only a blurhash with a blank url
 * (nothing is fetched for it). [PhoneCopy] is the file this phone uploaded,
 * for a photo the server has no URL for yet.
 */
sealed interface MatchPhoto {
    val id: Id

    data class Remote(val photo: Photo, val approved: Boolean = true) : MatchPhoto {
        override val id: Id get() = photo.id
    }

    data class PhoneCopy(override val id: Id, val file: File) : MatchPhoto
}

/** An approved server copy: nothing better can come, so the account is not read again for it. */
val MatchPhoto?.isFinal: Boolean get() = this is MatchPhoto.Remote && approved

/**
 * The account's own face for the match moment, from [photos] in their order
 * (rejected ones never): the first approved one with a URL; else the first
 * with a URL (in review: the server serves those to the account itself);
 * else the first whose upload this phone still holds ([phoneCopy]); else the
 * first with a blurhash alone. Null when none of them has anything to draw.
 */
fun ownMatchPhoto(photos: List<OwnPhoto>, phoneCopy: (Id) -> File?): MatchPhoto? {
    val usable = photos
        .sortedBy { it.position }
        .filter { it.status != PhotoStatus.Rejected && it.status != PhotoStatus.Unknown }
    fun OwnPhoto.served(url: String) = Photo(id, w, h, blurhash, url)
    usable.firstOrNull { it.status == PhotoStatus.Approved && !it.url.isNullOrBlank() }
        ?.let { return MatchPhoto.Remote(it.served(it.url.orEmpty()), approved = true) }
    usable.firstOrNull { !it.url.isNullOrBlank() }
        ?.let { return MatchPhoto.Remote(it.served(it.url.orEmpty()), approved = false) }
    for (photo in usable) {
        phoneCopy(photo.id)?.let { return MatchPhoto.PhoneCopy(photo.id, it) }
    }
    usable.firstOrNull { it.blurhash.isNotEmpty() }
        ?.let { return MatchPhoto.Remote(it.served(""), approved = false) }
    return null
}
